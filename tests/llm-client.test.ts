import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

import {
  OPENROUTER_MODELS,
  LlmResponseValidationError,
  createOpenAiCompatibleClient,
  extractResponseOutputText,
  runWithPrimaryAndOpenRouterFallback,
  type FetchImplementation,
  type OpenAiCompatibleClientFactory,
  type OpenAiCompatibleClientOptions,
  type ProviderConfig,
} from "../src/pipeline/llm-client";

const providerConfig: ProviderConfig = {
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
  timeoutMs: 12_345,
};

describe("createOpenAiCompatibleClient", () => {
  it("fails closed when the endpoint is absent", () => {
    expect(() => createOpenAiCompatibleClient("", "configured-key")).toThrow(
      /base URL is not configured/i,
    );
  });

  it("supports intentionally unauthenticated compatible endpoints", () => {
    expect(() =>
      createOpenAiCompatibleClient("https://provider.example/v1"),
    ).not.toThrow();
  });

  it("rejects non-HTTP provider URLs", () => {
    expect(() =>
      createOpenAiCompatibleClient("file:///tmp/provider", "configured-key"),
    ).toThrow(/must use HTTP or HTTPS/i);
  });

  it("does not read provider settings from process.env", () => {
    const prior = process.env.PRIMARY_LLM_BASE_URL;
    process.env.PRIMARY_LLM_BASE_URL = "file:///must-not-be-used";
    try {
      expect(() =>
        createOpenAiCompatibleClient("https://explicit.example/v1"),
      ).not.toThrow();
    } finally {
      if (prior === undefined) delete process.env.PRIMARY_LLM_BASE_URL;
      else process.env.PRIMARY_LLM_BASE_URL = prior;
    }
  });

  it("disables ambient SDK logging and unrelated OpenAI credentials", () => {
    vi.stubEnv("OPENAI_LOG", "debug");
    vi.stubEnv("OPENAI_ORG_ID", "ambient-organization");
    vi.stubEnv("OPENAI_PROJECT_ID", "ambient-project");
    vi.stubEnv("OPENAI_ADMIN_KEY", "ambient-admin-key");
    vi.stubEnv("OPENAI_WEBHOOK_SECRET", "ambient-webhook-secret");
    try {
      const client = createOpenAiCompatibleClient(
        "https://explicit.example/v1",
        "explicit-key",
      );

      expect(client.logLevel).toBe("off");
      expect(client.organization).toBeNull();
      expect(client.project).toBeNull();
      expect(client.adminAPIKey).toBeNull();
      expect(client.webhookSecret).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("strips ambient custom headers before provider requests", async () => {
    vi.stubEnv(
      "OPENAI_CUSTOM_HEADERS",
      "Authorization: Bearer ambient-secret\nX-Ambient: private-value",
    );
    let outboundHeaders: Headers | undefined;
    const fetchImplementation: FetchImplementation = async (_input, init) => {
      outboundHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          id: "response-test",
          object: "response",
          status: "completed",
          output: [],
          output_text: "ok",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      const client = createOpenAiCompatibleClient(
        "https://explicit.example/v1",
        "explicit-key",
        {
          publicServiceUrl: "https://service.example",
          appName: "Configured App",
          fetch: fetchImplementation,
        },
      );
      await client.responses.create({
        model: "configured-model",
        input: "private request",
      });

      expect(outboundHeaders?.get("Authorization")).toBe(
        "Bearer explicit-key",
      );
      expect(outboundHeaders?.get("X-Ambient")).toBeNull();
      expect(outboundHeaders?.get("HTTP-Referer")).toBe(
        "https://service.example",
      );
      expect(outboundHeaders?.get("X-Title")).toBe("Configured App");
      expect(JSON.stringify([...((outboundHeaders ?? new Headers()).entries())])).not.toContain(
        "ambient-secret",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("extractResponseOutputText", () => {
  it("uses direct output text and falls back to nested output parts", () => {
    expect(
      extractResponseOutputText({ output_text: " Direct " } as OpenAI.Responses.Response),
    ).toBe("Direct");
    expect(
      extractResponseOutputText({
        output_text: "",
        output: [
          {
            content: [
              { type: "output_text", text: "Nested " },
              { type: "refusal", refusal: "ignored" },
              { type: "output_text", text: "answer" },
            ],
          },
        ],
      } as unknown as OpenAI.Responses.Response),
    ).toBe("Nested answer");
  });
});

describe("runWithPrimaryAndOpenRouterFallback", () => {
  it("tries primary, then OpenRouter models in configured order", async () => {
    const attempts: string[] = [];
    const createClientMock = vi.fn(
      (
        baseURL: string,
        _apiKey?: string,
        _options?: OpenAiCompatibleClientOptions,
      ) => ({ providerBaseURL: baseURL }) as unknown as OpenAI,
    );
    const createClient = createClientMock as OpenAiCompatibleClientFactory;
    const logger = { warn: vi.fn() };

    const result = await runWithPrimaryAndOpenRouterFallback(
      providerConfig,
      async (client, model) => {
        const baseURL = (client as unknown as { providerBaseURL: string })
          .providerBaseURL;
        attempts.push(`${baseURL}:${model}`);
        if (model !== "fallback/two") throw new Error("provider unavailable");
        return "Fallback answer";
      },
      { createClient, logger },
    );

    expect(attempts).toEqual([
      "https://primary.test/v1:primary/model",
      "https://openrouter.test/api/v1:fallback/one",
      "https://openrouter.test/api/v1:fallback/two",
    ]);
    expect(result).toEqual({
      result: "Fallback answer",
      provider: "openrouter",
      model: "fallback/two",
    });
    expect(createClientMock).toHaveBeenCalledTimes(2);
    expect(createClientMock.mock.calls[0]?.[2]).toMatchObject({
      timeoutMs: 12_345,
      publicServiceUrl: "https://service.test",
      appName: "SignLoop Chat Service",
    });
  });

  it("uses the pinned default OpenRouter order when no model list is supplied", async () => {
    const attempts: string[] = [];
    const config: ProviderConfig = {
      openRouter: {
        baseURL: "https://openrouter.test/api/v1",
        apiKey: "openrouter-key",
      },
      publicServiceUrl: "https://service.test",
      appName: "Test",
    };

    await expect(
      runWithPrimaryAndOpenRouterFallback(
        config,
        async (_client, model) => {
          attempts.push(model);
          throw new Error("down");
        },
        {
          createClient: (() => ({}) as OpenAI) as OpenAiCompatibleClientFactory,
          logger: { warn: vi.fn() },
        },
      ),
    ).rejects.toThrow(/OpenRouter fallback failed/i);

    expect(attempts).toEqual(OPENROUTER_MODELS);
  });

  it("supports an OpenRouter-only deployment", async () => {
    const config: ProviderConfig = {
      openRouter: {
        baseURL: "https://openrouter.test/api/v1",
        apiKey: "openrouter-key",
        models: ["fallback/only"],
      },
      publicServiceUrl: "https://service.test",
      appName: "Test",
    };

    await expect(
      runWithPrimaryAndOpenRouterFallback(
        config,
        async (_client, model) => `answer from ${model}`,
        {
          createClient: (() => ({}) as OpenAI) as OpenAiCompatibleClientFactory,
          logger: { warn: vi.fn() },
        },
      ),
    ).resolves.toEqual({
      result: "answer from fallback/only",
      provider: "openrouter",
      model: "fallback/only",
    });
  });

  it("does not fallback for aborts or caller-rejected errors", async () => {
    const attempts: string[] = [];
    const createClient = (() => ({}) as OpenAI) as OpenAiCompatibleClientFactory;
    const abort = new DOMException("cancelled", "AbortError");

    await expect(
      runWithPrimaryAndOpenRouterFallback(
        providerConfig,
        async (_client, model) => {
          attempts.push(model);
          throw abort;
        },
        { createClient, logger: { warn: vi.fn() } },
      ),
    ).rejects.toBe(abort);
    expect(attempts).toEqual(["primary/model"]);

    attempts.length = 0;
    const validationError = new LlmResponseValidationError("invalid output");
    await expect(
      runWithPrimaryAndOpenRouterFallback(
        providerConfig,
        async (_client, model) => {
          attempts.push(model);
          throw validationError;
        },
        {
          createClient,
          shouldFallback: (error) =>
            !(error instanceof LlmResponseValidationError),
          logger: { warn: vi.fn() },
        },
      ),
    ).rejects.toBe(validationError);
    expect(attempts).toEqual(["primary/model"]);
  });

  it("fails when no generation provider is configured", async () => {
    await expect(
      runWithPrimaryAndOpenRouterFallback(
        {
          publicServiceUrl: "https://service.test",
          appName: "Test",
        },
        async () => "unreachable",
      ),
    ).rejects.toThrow(/no LLM generation provider is configured/i);
  });
});

describe("LlmResponseValidationError", () => {
  it("can be distinguished from transport failures by fallback policy", () => {
    const error = new LlmResponseValidationError("invalid structured output");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("LlmResponseValidationError");
  });
});
