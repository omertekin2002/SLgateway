// HTTP behavior adapted from SignLoop apps/web/app/api/chat/route.ts.
// Source commit: 5d06ed2630386c4a9af78373ce998d31dbc1f776

import { randomUUID } from "node:crypto";

import {
  InferenceSemaphore,
  hasValidServiceAuthorization,
  type ReleaseSlot,
} from "./auth";
import {
  getServiceConfig,
  type ServiceConfig,
} from "./config";
import {
  buildChatPromptMessages,
  generateChatReply,
  generateChatReplyStream,
  type ChatMessage,
  type ChatReply,
  type ChatReplyStreamChunk,
} from "./pipeline/chat";
import {
  MAX_CHAT_REQUEST_BODY_BYTES,
  parseBoundedJsonRequest,
  parseClientChatMessages,
} from "./pipeline/chat-policy";
import { GeminiWebSearchError } from "./pipeline/gemini-search";
import type { ProviderConfig } from "./pipeline/llm-client";
import {
  DEFAULT_PERSONALITY_MODE,
  isAllowedPersonalityMode,
  type PersonalityMode,
} from "./pipeline/personality";
import {
  DEFAULT_CHAT_ERROR_MESSAGE,
  appendWebSourcesToMessage,
} from "./prompts";
import { isRecord } from "./utils";

const SERVICE_NAME = "signloop-chat-service";
const STREAM_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const STREAM_ENDED_ERROR = "Chat stream ended before completion.";
const TIMEOUT_ERROR = "Chat request timed out. Please try again.";

export type PipelineRequestOptions = Readonly<{
  signal: AbortSignal;
  requestId: string;
}>;

export type ChatPipeline = Readonly<{
  generate: (
    messages: readonly ChatMessage[],
    options: PipelineRequestOptions,
  ) => Promise<ChatReply>;
  stream: (
    messages: readonly ChatMessage[],
    options: PipelineRequestOptions,
  ) => AsyncIterable<ChatReplyStreamChunk>;
}>;

export type StructuredLogEntry = Readonly<Record<string, unknown>>;
export type StructuredLogSink = (entry: StructuredLogEntry) => void;

export type RequestHandlerOptions = Readonly<{
  config: ServiceConfig;
  pipeline?: ChatPipeline;
  semaphore?: InferenceSemaphore;
  log?: StructuredLogSink;
  requestIdFactory?: () => string;
}>;

type RequestLogContext = {
  requestId: string;
  route: string;
  startedAt: number;
  streaming?: boolean;
  personality?: PersonalityMode;
  messageCount?: number;
  totalMessageCharacters?: number;
};

type ExecutionScope = {
  readonly signal: AbortSignal;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  cancel(reason?: unknown): void;
  cleanup(): void;
};

function defaultLog(entry: StructuredLogEntry): void {
  console.log(JSON.stringify(entry));
}

function safeErrorClass(error: unknown): string {
  const candidate =
    error instanceof Error ? error.name || error.constructor.name : typeof error;
  return /^[A-Za-z0-9_.-]{1,100}$/.test(candidate) ? candidate : "Error";
}

function normalizeRequestId(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return /^[A-Za-z0-9._:-]{1,128}$/.test(trimmed) ? trimmed : null;
}

function requestPath(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "/";
  }
}

function createExecutionScope(
  requestSignal: AbortSignal,
  timeoutMs: number,
): ExecutionScope {
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;

  const onRequestAbort = () => {
    cancelled = true;
    controller.abort(requestSignal.reason);
  };

  if (requestSignal.aborted) {
    onRequestAbort();
  } else {
    requestSignal.addEventListener("abort", onRequestAbort, { once: true });
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Service request timed out", "TimeoutError"));
  }, timeoutMs);

  return {
    get signal() {
      return controller.signal;
    },
    get timedOut() {
      return timedOut;
    },
    get cancelled() {
      return cancelled;
    },
    cancel(reason?: unknown) {
      cancelled = true;
      controller.abort(reason);
    },
    cleanup() {
      clearTimeout(timeout);
      requestSignal.removeEventListener("abort", onRequestAbort);
    },
  };
}

function abortError(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException("The operation was aborted", "AbortError")
  );
}

/** Stop awaiting promptly even if an injected/upstream operation is slow to observe its signal. */
function waitWithAbort<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortError(signal)));
    signal.addEventListener("abort", onAbort, { once: true });

    Promise.resolve(operation).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function toProviderConfig(config: ServiceConfig): ProviderConfig {
  return {
    ...(config.primaryLlm
      ? {
          primary: {
            baseURL: config.primaryLlm.baseUrl,
            apiKey: config.primaryLlm.apiKey,
            model: config.primaryLlm.model,
          },
        }
      : {}),
    ...(config.openRouter
      ? {
          openRouter: {
            baseURL: config.openRouter.baseUrl,
            apiKey: config.openRouter.apiKey,
            models: config.openRouter.models,
          },
        }
      : {}),
    publicServiceUrl: config.publicServiceUrl,
    appName: config.appName,
    timeoutMs: config.requestTimeoutMs,
  };
}

