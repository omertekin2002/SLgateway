import OpenAI from "openai";

import {
  BARE_LLM_SYSTEM_PROMPT,
  CHAT_SYSTEM_PROMPT,
} from "../prompts";
import { buildAuthoritativeUtcTimeContext } from "./chat-time";
import {
  prepareMessagesWithGeminiWebSearch,
  type WebSearchMetadata,
} from "./gemini-search";
import {
  type PersonalityMode,
} from "./personality";
import {
  OPENROUTER_MODELS,
  createOpenAiCompatibleClient,
  extractResponseOutputText,
  type FetchImplementation,
  type LlmFallbackLogger,
  type LlmProvider,
  type OpenAiCompatibleClientFactory,
  type OpenAiCompatibleClientOptions,
  type ProviderConfig,
  resolvePrimaryModel,
  runWithPrimaryAndOpenRouterFallback,
  validateProviderBaseUrl,
} from "./llm-client";

// Adapted from SignLoop apps/web/lib/chat.ts.
// Source commit: 5d06ed2630386c4a9af78373ce998d31dbc1f776
// Provider/search configuration and network dependencies are explicit for this stateless service.

export const MAX_CHAT_OUTPUT_TOKENS = 4_096;

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ChatReply = {
  /** Raw model output. The HTTP layer attaches missing source links canonically. */
  message: string;
  provider: LlmProvider;
  model: string;
  webSearch: WebSearchMetadata | null;
};

export type ChatReplyStreamChunk =
  | {
      type: "delta";
      text: string;
    }
  | {
      type: "done";
      reply: ChatReply;
    };

export type GeminiSearchConfig = {
  readonly apiKey: string;
  readonly model?: string;
  readonly timeoutMs?: number;
};

type PrepareWebSearch = typeof prepareMessagesWithGeminiWebSearch;

export type ChatDependencies = {
  readonly createClient?: OpenAiCompatibleClientFactory;
  readonly fetch?: FetchImplementation;
  readonly prepareWebSearch?: PrepareWebSearch;
  readonly now?: () => Date;
  readonly logger?: LlmFallbackLogger;
};

export type ChatGenerationOptions = {
  readonly providerConfig: ProviderConfig;
  readonly geminiSearch?: GeminiSearchConfig;
  readonly signal?: AbortSignal;
  /** Search is a service invariant and defaults to true. Tests/internal callers may disable it. */
  readonly enableWebSearch?: boolean;
  readonly dependencies?: ChatDependencies;
};

type ChatRequestOptions = { signal?: AbortSignal };

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === "string" && error ? error : "Unknown error";
}

function getErrorClass(error: unknown): string {
  return error instanceof Error ? error.name || "Error" : typeof error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "APIUserAbortError")
  );
}

/** Prepends the server-owned system prompt selected by a validated personality. */
export function buildChatPromptMessages(
  messages: readonly ChatMessage[],
  personality: PersonalityMode,
): ChatMessage[] {
  const systemPrompt =
    personality === "bare-llm"
      ? BARE_LLM_SYSTEM_PROMPT
      : CHAT_SYSTEM_PROMPT;

  return [
    { role: "system", content: systemPrompt },
    ...messages.map((message) => ({ ...message })),
  ];
}

function toResponseInput(messages: readonly ChatMessage[]) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

function extractResponseFailureMessage(
  response: OpenAI.Responses.Response,
): string | null {
  const error = response.error;
  if (error?.message) {
    return error.message;
  }

  if (response.status === "incomplete" && response.incomplete_details?.reason) {
    return `Incomplete response: ${response.incomplete_details.reason}`;
  }

  if (response.status === "failed") {
    return "AI response failed";
  }

  return null;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractProviderErrorMessage(status: number, body: string): string {
  const payload = parseJsonRecord(body);
  const error = isRecord(payload?.error) ? payload.error : null;
  const message =
    typeof error?.message === "string"
      ? error.message
      : typeof payload?.message === "string"
        ? payload.message
        : body.trim();

  return `${status} ${message || "OpenRouter request failed"}`.slice(0, 1_200);
}

function extractSseDataPayload(block: string): string | null {
  const dataLines: string[] = [];

  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;

    const separatorIndex = line.indexOf(":");
    const field = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
    const rawValue = separatorIndex >= 0 ? line.slice(separatorIndex + 1) : "";
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    if (field === "data") dataLines.push(value);
  }

  return dataLines.length ? dataLines.join("\n") : null;
}

