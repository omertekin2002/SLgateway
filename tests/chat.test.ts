import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

import {
  generateChatReply,
  generateChatReplyStream,
  type ChatMessage,
  type ChatReplyStreamChunk,
} from "../src/pipeline/chat";
import {
  GeminiWebSearchError,
  type GeminiSearchMessage,
  type GeminiWebSearchOptions,
  type PreparedGeminiWebSearch,
} from "../src/pipeline/gemini-search";
import type {
  FetchImplementation,
  OpenAiCompatibleClientFactory,
  ProviderConfig,
} from "../src/pipeline/llm-client";

const fixedNow = new Date("2026-07-13T08:15:30.000Z");
const originalMessages: ChatMessage[] = [
  { role: "system", content: "System prompt" },
  { role: "user", content: "What changed?" },
];
const searchMetadata = {
  query: "what changed today",
  attemptedQueries: ["what changed today"],
  successfulSearches: 1,
  sources: [
    {
      title: "Current source",
      url: "https://source.example/current",
      snippet: "Current evidence",
    },
  ],
};

const fullProviderConfig: ProviderConfig = {
  primary: {
    baseURL: "https://primary.test/v1",
    apiKey: "primary-key",
    model: "primary/model",
  },
  openRouter: {
    baseURL: "https://openrouter.test/api/v1",
    apiKey: "openrouter-key",
    models: ["fallback/one", "fallback/two"],
  },
  publicServiceUrl: "https://service.test",
  appName: "SignLoop Chat Service",
  timeoutMs: 60_000,
};

async function unknownModelDiscovery() {
  return "unknown" as const;
}

function asOpenAi(create: ReturnType<typeof vi.fn>): OpenAI {
  return { responses: { create } } as unknown as OpenAI;
}

function searchPreparer(
  implementation?: (
    messages: readonly GeminiSearchMessage[],
    options: GeminiWebSearchOptions,
  ) => Promise<PreparedGeminiWebSearch>,
) {
  return vi.fn(
    implementation ??
      (async (messages: readonly GeminiSearchMessage[]) => ({
        messages: messages.map((message, index) =>
          index === messages.length - 1
            ? {
                ...message,
                content: `${message.content}\n\nBEGIN_APPLICATION_WEB_RESEARCH_JSON\nCurrent evidence\nEND_APPLICATION_WEB_RESEARCH_JSON`,
              }
            : { ...message },
        ),
        webSearch: searchMetadata,
      })),
  );
}