function createConfiguredPipeline(
  config: ServiceConfig,
  log: StructuredLogSink,
): ChatPipeline {
  const providerConfig = toProviderConfig(config);
  const optionsFor = (options: PipelineRequestOptions) => ({
    providerConfig,
    geminiSearch: {
      apiKey: config.geminiApiKey,
      model: config.geminiSearchModel,
    },
    signal: options.signal,
    dependencies: {
      // Pipeline warnings contain only fixed event text and whitelisted model metadata. Upstream
      // bodies, URLs, credentials, and prompts are deliberately discarded at this boundary.
      logger: {
        warn(message: unknown, details?: unknown) {
          const metadata = isRecord(details) ? details : {};
          const models = [
            metadata.model,
            metadata.firstFallbackModel,
            metadata.successfulFallbackModel,
          ].filter((value): value is string => typeof value === "string");
          log({
            level: "warn",
            event: "provider_fallback",
            requestId: options.requestId,
            note: typeof message === "string" ? message : "Provider fallback",
            ...(models.length ? { models } : {}),
          });
        },
      },
    },
  });

  return {
    generate: (messages, options) =>
      generateChatReply(messages, optionsFor(options)),
    stream: (messages, options) =>
      generateChatReplyStream(messages, optionsFor(options)),
  };
}

function corsHeaders(
  request: Request,
  config: ServiceConfig,
): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin || !config.corsAllowedOrigins.has(origin)) return {};

  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
  };
}

function responseHeaders(
  request: Request,
  config: ServiceConfig,
  requestId: string,
  contentType = JSON_CONTENT_TYPE,
): Headers {
  return new Headers({
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Request-ID": requestId,
    ...corsHeaders(request, config),
  });
}

