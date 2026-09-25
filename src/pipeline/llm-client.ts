import OpenAI from "openai";

import {
  discoverPrimaryModelAvailability,
  type PrimaryModelAvailability,
  type PrimaryModelDiscoveryConfig,
  type PrimaryModelDiscoveryOptions,
} from "./provider-models";

// Adapted from SignLoop apps/web/lib/llm-client.ts.
// Source commit: 5d06ed2630386c4a9af78373ce998d31dbc1f776
// Environment reads were replaced with explicit configuration and injectable clients.

export const OPENROUTER_MODELS = ["openrouter/free"] as const;

export type LlmProvider = "primary-openai-compatible" | "openrouter";

export type PrimaryProviderConfig = {
  readonly baseURL: string;
  readonly apiKey?: string;
  readonly model: string;
};

export type OpenRouterProviderConfig = {
  readonly baseURL: string;
  readonly apiKey: string;
  readonly models?: readonly string[];
};

/**
 * Provider-only configuration derived from the service's validated startup config.
 * This module deliberately never reads process.env, so each request is deterministic
 * and unit tests can supply isolated provider settings.
 */
export type ProviderConfig = {
  readonly primary?: PrimaryProviderConfig;
  readonly openRouter?: OpenRouterProviderConfig;
  readonly publicServiceUrl: string;
  readonly appName: string;
  readonly timeoutMs?: number;
};

export type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type OpenAiCompatibleClientOptions = {
  readonly timeoutMs?: number;
  readonly publicServiceUrl?: string;
  readonly appName?: string;
  readonly fetch?: FetchImplementation;
};

export type OpenAiCompatibleClientFactory = (
  baseURL: string,
  apiKey?: string,
  options?: OpenAiCompatibleClientOptions,
) => OpenAI;

export type LlmFallbackLogger = Pick<Console, "warn">;

export type SafeProviderFailure = Readonly<{
  provider: LlmProvider;
  model: string;
  errorClass: string;
  statusCode?: number;
  providerCode?: string;
  upstreamRequestId?: string;
}>;

const SILENT_OPENAI_SDK_LOGGER = Object.freeze({
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
});