async function collectStream(
  stream: AsyncGenerator<ChatReplyStreamChunk, void, void>,
): Promise<ChatReplyStreamChunk[]> {
  const chunks: ChatReplyStreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("generateChatReply", () => {
  it("injects authoritative current time without mutating caller messages", async () => {
    const create = vi.fn().mockResolvedValue({ output_text: "Plain answer" });
    const createClient = vi.fn(() => asOpenAi(create));

    const reply = await generateChatReply(originalMessages, {
      providerConfig: {
        ...fullProviderConfig,
        openRouter: undefined,
      },
      enableWebSearch: false,
      dependencies: {
        createClient,
        discoverModel: unknownModelDiscovery,
        now: () => fixedNow,
      },
    });

    const input = create.mock.calls[0]?.[0]?.input as ChatMessage[];
    expect(input[0]?.content).toContain(
      "Current UTC timestamp: 2026-07-13T08:15:30.000Z",
    );
    expect(input[0]?.content).toContain(
      "dates before 2026-07-13 are in the past",
    );
    expect(originalMessages[0]?.content).toBe("System prompt");
    expect(reply).toEqual({
      message: "Plain answer",
      provider: "primary-openai-compatible",
      model: "primary/model",
      webSearch: null,
    });
  });

  it("prepends time context when no system message exists", async () => {
    const create = vi.fn().mockResolvedValue({ output_text: "Timed answer" });
    const userOnly: ChatMessage[] = [
      { role: "user", content: "Was July 10 in the past?" },
    ];

    await generateChatReply(userOnly, {
      providerConfig: { ...fullProviderConfig, openRouter: undefined },
      enableWebSearch: false,
      dependencies: {
        createClient: (() => asOpenAi(create)) as OpenAiCompatibleClientFactory,
        discoverModel: unknownModelDiscovery,
        now: () => fixedNow,
      },
    });

    const input = create.mock.calls[0]?.[0]?.input as ChatMessage[];
    expect(input[0]).toMatchObject({ role: "system" });
    expect(input[0]?.content).toContain(
      "Current UTC calendar date: 2026-07-13",
    );
    expect(input[1]).toEqual(userOnly[0]);
    expect(userOnly).toEqual([
      { role: "user", content: "Was July 10 in the past?" },
    ]);
  });

  it("searches once and reuses identical evidence across fallback attempts", async () => {
    const primaryCreate = vi.fn().mockRejectedValue(new Error("primary down"));
    const fallbackCreate = vi.fn().mockResolvedValue({
      output_text: "Fallback answer",
    });
    const createClient = vi.fn((baseURL: string) =>
      baseURL.includes("primary")
        ? asOpenAi(primaryCreate)
        : asOpenAi(fallbackCreate),
    );
    const prepareWebSearch = searchPreparer();

    const reply = await generateChatReply(originalMessages, {
      providerConfig: fullProviderConfig,
      researchMode: "always",
      geminiSearch: {
        apiKey: "gemini-key",
        model: "gemini-search-model",
        timeoutMs: 987,
      },
      dependencies: {
        createClient,
        discoverModel: unknownModelDiscovery,
        prepareWebSearch,
        now: () => fixedNow,
        logger: { warn: vi.fn() },
      },
    });

    expect(prepareWebSearch).toHaveBeenCalledOnce();
    expect(prepareWebSearch.mock.calls[0]?.[1]).toMatchObject({
      apiKey: "gemini-key",
      model: "gemini-search-model",
      timeoutMs: 987,
      currentTime: fixedNow,
    });
    expect(primaryCreate.mock.calls[0]?.[0]?.input).toEqual(
      fallbackCreate.mock.calls[0]?.[0]?.input,
    );
    expect(reply).toEqual({
      message: "Fallback answer",
      provider: "openrouter",
      model: "fallback/one",
      webSearch: searchMetadata,
    });
  });

  it("auto skips research for ordinary instructions", async () => {
    const create = vi.fn().mockResolvedValue({ output_text: "diagnostic ok" });
    const prepareWebSearch = searchPreparer();

    const reply = await generateChatReply(
      [{ role: "user", content: "Reply with exactly: diagnostic ok." }],
      {
        providerConfig: { ...fullProviderConfig, openRouter: undefined },
        geminiSearch: { apiKey: "gemini-key" },
        dependencies: {
          createClient: (() => asOpenAi(create)) as OpenAiCompatibleClientFactory,
          discoverModel: unknownModelDiscovery,
          prepareWebSearch,
        },
      },
    );

    expect(prepareWebSearch).not.toHaveBeenCalled();
    expect(reply.webSearch).toBeNull();
  });

  it("auto searches explicit current and source requests", async () => {
    const create = vi.fn().mockResolvedValue({ output_text: "Current answer" });
    const prepareWebSearch = searchPreparer();

    const reply = await generateChatReply(
      [{ role: "user", content: "What is the latest rule? Cite sources." }],
      {
        providerConfig: { ...fullProviderConfig, openRouter: undefined },
        geminiSearch: { apiKey: "gemini-key" },
        dependencies: {
          createClient: (() => asOpenAi(create)) as OpenAiCompatibleClientFactory,
          discoverModel: unknownModelDiscovery,
          prepareWebSearch,
        },
      },
    );

    expect(prepareWebSearch).toHaveBeenCalledOnce();
    expect(reply.webSearch).toEqual(searchMetadata);
  });

  it("auto falls through on invalid or transient research without injecting it", async () => {
    const create = vi.fn().mockResolvedValue({ output_text: "Ungrounded answer" });
    const createClient = (() => asOpenAi(create)) as OpenAiCompatibleClientFactory;
    const searchError = new Error("Gemini search unavailable");
    const prepareWebSearch = searchPreparer(async () => {
      throw searchError;
    });
    const logger = { warn: vi.fn() };

    const reply = await generateChatReply(
      [{ role: "user", content: "Find current sources for this rule." }],
      {
        providerConfig: { ...fullProviderConfig, openRouter: undefined },
        geminiSearch: { apiKey: "gemini-key" },
        dependencies: {
          createClient,
          discoverModel: unknownModelDiscovery,
          prepareWebSearch,
          logger,
        },
      },
    );

    expect(reply.webSearch).toBeNull();
    expect(create).toHaveBeenCalledOnce();
    const generationInput = create.mock.calls[0]?.[0]?.input as ChatMessage[];
    expect(JSON.stringify(generationInput)).not.toContain(
      "BEGIN_APPLICATION_WEB_RESEARCH_JSON",
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ event: "research_fallback" }),
    );
  });

  it("auto falls through when Gemini returns no valid sources", async () => {
    const create = vi.fn().mockResolvedValue({ output_text: "Ungrounded answer" });
    const prepareWebSearch = searchPreparer(async () => {
      throw new GeminiWebSearchError(
        "Gemini web search returned no valid web sources",
        "Grounded research is temporarily unavailable.",
      );
    });

    const reply = await generateChatReply(
      [{ role: "user", content: "Find current sources for this rule." }],
      {
        providerConfig: { ...fullProviderConfig, openRouter: undefined },
        geminiSearch: { apiKey: "gemini-key" },
        dependencies: {
          createClient: (() => asOpenAi(create)) as OpenAiCompatibleClientFactory,
          discoverModel: unknownModelDiscovery,
          prepareWebSearch,
          logger: { warn: vi.fn() },
        },
      },
    );

    expect(reply.webSearch).toBeNull();
    expect(JSON.stringify(create.mock.calls[0]?.[0]?.input)).not.toContain(
      "BEGIN_APPLICATION_WEB_RESEARCH_JSON",
    );
  });

  it("always fails closed while never bypasses Gemini", async () => {
    const create = vi.fn().mockResolvedValue({ output_text: "Plain answer" });
    const createClient = (() => asOpenAi(create)) as OpenAiCompatibleClientFactory;
    const searchError = new Error("Gemini search unavailable");
    const prepareWebSearch = searchPreparer(async () => {
      throw searchError;
    });

    await expect(
      generateChatReply(originalMessages, {
        providerConfig: { ...fullProviderConfig, openRouter: undefined },
        researchMode: "always",
        geminiSearch: { apiKey: "gemini-key" },
        dependencies: { createClient, prepareWebSearch },
      }),
    ).rejects.toBe(searchError);
    expect(create).not.toHaveBeenCalled();

    const reply = await generateChatReply(originalMessages, {
      providerConfig: { ...fullProviderConfig, openRouter: undefined },
      researchMode: "never",
      geminiSearch: { apiKey: "gemini-key" },
      dependencies: {
        createClient,
        discoverModel: unknownModelDiscovery,
        prepareWebSearch,
      },
    });
    expect(reply.webSearch).toBeNull();
    expect(prepareWebSearch).toHaveBeenCalledOnce();
  });

  it("never swallows request aborts or timeout aborts", async () => {
    for (const name of ["AbortError", "TimeoutError"] as const) {
      const controller = new AbortController();
      const reason = new DOMException("request ended", name);
      controller.abort(reason);
      const prepareWebSearch = searchPreparer(async () => {
        throw reason;
      });

      await expect(
        generateChatReply(
          [{ role: "user", content: "Find current sources." }],
          {
            providerConfig: fullProviderConfig,
            geminiSearch: { apiKey: "gemini-key" },
            signal: controller.signal,
            dependencies: { createClient: vi.fn(), prepareWebSearch },
          },
        ),
      ).rejects.toBe(reason);
    }
  });
});