function jsonResponse(
  request: Request,
  config: ServiceConfig,
  requestId: string,
  body: unknown,
  status: number,
  extraHeaders?: Readonly<Record<string, string>>,
): Response {
  const headers = responseHeaders(request, config, requestId);
  for (const [name, value] of Object.entries(extraHeaders ?? {})) {
    headers.set(name, value);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function ndjsonEvent(event: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

function canonicalMessage(reply: ChatReply): string {
  return appendWebSourcesToMessage(
    reply.message,
    reply.webSearch?.sources ?? [],
  );
}

function replyMetadata(reply: ChatReply): Record<string, unknown> {
  return {
    provider: reply.provider,
    model: reply.model,
    webSearchQuery: reply.webSearch?.query ?? null,
    webSearchAttempts: reply.webSearch?.attemptedQueries ?? [],
    webSearchSuccessfulCount: reply.webSearch?.successfulSearches ?? 0,
    webSources: reply.webSearch?.sources ?? [],
  };
}

function publicPipelineError(
  error: unknown,
  scope: ExecutionScope,
): { status: 502 | 504; message: string } {
  if (scope.timedOut) {
    return { status: 504, message: TIMEOUT_ERROR };
  }
  if (error instanceof GeminiWebSearchError) {
    return { status: 502, message: error.publicMessage };
  }
  return { status: 502, message: DEFAULT_CHAT_ERROR_MESSAGE };
}

function isJsonContentType(request: Request): boolean {
  return (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/json"
  );
}

function declaredBodyTooLarge(request: Request): boolean {
  const raw = request.headers.get("content-length");
  if (!raw || !/^\d+$/.test(raw.trim())) return false;
  const length = Number(raw);
  return Number.isFinite(length) && length > MAX_CHAT_REQUEST_BODY_BYTES;
}

function parsePersonality(
  body: Record<string, unknown>,
): PersonalityMode | null {
  if (body.personality === undefined) return DEFAULT_PERSONALITY_MODE;
  return typeof body.personality === "string" &&
    isAllowedPersonalityMode(body.personality)
    ? body.personality
    : null;
}

function parseStreaming(body: Record<string, unknown>): boolean | null {
  if (body.stream === undefined) return true;
  return typeof body.stream === "boolean" ? body.stream : null;
}

function hasClientProviderSelection(body: Record<string, unknown>): boolean {
  return ["model", "primaryModel", "provider", "providerUrl", "baseURL"].some(
    (key) => Object.prototype.hasOwnProperty.call(body, key),
  );
}

export function createRequestHandler(
  options: RequestHandlerOptions,
): (request: Request) => Promise<Response> {
  const { config } = options;
  const semaphore =
    options.semaphore ?? new InferenceSemaphore(config.maxConcurrentRequests);
  const configuredLog = options.log ?? defaultLog;
  const log: StructuredLogSink = (entry) => {
    try {
      configuredLog(entry);
    } catch {
      // Logging must never change an HTTP result or retain an inference slot.
    }
  };
  const pipeline = options.pipeline ?? createConfiguredPipeline(config, log);
  const requestIdFactory = options.requestIdFactory ?? randomUUID;

  return async function requestHandler(request: Request): Promise<Response> {
    const path = requestPath(request);
    const requestId =
      normalizeRequestId(request.headers.get("x-request-id")) ??
      requestIdFactory();
    const context: RequestLogContext = {
      requestId,
      route: path,
      startedAt: Date.now(),
    };
    let logged = false;

    const finishLog = (
      status: number,
      extra: Record<string, unknown> = {},
    ): void => {
      if (logged) return;
      logged = true;
      log({
        requestId: context.requestId,
        route: context.route,
        status,
        durationMs: Math.max(0, Date.now() - context.startedAt),
        ...(context.streaming !== undefined
          ? { streaming: context.streaming }
          : {}),
        ...(context.personality ? { personality: context.personality } : {}),
        ...(context.messageCount !== undefined
          ? { messageCount: context.messageCount }
          : {}),
        ...(context.totalMessageCharacters !== undefined
          ? { totalMessageCharacters: context.totalMessageCharacters }
          : {}),
        ...extra,
      });
    };

    const respond = (
      body: unknown,
      status: number,
      extraHeaders?: Readonly<Record<string, string>>,
      logExtra?: Record<string, unknown>,
    ): Response => {
      finishLog(status, logExtra);
      return jsonResponse(
        request,
        config,
        requestId,
        body,
        status,
        extraHeaders,
      );
    };

    if (request.method === "GET" && path === "/healthz") {
      return respond({ ok: true, service: SERVICE_NAME }, 200);
    }

    if (request.method === "OPTIONS" && path === "/v1/chat") {
      const origin = request.headers.get("origin");
      if (!origin || !config.corsAllowedOrigins.has(origin)) {
        return respond({ error: "Not found" }, 404);
      }

      const headers = responseHeaders(request, config, requestId);
      headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      headers.set(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, X-Request-ID",
      );
      headers.set("Access-Control-Max-Age", "600");
      finishLog(204);
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== "POST" || path !== "/v1/chat") {
      return respond({ error: "Not found" }, 404);
    }

    if (!hasValidServiceAuthorization(request, config.serviceApiKey)) {
      return respond(
        { error: "Unauthorized" },
        401,
        { "WWW-Authenticate": "Bearer" },
        { errorClass: "AuthenticationError" },
      );
    }

    const release = semaphore.tryAcquire();
    if (!release) {
      return respond(
        { error: "Too many concurrent chat requests. Please retry shortly." },
        429,
        { "Retry-After": "1" },
        { errorClass: "ConcurrencyLimitError" },
      );
    }

    const scope = createExecutionScope(request.signal, config.requestTimeoutMs);
    let streamOwnsResources = false;

    try {
      if (!isJsonContentType(request)) {
        return respond(
          { error: "Content-Type must be application/json." },
          415,
        );
      }

      if (declaredBodyTooLarge(request)) {
        return respond({ error: "Chat request body is too large." }, 413);
      }

      const parsedBody = await parseBoundedJsonRequest<unknown>(
        request,
        MAX_CHAT_REQUEST_BODY_BYTES,
        scope.signal,
      );
      if (scope.timedOut) {
        return respond(
          { error: TIMEOUT_ERROR },
          504,
          undefined,
          { errorClass: "TimeoutError" },
        );
      }
      if (!parsedBody.ok) {
        return respond(
          { error: parsedBody.error },
          parsedBody.status,
        );
      }

      const parsedMessages = parseClientChatMessages(parsedBody.value);
      if (!parsedMessages.ok) {
        return respond(
          { error: parsedMessages.error },
          parsedMessages.status,
        );
      }
      if (!isRecord(parsedBody.value)) {
        return respond({ error: "Request body must be an object." }, 400);
      }
      const body = parsedBody.value;
      if (hasClientProviderSelection(body)) {
        return respond(
          { error: "The model and provider are controlled by the service." },
          400,
        );
      }

      const personality = parsePersonality(body);
      if (!personality) {
        return respond({ error: "Invalid personality." }, 400);
      }
      const streaming = parseStreaming(body);
      if (streaming === null) {
        return respond({ error: "stream must be a boolean." }, 400);
      }

      context.personality = personality;
      context.streaming = streaming;
      context.messageCount = parsedMessages.messages.length;
      context.totalMessageCharacters = parsedMessages.messages.reduce(
        (total, message) => total + message.content.length,
        0,
      );

      const promptMessages = buildChatPromptMessages(
        parsedMessages.messages,
        personality,
      );
      const pipelineOptions: PipelineRequestOptions = {
        signal: scope.signal,
        requestId,
      };

      if (!streaming) {
        let reply: ChatReply;
        try {
          reply = await waitWithAbort(
            pipeline.generate(promptMessages, pipelineOptions),
            scope.signal,
          );
        } catch (error) {
          const publicError = publicPipelineError(error, scope);
          return respond(
            { error: publicError.message },
            publicError.status,
            undefined,
            { errorClass: safeErrorClass(error) },
          );
        }
        if (scope.timedOut) {
          return respond(
            { error: TIMEOUT_ERROR },
            504,
            undefined,
            { errorClass: "TimeoutError" },
          );
        }

        const message = canonicalMessage(reply);
        return respond(
          { message, ...replyMetadata(reply) },
          200,
          undefined,
          { provider: reply.provider, model: reply.model },
        );
      }

      const headers = responseHeaders(
        request,
        config,
        requestId,
        STREAM_CONTENT_TYPE,
      );
      headers.set("Cache-Control", "no-cache, no-transform");
      headers.set("X-Accel-Buffering", "no");

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          let terminalEventSent = false;
          let provider: ChatReply["provider"] | undefined;
          let model: string | undefined;
          let streamError: unknown;
          let iterator: AsyncIterator<ChatReplyStreamChunk> | undefined;

          try {
            iterator = pipeline
              .stream(promptMessages, pipelineOptions)
              [Symbol.asyncIterator]();
            for (;;) {
              const result = await waitWithAbort(
                iterator.next(),
                scope.signal,
              );
              if (result.done) break;
              const chunk = result.value;

              if (scope.timedOut) {
                throw scope.signal.reason ?? new Error("Request timed out");
              }
              if (scope.cancelled && !scope.timedOut) return;

              if (chunk.type === "delta") {
                controller.enqueue(
                  ndjsonEvent({ type: "delta", text: chunk.text }),
                );
                continue;
              }

              const message = canonicalMessage(chunk.reply);
              provider = chunk.reply.provider;
              model = chunk.reply.model;
              controller.enqueue(
                ndjsonEvent({
                  type: "done",
                  message,
                  ...replyMetadata(chunk.reply),
                }),
              );
              terminalEventSent = true;
              break;
            }

            if (!terminalEventSent && !scope.cancelled) {
              const message = scope.timedOut ? TIMEOUT_ERROR : STREAM_ENDED_ERROR;
              controller.enqueue(ndjsonEvent({ type: "error", error: message }));
              terminalEventSent = true;
            }
          } catch (error) {
            streamError = error;
            if (scope.cancelled && !scope.timedOut) return;

            const publicError = publicPipelineError(error, scope);
            controller.enqueue(
              ndjsonEvent({ type: "error", error: publicError.message }),
            );
            terminalEventSent = true;
          } finally {
            if (typeof iterator?.return === "function") {
              try {
                void Promise.resolve(iterator.return()).catch(() => {});
              } catch {
                // A broken iterator must not prevent resource release.
              }
            }
            try {
              controller.close();
            } catch {
              // The consumer may already have cancelled the stream.
            }
            scope.cleanup();
            release();
            finishLog(200, {
              ...(provider ? { provider } : {}),
              ...(model ? { model } : {}),
              ...(!terminalEventSent ? { streamOutcome: "cancelled" } : {}),
              ...(streamError
                ? { errorClass: safeErrorClass(streamError) }
                : {}),
            });
          }
        },
        cancel(reason) {
          scope.cancel(reason);
        },
      });

      streamOwnsResources = true;
      return new Response(stream, { status: 200, headers });
    } catch (error) {
      return respond(
        { error: DEFAULT_CHAT_ERROR_MESSAGE },
        500,
        undefined,
        { errorClass: safeErrorClass(error) },
      );
    } finally {
      if (!streamOwnsResources) {
        scope.cleanup();
        release();
      }
    }
  };
}

let defaultHandler: ((request: Request) => Promise<Response>) | undefined;

/** Production entry point. `server.ts` validates and caches configuration before binding. */
export async function handleRequest(request: Request): Promise<Response> {
  defaultHandler ??= createRequestHandler({ config: getServiceConfig() });
  return defaultHandler(request);
}
