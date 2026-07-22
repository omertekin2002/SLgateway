import OpenAI from "openai";

// Adapted from SignLoop apps/web/lib/llm-client.ts.
// Source commit: 5d06ed2630386c4a9af78373ce998d31dbc1f776
// Environment reads were replaced with explicit configuration and injectable clients.

export const OPENROUTER_MODELS = [
  "google/gemma-4-31b-it:free",
  "openai/gpt-oss-120b:free",
  "openrouter/free",
] as const;

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

const SILENT_OPENAI_SDK_LOGGER = Object.freeze({
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
});

function createRestrictedProviderFetch(input: {
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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return typeof error === "string" && error ? error : "Unknown error";
}

function getErrorClass(error: unknown): string {
  return error instanceof Error ? error.name || "Error" : typeof error;
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
    maxRetries: 1,
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
};

/**
 * Runs one operation against the configured primary provider, then each OpenRouter
 * model in order. Aborts and errors rejected by shouldFallback are never retried.
 */
export async function runWithPrimaryAndOpenRouterFallback<T>(
  config: ProviderConfig,
  run: (client: OpenAI, model: string) => Promise<T>,
  options?: RunWithFallbackOptions,
): Promise<{ result: T; provider: LlmProvider; model: string }> {
  const createClient = options?.createClient ?? createOpenAiCompatibleClient;
  const logger = options?.logger ?? console;
  const openRouter = config.openRouter;
  let primaryError: unknown;

  if (config.primary) {
    const primaryModel = resolvePrimaryModel(
      options?.primaryModel,
      config.primary.model,
    );

    try {
      const primaryClient = createClient(
        config.primary.baseURL,
        config.primary.apiKey,
        clientOptions(config, options?.fetch),
      );
      const result = await run(primaryClient, primaryModel);
      return {
        result,
        provider: "primary-openai-compatible",
        model: primaryModel,
      };
    } catch (error) {
      primaryError = error;
      if (isAbortError(error, options?.signal)) {
        throw error;
      }
      if (options?.shouldFallback && !options.shouldFallback(error)) {
        throw error;
      }

      const primaryErrorMessage = getErrorMessage(error);
      logger.warn("Primary LLM call failed, falling back to OpenRouter", {
        model: primaryModel,
        errorClass: getErrorClass(error),
      });

      if (!openRouter?.apiKey.trim()) {
        throw new Error(
          `Primary endpoint failed and OpenRouter fallback is not configured. Primary error: ${primaryErrorMessage}`,
        );
      }
    }
  }

  if (!openRouter?.apiKey.trim()) {
    if (primaryError) throw primaryError;
    throw new Error("No LLM generation provider is configured");
  }

  const fallbackClient = createClient(
    openRouter.baseURL,
    openRouter.apiKey,
    clientOptions(config, options?.fetch),
  );
  const fallbackModels = configuredOpenRouterModels(openRouter);
  const fallbackFailures: string[] = [];

  for (const fallbackModel of fallbackModels) {
    try {
      const result = await run(fallbackClient, fallbackModel);
      if (fallbackModel !== fallbackModels[0]) {
        logger.warn(
          "OpenRouter fallback model succeeded after earlier model failed",
          {
            firstFallbackModel: fallbackModels[0],
            successfulFallbackModel: fallbackModel,
          },
        );
      }
      return { result, provider: "openrouter", model: fallbackModel };
    } catch (fallbackError) {
      if (isAbortError(fallbackError, options?.signal)) {
        throw fallbackError;
      }
      if (
        options?.shouldFallback &&
        !options.shouldFallback(fallbackError)
      ) {
        throw fallbackError;
      }

      const fallbackErrorMessage = getErrorMessage(fallbackError);
      fallbackFailures.push(`${fallbackModel}: ${fallbackErrorMessage}`);
      logger.warn("OpenRouter fallback model failed", {
        model: fallbackModel,
        errorClass: getErrorClass(fallbackError),
      });
    }
  }

  const primaryFailure = primaryError
    ? `Primary endpoint failed (${getErrorMessage(primaryError)}) and `
    : "";
  throw new Error(
    `${primaryFailure}OpenRouter fallback failed (${fallbackFailures.join(
      " | ",
    )})`,
  );
}