describe("generateChatReplyStream", () => {
  it("preserves primary deltas and attaches search metadata to done", async () => {
    async function* responseStream() {
      yield { type: "response.output_text.delta", delta: "Live " };
      yield { type: "response.output_text.delta", delta: "answer" };
      yield { type: "response.output_text.done", text: "Live answer" };
    }

    const create = vi.fn().mockResolvedValue(responseStream());
    const prepareWebSearch = searchPreparer();
    const chunks = await collectStream(
      generateChatReplyStream(originalMessages, {
        providerConfig: fullProviderConfig,
        researchMode: "always",
        geminiSearch: { apiKey: "gemini-key" },
        dependencies: {
          createClient: (() => asOpenAi(create)) as OpenAiCompatibleClientFactory,
          discoverModel: unknownModelDiscovery,
          prepareWebSearch,
          now: () => fixedNow,
        },
      }),
    );

    expect(chunks).toEqual([
      { type: "delta", text: "Live " },
      { type: "delta", text: "answer" },
      {
        type: "done",
        reply: {
          message: "Live answer",
          provider: "primary-openai-compatible",
          model: "primary/model",
          webSearch: searchMetadata,
        },
      },
    ]);
    expect(prepareWebSearch).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      stream: true,
      max_output_tokens: 4_096,
    });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("tools");
  });

  it("reuses one search result across ordered streaming OpenRouter fallback", async () => {
    const primaryCreate = vi
      .fn()
      .mockRejectedValue(new Error("primary unavailable"));
    const createClient = (() =>
      asOpenAi(primaryCreate)) as OpenAiCompatibleClientFactory;
    const prepareWebSearch = searchPreparer();
    const requestedModels: string[] = [];
    const fetchMock = vi.fn<FetchImplementation>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        input: ChatMessage[];
      };
      requestedModels.push(body.model);
      expect(body.input.at(-1)?.content).toContain(
        "BEGIN_APPLICATION_WEB_RESEARCH_JSON",
      );

      if (body.model === "fallback/one") {
        return new Response('{"error":{"message":"temporarily unavailable"}}', {
          status: 503,
        });
      }

      return new Response(
        [
          'data: {"type":"response.output_text.delta","delta":"Fallback "}\r\n\r\n',
          'data: {"type":"response.output_text.delta","delta":"answer"}\r\n\r\n',
          'data: {"type":"response.output_text.done","text":"Fallback answer"}\r\n\r\n',
          "data: [DONE]\r\n\r\n",
        ].join(""),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    });

    const chunks = await collectStream(
      generateChatReplyStream(originalMessages, {
        providerConfig: fullProviderConfig,
        researchMode: "always",
        geminiSearch: { apiKey: "gemini-key" },
        dependencies: {
          createClient,
          discoverModel: unknownModelDiscovery,
          fetch: fetchMock,
          prepareWebSearch,
          now: () => fixedNow,
          logger: { warn: vi.fn() },
        },
      }),
    );

    expect(requestedModels).toEqual(["fallback/one", "fallback/two"]);
    expect(prepareWebSearch).toHaveBeenCalledOnce();
    expect(chunks.slice(0, 2)).toEqual([
      { type: "delta", text: "Fallback " },
      { type: "delta", text: "answer" },
    ]);
    expect(chunks.at(-1)).toEqual({
      type: "done",
      reply: {
        message: "Fallback answer",
        provider: "openrouter",
        model: "fallback/two",
        webSearch: searchMetadata,
      },
    });
  });

  it("never restarts on fallback after a visible primary delta", async () => {
    async function* failingStream() {
      yield { type: "response.output_text.delta", delta: "Visible" };
      throw new Error("connection reset");
    }

    const fetchMock = vi.fn<FetchImplementation>();
    const seen: ChatReplyStreamChunk[] = [];

    await expect(
      (async () => {
        for await (const chunk of generateChatReplyStream(originalMessages, {
          providerConfig: fullProviderConfig,
          enableWebSearch: false,
          dependencies: {
            createClient: (() =>
              asOpenAi(
                vi.fn().mockResolvedValue(failingStream()),
              )) as OpenAiCompatibleClientFactory,
            discoverModel: unknownModelDiscovery,
            fetch: fetchMock,
            logger: { warn: vi.fn() },
          },
        })) {
          seen.push(chunk);
        }
      })(),
    ).rejects.toThrow(/failed after response started/i);

    expect(seen).toEqual([{ type: "delta", text: "Visible" }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a primary stream that reaches clean EOF after an unterminated delta", async () => {
    async function* truncatedStream() {
      yield { type: "response.output_text.delta", delta: "Partial" };
    }

    const fetchMock = vi.fn<FetchImplementation>();
    const seen: ChatReplyStreamChunk[] = [];

    await expect(
      (async () => {
        for await (const chunk of generateChatReplyStream(originalMessages, {
          providerConfig: fullProviderConfig,
          enableWebSearch: false,
          dependencies: {
            createClient: (() =>
              asOpenAi(
                vi.fn().mockResolvedValue(truncatedStream()),
              )) as OpenAiCompatibleClientFactory,
            discoverModel: unknownModelDiscovery,
            fetch: fetchMock,
            logger: { warn: vi.fn() },
          },
        })) {
          seen.push(chunk);
        }
      })(),
    ).rejects.toThrow(/failed after response started/i);

    expect(seen).toEqual([{ type: "delta", text: "Partial" }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never tries a later OpenRouter model after a visible fallback delta", async () => {
    const openRouterOnly: ProviderConfig = {
      openRouter: fullProviderConfig.openRouter,
      publicServiceUrl: fullProviderConfig.publicServiceUrl,
      appName: fullProviderConfig.appName,
    };
    const requestedModels: string[] = [];
    const fetchMock = vi.fn<FetchImplementation>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      requestedModels.push(body.model);
      return new Response(
        [
          'data: {"type":"response.output_text.delta","delta":"Visible"}\n\n',
          'data: {"type":"error","message":"stream disconnected"}\n\n',
        ].join(""),
        {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        },
      );
    });
    const seen: ChatReplyStreamChunk[] = [];

    await expect(
      (async () => {
        for await (const chunk of generateChatReplyStream(originalMessages, {
          providerConfig: openRouterOnly,
          enableWebSearch: false,
          dependencies: {
            fetch: fetchMock,
            logger: { warn: vi.fn() },
          },
        })) {
          seen.push(chunk);
        }
      })(),
    ).rejects.toThrow(/failed after response started/i);

    expect(seen).toEqual([{ type: "delta", text: "Visible" }]);
    expect(requestedModels).toEqual(["fallback/one"]);
  });

  it("rejects raw OpenRouter clean EOF after a delta without a terminal marker", async () => {
    const openRouterOnly: ProviderConfig = {
      openRouter: fullProviderConfig.openRouter,
      publicServiceUrl: fullProviderConfig.publicServiceUrl,
      appName: fullProviderConfig.appName,
    };
    const requestedModels: string[] = [];
    const fetchMock = vi.fn<FetchImplementation>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      requestedModels.push(body.model);
      return new Response(
        'data: {"type":"response.output_text.delta","delta":"Partial"}\n\n',
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    });
    const seen: ChatReplyStreamChunk[] = [];

    await expect(
      (async () => {
        for await (const chunk of generateChatReplyStream(originalMessages, {
          providerConfig: openRouterOnly,
          enableWebSearch: false,
          dependencies: {
            fetch: fetchMock,
            logger: { warn: vi.fn() },
          },
        })) {
          seen.push(chunk);
        }
      })(),
    ).rejects.toThrow(/failed after response started/i);

    expect(seen).toEqual([{ type: "delta", text: "Partial" }]);
    expect(requestedModels).toEqual(["fallback/one"]);
  });
});