async function* readSseDataPayloads(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: !done });
        buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      }
      if (done) {
        buffer += decoder.decode();
        buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      }

      let separatorIndex = buffer.indexOf("\n\n");
      while (separatorIndex >= 0) {
        const block = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const payload = extractSseDataPayload(block);
        if (payload) yield payload;
        separatorIndex = buffer.indexOf("\n\n");
      }

      if (done) {
        const trailingPayload = extractSseDataPayload(buffer);
        if (trailingPayload) yield trailingPayload;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function resolveStreamedContent(input: {
  completedResponse: OpenAI.Responses.Response | null;
  finalizedText: string | null;
  chunks: string[];
  sawTerminalEvent: boolean;
}): string {
  if (!input.sawTerminalEvent) {
    throw new Error("AI response stream ended before completion");
  }

  const completedText = input.completedResponse
    ? extractResponseOutputText(input.completedResponse)
    : null;
  const finalizedOutputText = input.finalizedText?.trim();
  const streamedText = input.chunks.join("").trim();
  const content = completedText ?? (finalizedOutputText || null) ?? streamedText;

  if (!content) {
    throw new Error("Empty response from AI");
  }
  return content;
}

function requestOptions(signal?: AbortSignal): ChatRequestOptions | undefined {
  return signal ? { signal } : undefined;
}

function clientOptions(
  config: ProviderConfig,
  fetchImplementation?: FetchImplementation,
): OpenAiCompatibleClientOptions {
  return {
    timeoutMs: config.timeoutMs,
    publicServiceUrl: config.publicServiceUrl,
    appName: config.appName,
    ...(fetchImplementation ? { fetch: fetchImplementation } : {}),
  };
}

async function runChatWithResponsesModel(
  openai: OpenAI,
  model: string,
  messages: readonly ChatMessage[],
  options?: ChatRequestOptions,
): Promise<string> {
  const response = await openai.responses.create(
    {
      model,
      input: toResponseInput(messages),
      max_output_tokens: MAX_CHAT_OUTPUT_TOKENS,
    },
    options,
  );

  const content = extractResponseOutputText(response);
  if (!content) throw new Error("Empty response from AI");
  return content;
}

export async function prepareChatMessages(
  messages: readonly ChatMessage[],
  options: Pick<
    ChatGenerationOptions,
    "dependencies" | "enableWebSearch" | "geminiSearch" | "signal"
  >,
): Promise<{
  messages: readonly ChatMessage[];
  webSearch: WebSearchMetadata | null;
}> {
  const dependencies = options.dependencies;
  const currentTime = dependencies?.now?.() ?? new Date();
  const preparedMessages = messages.map((message) => ({ ...message }));
  const timeContext = buildAuthoritativeUtcTimeContext(currentTime);
  const systemIndex = preparedMessages.findIndex(
    (message) => message.role === "system",
  );

  if (systemIndex >= 0) {
    const systemMessage = preparedMessages[systemIndex]!;
    preparedMessages[systemIndex] = {
      ...systemMessage,
      content: `${systemMessage.content.trim()}\n\n${timeContext}`,
    };
  } else {
    preparedMessages.unshift({ role: "system", content: timeContext });
  }

  if (options.enableWebSearch === false) {
    return { messages: preparedMessages, webSearch: null };
  }

  if (!options.geminiSearch?.apiKey.trim()) {
    throw new Error(
      "Gemini web search is not configured. A GEMINI_API_KEY is required.",
    );
  }

  const prepareWebSearch =
    dependencies?.prepareWebSearch ?? prepareMessagesWithGeminiWebSearch;
  const prepared = await prepareWebSearch(preparedMessages, {
    apiKey: options.geminiSearch.apiKey,
    ...(options.geminiSearch.model
      ? { model: options.geminiSearch.model }
      : {}),
    ...(options.geminiSearch.timeoutMs !== undefined
      ? { timeoutMs: options.geminiSearch.timeoutMs }
      : {}),
    ...(dependencies?.fetch ? { fetch: dependencies.fetch } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    currentTime,
  });

  return {
    messages: prepared.messages,
    webSearch: prepared.webSearch,
  };
}

export async function generateChatReply(
  messages: readonly ChatMessage[],
  options: ChatGenerationOptions,
): Promise<ChatReply> {
  if (!messages.length) {
    throw new Error("No chat messages were provided");
  }

  // Preparation occurs outside the fallback loop: grounded evidence is searched once,
  // reused verbatim by every model, and a search failure prevents generation entirely.
  const prepared = await prepareChatMessages(messages, options);
  const dependencies = options.dependencies;
  const { result, provider, model } =
    await runWithPrimaryAndOpenRouterFallback(
      options.providerConfig,
      (client, runModel) =>
        runChatWithResponsesModel(
          client,
          runModel,
          prepared.messages,
          requestOptions(options.signal),
        ),
      {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(dependencies?.createClient
          ? { createClient: dependencies.createClient }
          : {}),
        ...(dependencies?.fetch ? { fetch: dependencies.fetch } : {}),
        ...(dependencies?.logger ? { logger: dependencies.logger } : {}),
      },
    );

  return {
    message: result,
    provider,
    model,
    webSearch: prepared.webSearch,
  };
}

async function* runPrimaryResponsesModelStream(
  openai: OpenAI,
  model: string,
  messages: readonly ChatMessage[],
  options?: ChatRequestOptions,
  onDelta?: () => void,
): AsyncGenerator<ChatReplyStreamChunk, string, void> {
  const stream = await openai.responses.create(
    {
      model,
      input: toResponseInput(messages),
      max_output_tokens: MAX_CHAT_OUTPUT_TOKENS,
      stream: true,
    },
    options,
  );

  const chunks: string[] = [];
  let completedResponse: OpenAI.Responses.Response | null = null;
  let finalizedText: string | null = null;
  let sawTerminalEvent = false;

  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (delta) {
        chunks.push(delta);
        onDelta?.();
        yield { type: "delta", text: delta };
      }
      continue;
    }

    if (event.type === "response.output_text.done") {
      sawTerminalEvent = true;
      finalizedText = typeof event.text === "string" ? event.text : null;
      continue;
    }

    if (event.type === "response.completed") {
      sawTerminalEvent = true;
      completedResponse = event.response;
      continue;
    }

    if (
      event.type === "response.failed" ||
      event.type === "response.incomplete"
    ) {
      throw new Error(
        extractResponseFailureMessage(event.response) ?? "AI response failed",
      );
    }

    if (event.type === "error") {
      const message =
        typeof event.message === "string"
          ? event.message
          : "AI response stream failed";
      throw new Error(message);
    }
  }

  return resolveStreamedContent({
    completedResponse,
    finalizedText,
    chunks,
    sawTerminalEvent,
  });
}

