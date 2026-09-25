// Ported from SignLoop apps/web/lib/chat.ts at 3f830abaae4d47dedecabea3fca57a4899a8f688.
import { createOpenAI } from "@ai-sdk/openai";
import { withAbort } from "./bounded-response";
import {
  OPENROUTER_MODELS,
  GenerationUnavailableError,
  createRestrictedProviderFetch,
  isEligibleOpenRouterFallback,
  safeProviderFailureMetadata,
  type ProviderConfig,
  type LlmFallbackLogger,
  type FetchImplementation,
  type SafeProviderFailure,
} from "./llm-client";
export const FIRST_CHUNK_TIMEOUT_MS = 20_000;

type RoutedCandidate = ReturnType<ReturnType<typeof createOpenAI>["responses"]>;
type StreamOptions = Parameters<RoutedCandidate["doStream"]>[0];
type StreamResult = Awaited<ReturnType<RoutedCandidate["doStream"]>>;
type StreamPart =
  StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

export class FirstChunkTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Provider sent no response within ${timeoutMs}ms`);
    this.name = "FirstChunkTimeoutError";
  }
}

// Opens a provider stream and waits for its first content part, so an endpoint that accepts the
// request but never answers fails like a refused connection instead of consuming the whole budget.
async function openStreamWithDeadline(
  candidate: RoutedCandidate,
  options: StreamOptions,
  timeoutMs: number,
): Promise<StreamResult> {
  const outer = options.abortSignal;
  const deadline = new AbortController();
  // Compose instead of forwarding the outer abort through a hand-attached listener. That listener
  // has to outlive this function — it is what cancels an in-flight provider request once the
  // stream is already being consumed — so it could never be detached here, and `outer` is the one
  // per-request signal shared by every step of the tool loop: each step left another listener, and
  // another retained AbortController, on it. AbortSignal.any keeps its link to the sources weak,
  // so the composite and the link are collected with the stream that uses them.
  const signal = outer
    ? AbortSignal.any([outer, deadline.signal])
    : deadline.signal;
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
  aborted.catch(() => {});
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    deadline.abort(new FirstChunkTimeoutError(timeoutMs));
  }, timeoutMs);
  let reader: ReadableStreamDefaultReader<StreamPart> | undefined;
  try {
    const result = await Promise.race([
      candidate.doStream({ ...options, abortSignal: signal }),
      aborted,
    ]);
    reader = result.stream.getReader();
    const buffered: StreamPart[] = [];
    let closed = false;
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) {
        closed = true;
        break;
      }
      buffered.push(value);
      if (buffered.length > 256)
        throw new Error("Provider sent too many opening events");
      // Metadata/text-start can arrive long before useful output. Keep the opening deadline
      // until content, a tool event, an error, or completion makes retrying inappropriate.
      if (
        ![
          "stream-start",
          "response-metadata",
          "text-start",
          "reasoning-start",
          "raw",
        ].includes(value.type)
      )
        break;
    }
    const source = reader;
    const stream = new ReadableStream<StreamPart>({
      start(sink) {
        for (const part of buffered) sink.enqueue(part);
        if (closed) sink.close();
      },
      async pull(sink) {
        const { done, value } = await withAbort(source.read(), signal);
        if (done) sink.close();
        else sink.enqueue(value);
      },
      cancel: (reason) => source.cancel(reason),
    });
    return { ...result, stream };
  } catch (error) {
    reader?.cancel().catch(() => {});
    if (timedOut && !outer?.aborted)
      throw new FirstChunkTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Switch providers only when opening a model step fails or the provider never starts answering.
// Completed tool results remain in the agent's transcript; a stream that already delivered content
// is never replayed on another provider. Exported for tests.
export function createRoutedModel(
  config: ProviderConfig,
  options: {
    firstChunkTimeoutMs?: number;
    logger?: LlmFallbackLogger;
    fetch?: FetchImplementation;
  } = {},
) {
  const firstChunkTimeoutMs =
    options.firstChunkTimeoutMs ?? FIRST_CHUNK_TIMEOUT_MS;
  const candidates = [
    ...(config.primary
      ? [
          {
            model: config.primary.model,
            provider: "primary-openai-compatible" as const,
            url: config.primary.baseURL,
            key: config.primary.apiKey,
          },
        ]
      : []),
    ...(config.openRouter
      ? (config.openRouter.models ?? OPENROUTER_MODELS).map((model) => ({
          model,
          provider: "openrouter" as const,
          url: config.openRouter!.baseURL,
          key: config.openRouter!.apiKey,
        }))
      : []),
  ];
  if (!candidates.length) throw new GenerationUnavailableError([]);
  const failures: SafeProviderFailure[] = [];
  const models = candidates.map((candidate) =>
    createOpenAI({
      baseURL: candidate.url,
      apiKey: candidate.key || "not-required",
      headers: {
        "HTTP-Referer": config.publicServiceUrl,
        "X-Title": config.appName,
      },
      fetch: createRestrictedProviderFetch({
        fetch: options.fetch ?? globalThis.fetch,
        apiKey: candidate.key || "not-required",
        publicServiceUrl: config.publicServiceUrl,
        appName: config.appName,
      }) as typeof globalThis.fetch,
    }).responses(candidate.model),
  );
  let index = 0;
  const base = models[0]!;
  async function attempt<T>(
    signal: AbortSignal | undefined,
    run: (candidate: RoutedCandidate) => PromiseLike<T>,
  ): Promise<T> {
    for (;;) {
      signal?.throwIfAborted();
      try {
        return await run(models[index]!);
      } catch (error) {
        if (signal?.aborted) throw error;
        const candidate = candidates[index]!;
        const failure = safeProviderFailureMetadata(
          candidate.provider,
          candidate.model,
          error,
        );
        failures.push(failure);
        options.logger?.warn("Chat provider step failed", {
          event: "provider_failure",
          ...failure,
        });
        if (
          index === models.length - 1 ||
          (candidate.provider === "openrouter" &&
            !isEligibleOpenRouterFallback(error))
        ) {
          throw new GenerationUnavailableError(failures);
        }
        index++;
      }
    }
  }
  return {
    selected: () => candidates[index]!,
    model: {
      specificationVersion: base.specificationVersion,
      provider: base.provider,
      modelId: base.modelId,
      supportedUrls: base.supportedUrls,
      doGenerate: (options: Parameters<RoutedCandidate["doGenerate"]>[0]) =>
        attempt(options.abortSignal, (candidate) =>
          candidate.doGenerate(options),
        ),
      doStream: (options: StreamOptions) =>
        attempt(options.abortSignal, (candidate) =>
          openStreamWithDeadline(candidate, options, firstChunkTimeoutMs),
        ),
    },
  };
}
