import { isRecord } from "../utils";
import { readBoundedJson } from "./bounded-response";

export const PRIMARY_MODEL_DISCOVERY_TIMEOUT_MS = 7_500;
export const PRIMARY_MODEL_DISCOVERY_CACHE_TTL_MS = 5 * 60_000;

export type PrimaryModelAvailability = "available" | "unavailable" | "unknown";

export type PrimaryModelDiscoveryConfig = Readonly<{
  baseURL: string;
  apiKey?: string;
  model: string;
}>;

export type ModelDiscoveryFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type PrimaryModelDiscoveryOptions = Readonly<{
  fetch?: ModelDiscoveryFetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
}>;

type CachedAvailability = {
  availability: Exclude<PrimaryModelAvailability, "unknown">;
  expiresAt: number;
};

const availabilityCache = new Map<string, CachedAvailability>();

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("The operation was aborted", "AbortError")
  );
}

function modelIds(payload: unknown): string[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return null;

  const ids: string[] = [];
  for (const item of payload.data) {
    if (!isRecord(item) || typeof item.id !== "string") continue;
    const id = item.id.trim();
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * Advisory OpenAI-compatible /models check. Only a valid successful model list can skip primary;
 * unsupported endpoints, malformed responses, and transient failures all return unknown.
 */
export async function discoverPrimaryModelAvailability(
  config: PrimaryModelDiscoveryConfig,
  options: PrimaryModelDiscoveryOptions = {},
): Promise<PrimaryModelAvailability> {
  const now = options.now?.() ?? Date.now();
  const cacheKey = `${config.baseURL}\u0000${config.model}`;
  const cached = availabilityCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.availability;
  if (cached) availabilityCache.delete(cacheKey);

  if (options.signal?.aborted) throw abortReason(options.signal);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") return "unknown";

  const controller = new AbortController();
  let discoveryTimedOut = false;
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    discoveryTimedOut = true;
    controller.abort(
      new DOMException("Model discovery timed out", "TimeoutError"),
    );
  }, options.timeoutMs ?? PRIMARY_MODEL_DISCOVERY_TIMEOUT_MS);

  try {
    const response = await fetchImplementation(
      `${config.baseURL.replace(/\/+$/u, "")}/models`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...(config.apiKey?.trim()
            ? { Authorization: `Bearer ${config.apiKey.trim()}` }
            : {}),
        },
        signal: controller.signal,
      },
    );
    if (!response.ok) return "unknown";

    const ids = modelIds(await readBoundedJson(response, controller.signal));
    if (!ids) return "unknown";
    const availability = ids.includes(config.model)
      ? "available"
      : "unavailable";
    availabilityCache.set(cacheKey, {
      availability,
      expiresAt:
        now + (options.cacheTtlMs ?? PRIMARY_MODEL_DISCOVERY_CACHE_TTL_MS),
    });
    return availability;
  } catch (error) {
    if (options.signal?.aborted) throw abortReason(options.signal);
    if (discoveryTimedOut) return "unknown";
    return "unknown";
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** Test-only cache reset; production discovery results expire through the normal TTL. */
export function clearPrimaryModelAvailabilityCache(): void {
  availabilityCache.clear();
}