export function createRestrictedProviderFetch(input: {
  fetch: FetchImplementation;
  apiKey: string;
  publicServiceUrl?: string;
  appName?: string;
}): FetchImplementation {
  return async (resource, init) => {
    const sdkHeaders = new Headers(init?.headers);
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${input.apiKey}`,
    });
    const contentType = sdkHeaders.get("content-type");
    if (contentType) headers.set("Content-Type", contentType);
    if (input.publicServiceUrl?.trim()) {
      headers.set("HTTP-Referer", input.publicServiceUrl.trim());
    }
    if (input.appName?.trim()) {
      headers.set("X-Title", input.appName.trim());
    }

    // Rebuild the outbound set from explicit service configuration. This neutralizes the SDK's
    // ambient OPENAI_CUSTOM_HEADERS escape hatch, including unrelated credential headers.
    return input.fetch.call(undefined, resource, { ...init, headers });
  };
}

/** A provider returned content that cannot safely be treated as a valid response. */
export class LlmResponseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmResponseValidationError";
  }
}

/** Safe provider HTTP failure used by direct OpenRouter streaming requests. */
export class ProviderHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly providerCode?: string,
    readonly upstreamRequestId?: string,
  ) {
    super("Generation provider request failed");
    this.name = "ProviderHttpError";
  }
}

/** All configured and eligible generation attempts were exhausted. */
export class GenerationUnavailableError extends Error {
  constructor(readonly failures: readonly SafeProviderFailure[]) {
    super("All configured generation providers are unavailable");
    this.name = "GenerationUnavailableError";
  }
}

function getErrorClass(error: unknown): string {
  const candidate =
    error instanceof Error ? error.name || "Error" : typeof error;
  return /^[A-Za-z0-9_.-]{1,100}$/u.test(candidate) ? candidate : "Error";
}

function safeMachineValue(value: unknown, maximum = 100): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return new RegExp(`^[A-Za-z0-9_.:-]{1,${maximum}}$`, "u").test(trimmed)
    ? trimmed
    : undefined;
}

function safeStatusCode(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined;
}

function providerStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  return safeStatusCode(record.status) ?? safeStatusCode(record.statusCode);
}

/** Retry another OpenRouter model only when the failure could plausibly be model-specific/transient. */
export function isEligibleOpenRouterFallback(error: unknown): boolean {
  const statusCode = providerStatusCode(error);
  if (statusCode === undefined) return true;
  if (statusCode === 400 && typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const nested =
      typeof record.error === "object" && record.error !== null
        ? (record.error as Record<string, unknown>)
        : {};
    const code = safeMachineValue(record.code) ?? safeMachineValue(nested.code);
    if (
      code === "model_not_found" ||
      code === "model_not_available" ||
      code === "invalid_model"
    ) {
      return true;
    }
  }
  return ![400, 401, 403, 405, 413, 422].includes(statusCode);
}

/** Reduce any SDK/provider error to the only metadata allowed at the logging boundary. */
export function safeProviderFailureMetadata(
  provider: LlmProvider,
  model: string,
  error: unknown,
): SafeProviderFailure {
  const record =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : {};
  const nested =
    typeof record.error === "object" && record.error !== null
      ? (record.error as Record<string, unknown>)
      : {};
  const headers = record.headers instanceof Headers ? record.headers : null;
  const statusCode =
    safeStatusCode(record.status) ?? safeStatusCode(record.statusCode);
  const providerCode =
    safeMachineValue(record.code) ?? safeMachineValue(nested.code);
  const upstreamRequestId =
    safeMachineValue(record.request_id, 128) ??
    safeMachineValue(record.requestId, 128) ??
    safeMachineValue(record.requestID, 128) ??
    safeMachineValue(headers?.get("x-request-id"), 128);

  return {
    provider,
    model,
    errorClass: getErrorClass(error),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(providerCode ? { providerCode } : {}),
    ...(upstreamRequestId ? { upstreamRequestId } : {}),
  };
}

function logProviderFailure(
  logger: LlmFallbackLogger,
  message: string,
  failure: SafeProviderFailure,
): void {
  logger.warn(message, { event: "provider_failure", ...failure });
}

export function validateProviderBaseUrl(baseURL: string): string {
  const resolvedBaseUrl = baseURL.trim();
  if (!resolvedBaseUrl) {
    throw new Error("LLM base URL is not configured");
  }

  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(resolvedBaseUrl);
  } catch {
    throw new Error("LLM base URL is invalid");
  }

  if (
    parsedBaseUrl.protocol !== "https:" &&
    parsedBaseUrl.protocol !== "http:"
  ) {
    throw new Error("LLM base URL must use HTTP or HTTPS");
  }

  return resolvedBaseUrl;
}

export function createOpenAiCompatibleClient(
  baseURL: string,
  apiKey?: string,
  options?: OpenAiCompatibleClientOptions,
): OpenAI {
  const resolvedBaseUrl = validateProviderBaseUrl(baseURL);
  // The SDK requires a non-empty value even when a compatible endpoint intentionally
  // does not require authentication. Configured credentials pass through unchanged.
  const resolvedApiKey = apiKey?.trim() || "not-required";
  const defaultHeaders: Record<string, string> = {};

  if (options?.publicServiceUrl?.trim()) {
    defaultHeaders["HTTP-Referer"] = options.publicServiceUrl.trim();
  }
  if (options?.appName?.trim()) {
    defaultHeaders["X-Title"] = options.appName.trim();
  }
  defaultHeaders.Accept = "application/json";
  defaultHeaders.Authorization = `Bearer ${resolvedApiKey}`;

  const fetchImplementation = options?.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new Error("LLM fetch implementation is unavailable");
  }

  return new OpenAI({
    apiKey: resolvedApiKey,
    // Pin every ambient OpenAI SDK option that could leak request data or unrelated credentials.
    // In particular, OPENAI_LOG=debug otherwise logs full prompt bodies and provider URLs.
    adminAPIKey: null,
    organization: null,
    project: null,
    webhookSecret: null,
    baseURL: resolvedBaseUrl,
    timeout: options?.timeoutMs ?? 60_000,
    maxRetries: 0,
    logLevel: "off",
    logger: SILENT_OPENAI_SDK_LOGGER,
    defaultHeaders,
    fetch: createRestrictedProviderFetch({
      fetch: fetchImplementation,
      apiKey: resolvedApiKey,
      ...(options?.publicServiceUrl
        ? { publicServiceUrl: options.publicServiceUrl }
        : {}),
      ...(options?.appName ? { appName: options.appName } : {}),
    }),
  });
}

export function extractResponseOutputText(
  response: OpenAI.Responses.Response,
): string | null {
  const directOutputText =
    typeof response.output_text === "string" ? response.output_text.trim() : "";
  if (directOutputText) {
    return directOutputText;
  }

  const chunks: string[] = [];
  const outputItems = Array.isArray(response.output) ? response.output : [];

  for (const outputItem of outputItems) {
    if (typeof outputItem !== "object" || outputItem === null) continue;

    const content = Array.isArray((outputItem as { content?: unknown }).content)
      ? ((outputItem as { content?: unknown[] }).content ?? [])
      : [];

    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const candidate = part as { type?: unknown; text?: unknown };
      if (
        candidate.type === "output_text" &&
        typeof candidate.text === "string"
      ) {
        chunks.push(candidate.text);
      }
    }
  }

  const joined = chunks.join("").trim();
  return joined.length > 0 ? joined : null;
}

export function resolvePrimaryModel(
  requested: string | null | undefined,
  configured: string | null | undefined,
): string {
  if (typeof requested === "string" && requested.trim()) {
    return requested.trim();
  }
  if (typeof configured === "string" && configured.trim()) {
    return configured.trim();
  }
  throw new Error("Primary LLM model is not configured");
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "APIUserAbortError")
  );
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("The operation was aborted", "AbortError")
  );
}

export type ProviderExecutionScope = Readonly<{
  signal: AbortSignal;
  cleanup(): void;
}>;

/** One deadline shared by primary discovery, primary generation, and every fallback attempt. */
export function createProviderExecutionScope(
  parentSignal?: AbortSignal,
  timeoutMs = 60_000,
): ProviderExecutionScope {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) onAbort();
  else parentSignal?.addEventListener("abort", onAbort, { once: true });

  const timeout = setTimeout(() => {
    controller.abort(
      new DOMException("Generation request timed out", "TimeoutError"),
    );
  }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", onAbort);
    },
  };
}

function configuredOpenRouterModels(
  config: OpenRouterProviderConfig,
): readonly string[] {
  const configured = config.models
    ?.map((model) => model.trim())
    .filter((model) => model.length > 0);
  return configured?.length ? configured : OPENROUTER_MODELS;
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

export type RunWithFallbackOptions = {
  readonly primaryModel?: string | null;
  readonly signal?: AbortSignal;
  readonly shouldFallback?: (error: unknown) => boolean;
  readonly createClient?: OpenAiCompatibleClientFactory;
  readonly fetch?: FetchImplementation;
  readonly logger?: LlmFallbackLogger;
  readonly discoverModel?: (
    config: PrimaryModelDiscoveryConfig,
    options?: PrimaryModelDiscoveryOptions,
  ) => Promise<PrimaryModelAvailability>;
};

/**
 * Runs one operation against the configured primary provider, then each OpenRouter
 * model in order. Aborts and errors rejected by shouldFallback are never retried.
 */
export async function runWithPrimaryAndOpenRouterFallback<T>(
  config: ProviderConfig,
  run: (client: OpenAI, model: string, signal: AbortSignal) => Promise<T>,
  options?: RunWithFallbackOptions,
): Promise<{ result: T; provider: LlmProvider; model: string }> {
  const createClient = options?.createClient ?? createOpenAiCompatibleClient;
  const logger = options?.logger ?? console;
  const openRouter = config.openRouter;
  const scope = createProviderExecutionScope(options?.signal, config.timeoutMs);
  const failures: SafeProviderFailure[] = [];

  try {
    if (config.primary) {
      const primaryModel = resolvePrimaryModel(
        options?.primaryModel,
        config.primary.model,
      );
      const discoverModel =
        options?.discoverModel ?? discoverPrimaryModelAvailability;
      const availability = await discoverModel(config.primary, {
        ...(options?.fetch ? { fetch: options.fetch } : {}),
        signal: scope.signal,
      });

      if (availability === "unavailable") {
        const failure: SafeProviderFailure = {
          provider: "primary-openai-compatible",
          model: primaryModel,
          errorClass: "ModelUnavailableError",
          providerCode: "model_not_available",
        };
        failures.push(failure);
        logger.warn(
          "Configured primary model is not advertised by the provider",
          {
            event: "provider_model_unavailable",
            ...failure,
          },
        );
      } else {
        try {
          const primaryClient = createClient(
            config.primary.baseURL,
            config.primary.apiKey,
            clientOptions(config, options?.fetch),
          );
          const result = await run(primaryClient, primaryModel, scope.signal);
          return {
            result,
            provider: "primary-openai-compatible",
            model: primaryModel,
          };
        } catch (error) {
          if (isAbortError(error, scope.signal)) {
            throw scope.signal.aborted ? abortReason(scope.signal) : error;
          }
          if (options?.shouldFallback && !options.shouldFallback(error)) {
            throw error;
          }

          const failure = safeProviderFailureMetadata(
            "primary-openai-compatible",
            primaryModel,
            error,
          );
          failures.push(failure);
          logProviderFailure(
            logger,
            "Primary LLM call failed, falling back to OpenRouter",
            failure,
          );
        }
      }
    }

    if (!openRouter?.apiKey.trim()) {
      throw new GenerationUnavailableError(failures);
    }

    const fallbackClient = createClient(
      openRouter.baseURL,
      openRouter.apiKey,
      clientOptions(config, options?.fetch),
    );
    const fallbackModels = configuredOpenRouterModels(openRouter);

    for (const fallbackModel of fallbackModels) {
      try {
        const result = await run(fallbackClient, fallbackModel, scope.signal);
        if (fallbackModel !== fallbackModels[0]) {
          logger.warn(
            "OpenRouter fallback model succeeded after earlier model failed",
            {
              event: "provider_fallback_succeeded",
              provider: "openrouter",
              firstFallbackModel: fallbackModels[0],
              successfulFallbackModel: fallbackModel,
            },
          );
        }
        return { result, provider: "openrouter", model: fallbackModel };
      } catch (error) {
        if (isAbortError(error, scope.signal)) {
          throw scope.signal.aborted ? abortReason(scope.signal) : error;
        }
        if (options?.shouldFallback && !options.shouldFallback(error)) {
          throw error;
        }

        const failure = safeProviderFailureMetadata(
          "openrouter",
          fallbackModel,
          error,
        );
        failures.push(failure);
        logProviderFailure(logger, "OpenRouter fallback model failed", failure);
        if (!isEligibleOpenRouterFallback(error)) {
          throw new GenerationUnavailableError(failures);
        }
      }
    }

    throw new GenerationUnavailableError(failures);
  } finally {
    scope.cleanup();
  }
}