function openRouterResponsesUrl(baseURL: string): string {
  return `${validateProviderBaseUrl(baseURL).replace(/\/+$/, "")}/responses`;
}

async function* runOpenRouterResponsesModelStream(
  config: ProviderConfig,
  model: string,
  messages: readonly ChatMessage[],
  fetchImplementation: FetchImplementation,
  options?: ChatRequestOptions,
  onDelta?: () => void,
): AsyncGenerator<ChatReplyStreamChunk, string, void> {
  const openRouter = config.openRouter;
  if (!openRouter?.apiKey.trim()) {
    throw new Error("OpenRouter fallback is not configured");
  }

  const response = await fetchImplementation(
    openRouterResponsesUrl(openRouter.baseURL),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openRouter.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": config.publicServiceUrl,
        "X-Title": config.appName,
      },
      body: JSON.stringify({
        model,
        input: toResponseInput(messages),
        max_output_tokens: MAX_CHAT_OUTPUT_TOKENS,
        stream: true,
      }),
      signal: options?.signal,
    },
  );

  if (!response.ok) {
    throw new Error(
      extractProviderErrorMessage(response.status, await response.text()),
    );
  }
  if (!response.body) {
    throw new Error("OpenRouter response stream was empty");
  }

  const chunks: string[] = [];
  let completedResponse: OpenAI.Responses.Response | null = null;
  let finalizedText: string | null = null;
  let sawTerminalEvent = false;

  for await (const payload of readSseDataPayloads(response.body)) {
    if (payload === "[DONE]") {
      sawTerminalEvent = true;
      break;
    }

    const event = parseJsonRecord(payload);
    if (!event) continue;
    const eventType = typeof event.type === "string" ? event.type : "";

    if (eventType === "response.keep_alive") continue;

    if (eventType === "response.output_text.delta") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (delta) {
        chunks.push(delta);
        onDelta?.();
        yield { type: "delta", text: delta };
      }
      continue;
    }

    if (eventType === "response.output_text.done") {
      sawTerminalEvent = true;
      finalizedText = typeof event.text === "string" ? event.text : null;
      continue;
    }

    if (eventType === "response.completed") {
      sawTerminalEvent = true;
      if (isRecord(event.response)) {
        completedResponse =
          event.response as unknown as OpenAI.Responses.Response;
      }
      continue;
    }

    if (
      eventType === "response.failed" ||
      eventType === "response.incomplete"
    ) {
      const failedResponse = isRecord(event.response)
        ? (event.response as unknown as OpenAI.Responses.Response)
        : null;
      throw new Error(
        failedResponse
          ? (extractResponseFailureMessage(failedResponse) ??
              "AI response failed")
          : "AI response failed",
      );
    }

    if (eventType === "error") {
      const error = isRecord(event.error) ? event.error : null;
      const message =
        typeof event.message === "string"
          ? event.message
          : typeof error?.message === "string"
            ? error.message
            : "AI response stream failed";
      throw new Error(message);
    }
  }

  return resolveStreamedContent({
    completedResponse,
    finalizedText,
    chunks,
    sawTerminalEvent,
  });
}

