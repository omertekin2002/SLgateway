export const OPENROUTER_FALLBACK_MODELS = Object.freeze([
  "google/gemma-4-31b-it:free",
  "openai/gpt-oss-120b:free",
  "openrouter/free",
] as const);

export type PrimaryLlmConfig = Readonly<{
  baseUrl: string;
  apiKey: string;
  model: string;
}>;

export type OpenRouterConfig = Readonly<{
  baseUrl: string;
  apiKey: string;
  models: readonly string[];
}>;

export type ServiceConfig = Readonly<{
  geminiApiKey: string;
  geminiSearchModel: string;
  primaryLlm: PrimaryLlmConfig | null;
  openRouter: OpenRouterConfig | null;
  publicServiceUrl: string;
  appName: string;
  port: number;
  maxConcurrentRequests: number;
  requestTimeoutMs: number;
  corsAllowedOrigins: ReadonlySet<string>;
}>;

type Environment = Readonly<Record<string, string | undefined>>;

function optionalValue(environment: Environment, name: string): string | null {
  const value = environment[name]?.trim();
  return value ? value : null;
}

function requiredValue(environment: Environment, name: string): string {
  const value = optionalValue(environment, name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function credentialValue(name: string, value: string): string {
  if (/\s/u.test(value)) {
    throw new Error(`${name} must not contain whitespace`);
  }
  return value;
}

function headerValue(name: string, value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} must not contain control characters`);
  }
  return value;
}

function parsePositiveInteger(
  environment: Environment,
  name: string,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = optionalValue(environment, name);
  if (!raw) return fallback;

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return parsed;
}

function parseHttpUrl(name: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }

  return value.replace(/\/+$/, "");
}

function parseGeminiSearchModel(value: string): string {
  const normalized = value.replace(/^models\//, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
    throw new Error("GEMINI_SEARCH_MODEL is invalid");
  }
  return normalized;
}

function parseCorsOrigins(raw: string | null): ReadonlySet<string> {
  if (!raw) return new Set<string>();

  const origins = new Set<string>();
  for (const configuredOrigin of raw.split(",")) {
    const candidate = configuredOrigin.trim();
    if (!candidate) continue;
    if (candidate === "*") {
      throw new Error("CORS_ALLOWED_ORIGINS must contain explicit origins, not a wildcard");
    }

    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new Error("CORS_ALLOWED_ORIGINS contains an invalid origin");
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("CORS_ALLOWED_ORIGINS must contain only HTTP(S) origins");
    }
    origins.add(url.origin);
  }

  return origins;
}

/** Parse and validate all process configuration without exposing secret values. */
export function loadServiceConfig(
  environment: Environment = process.env,
): ServiceConfig {
  const geminiApiKey = credentialValue(
    "GEMINI_API_KEY",
    requiredValue(environment, "GEMINI_API_KEY"),
  );
  const primaryBaseUrl = optionalValue(environment, "PRIMARY_LLM_BASE_URL");
  const rawPrimaryApiKey = optionalValue(environment, "PRIMARY_LLM_API_KEY");
  const primaryApiKey = rawPrimaryApiKey
    ? credentialValue("PRIMARY_LLM_API_KEY", rawPrimaryApiKey)
    : null;
  const primaryModel =
    optionalValue(environment, "PRIMARY_LLM_MODEL") ?? "gpt-5.6-luna";

  if ((primaryBaseUrl && !primaryApiKey) || (!primaryBaseUrl && primaryApiKey)) {
    throw new Error(
      "PRIMARY_LLM_BASE_URL and PRIMARY_LLM_API_KEY must be configured together",
    );
  }

  const primaryLlm =
    primaryBaseUrl && primaryApiKey
      ? Object.freeze({
          baseUrl: parseHttpUrl("PRIMARY_LLM_BASE_URL", primaryBaseUrl),
          apiKey: primaryApiKey,
          model: primaryModel,
        })
      : null;

  const rawOpenRouterApiKey = optionalValue(environment, "OPENROUTER_API_KEY");
  const openRouterApiKey = rawOpenRouterApiKey
    ? credentialValue("OPENROUTER_API_KEY", rawOpenRouterApiKey)
    : null;
  const openRouterBaseUrl =
    optionalValue(environment, "OPENROUTER_BASE_URL") ??
    "https://openrouter.ai/api/v1";
  const openRouter = openRouterApiKey
    ? Object.freeze({
        baseUrl: parseHttpUrl("OPENROUTER_BASE_URL", openRouterBaseUrl),
        apiKey: openRouterApiKey,
        models: OPENROUTER_FALLBACK_MODELS,
      })
    : null;

  if (!primaryLlm && !openRouter) {
    throw new Error(
      "Configure a primary LLM provider, OPENROUTER_API_KEY, or both",
    );
  }

  const port = parsePositiveInteger(environment, "PORT", 10_000, 65_535);
  const publicServiceUrl = parseHttpUrl(
    "PUBLIC_SERVICE_URL",
    optionalValue(environment, "PUBLIC_SERVICE_URL") ??
      optionalValue(environment, "RENDER_EXTERNAL_URL") ??
      `http://localhost:${port}`,
  );

  return Object.freeze({
    geminiApiKey,
    geminiSearchModel: parseGeminiSearchModel(
      optionalValue(environment, "GEMINI_SEARCH_MODEL") ??
        "gemini-2.5-flash",
    ),
    primaryLlm,
    openRouter,
    publicServiceUrl,
    appName: headerValue(
      "APP_NAME",
      optionalValue(environment, "APP_NAME") ?? "SignLoop Chat Service",
    ),
    port,
    maxConcurrentRequests: parsePositiveInteger(
      environment,
      "MAX_CONCURRENT_REQUESTS",
      4,
      10_000,
    ),
    requestTimeoutMs: parsePositiveInteger(
      environment,
      "REQUEST_TIMEOUT_MS",
      180_000,
      3_600_000,
    ),
    corsAllowedOrigins: parseCorsOrigins(
      optionalValue(environment, "CORS_ALLOWED_ORIGINS"),
    ),
  });
}

let cachedConfig: ServiceConfig | undefined;

/** Read the environment at most once in the production process. */
export function getServiceConfig(): ServiceConfig {
  cachedConfig ??= loadServiceConfig();
  return cachedConfig;
}