function openRouterModels(config: ProviderConfig): readonly string[] {
  const configured = config.openRouter?.models
    ?.map((model) => model.trim())
    .filter((model) => model.length > 0);
  if (configured?.length) return configured;

  return OPENROUTER_MODELS;
}

export async function* generateChatReplyStream(
  messages: readonly ChatMessage[],
  options: ChatGenerationOptions,
): AsyncGenerator<ChatReplyStreamChunk, void, void> {
  if (!messages.length) {
    throw new Error("No chat messages were provided");
  }

  // Search is deliberately completed before provider selection so it runs exactly once,
  // is reused by every attempt, and fails closed before any model can answer ungrounded.
  const prepared = await prepareChatMessages(messages, options);
  const config = options.providerConfig;
  const dependencies = options.dependencies;
  const createClient =
    dependencies?.createClient ?? createOpenAiCompatibleClient;
  const fetchImplementation = dependencies?.fetch ?? globalThis.fetch;
  const logger = dependencies?.logger ?? console;
  let primaryError: unknown;

  if (config.primary) {
    const selectedPrimaryModel = resolvePrimaryModel(
      undefined,
      config.primary.model,
    );
    let primaryEmittedContent = false;

    try {
      const primaryClient = createClient(
        config.primary.baseURL,
        config.primary.apiKey,
        clientOptions(config, dependencies?.fetch),
      );
      const message = yield* runPrimaryResponsesModelStream(
        primaryClient,
        selectedPrimaryModel,
        prepared.messages,
        requestOptions(options.signal),
        () => {
          primaryEmittedContent = true;
        },
      );

      yield {
        type: "done",
        reply: {
          message,
          provider: "primary-openai-compatible",
          model: selectedPrimaryModel,
          webSearch: prepared.webSearch,
        },
      };
      return;
    } catch (error) {
      primaryError = error;
      if (isAbortError(error, options.signal)) throw error;

      const primaryErrorMessage = getErrorMessage(error);
      if (primaryEmittedContent) {
        throw new Error(
          `Primary chat stream failed after response started: ${primaryErrorMessage}`,
        );
      }

      logger.warn(
        "Primary chat model failed, falling back to streaming OpenRouter",
        { model: selectedPrimaryModel, errorClass: getErrorClass(error) },
      );
    }
  }

  const openRouter = config.openRouter;
  if (!openRouter?.apiKey.trim()) {
    if (primaryError) {
      throw new Error(
        `Primary chat model failed and OpenRouter fallback is not configured. Primary error: ${getErrorMessage(
          primaryError,
        )}`,
      );
    }
    throw new Error("No LLM generation provider is configured");
  }

  const fallbackModels = openRouterModels(config);
  const fallbackFailures: string[] = [];

  for (const fallbackModel of fallbackModels) {
    let emittedFallbackContent = false;

    try {
      const message = yield* runOpenRouterResponsesModelStream(
        config,
        fallbackModel,
        prepared.messages,
        fetchImplementation,
        requestOptions(options.signal),
        () => {
          emittedFallbackContent = true;
        },
      );

      if (fallbackModel !== fallbackModels[0]) {
        logger.warn(
          "OpenRouter chat fallback model succeeded after earlier model failed",
          {
            firstFallbackModel: fallbackModels[0],
            successfulFallbackModel: fallbackModel,
          },
        );
      }

      yield {
        type: "done",
        reply: {
          message,
          provider: "openrouter",
          model: fallbackModel,
          webSearch: prepared.webSearch,
        },
      };
      return;
    } catch (error) {
      if (isAbortError(error, options.signal)) throw error;
      const fallbackErrorMessage = getErrorMessage(error);

      // Restarting after any visible delta would duplicate/contradict the response already
      // consumed by the client. Only pre-delta failures are eligible for another model.
      if (emittedFallbackContent) {
        throw new Error(
          `OpenRouter chat stream failed after response started: ${fallbackErrorMessage}`,
        );
      }

      fallbackFailures.push(`${fallbackModel}: ${fallbackErrorMessage}`);
      logger.warn(
        "OpenRouter chat fallback model failed before streaming content",
        { model: fallbackModel, errorClass: getErrorClass(error) },
      );
    }
  }

  const primaryFailure = primaryError
    ? `Primary chat model failed (${getErrorMessage(primaryError)}) and `
    : "";
  throw new Error(
    `${primaryFailure}OpenRouter fallback failed (${fallbackFailures.join(
      " | ",
    )})`,
  );
}
