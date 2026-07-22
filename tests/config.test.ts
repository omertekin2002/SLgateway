import { describe, expect, it } from "vitest";
import {
  OPENROUTER_FALLBACK_MODELS,
  loadServiceConfig,
} from "../src/config";

const minimumEnvironment = {
  GEMINI_API_KEY: "gemini-secret",
  OPENROUTER_API_KEY: "openrouter-secret",
};

describe("loadServiceConfig", () => {
  it("applies standalone service defaults", () => {
    const config = loadServiceConfig(minimumEnvironment);

    expect(config.port).toBe(10_000);
    expect(config.maxConcurrentRequests).toBe(4);
    expect(config.requestTimeoutMs).toBe(180_000);
    expect(config.geminiSearchModel).toBe("gemini-2.5-flash");
    expect(config.openRouter?.models).toEqual(OPENROUTER_FALLBACK_MODELS);
    expect(config.publicServiceUrl).toBe("http://localhost:10000");
  });

  it("uses PUBLIC_SERVICE_URL before the Render fallback", () => {
    const config = loadServiceConfig({
      ...minimumEnvironment,
      PUBLIC_SERVICE_URL: "https://public.example.test/",
      RENDER_EXTERNAL_URL: "https://render.example.test",
    });

    expect(config.publicServiceUrl).toBe("https://public.example.test");
  });

  it("supports a primary-only generation path", () => {
    const config = loadServiceConfig({
      GEMINI_API_KEY: "gemini-secret",
      PRIMARY_LLM_BASE_URL: "https://primary.example.test/v1",
      PRIMARY_LLM_API_KEY: "primary-secret",
    });

    expect(config.primaryLlm).toEqual({
      baseUrl: "https://primary.example.test/v1",
      apiKey: "primary-secret",
      model: "gpt-5.6-luna",
    });
    expect(config.openRouter).toBeNull();
  });

  it("requires at least one complete generation path", () => {
    expect(() =>
      loadServiceConfig({
        GEMINI_API_KEY: "gemini-secret",
      }),
    ).toThrow(/generation|provider|OPENROUTER/i);

    expect(() =>
      loadServiceConfig({
        ...minimumEnvironment,
        PRIMARY_LLM_BASE_URL: "https://primary.example.test/v1",
      }),
    ).toThrow(/configured together/i);
  });

  it("accepts only explicit HTTP CORS origins", () => {
    const config = loadServiceConfig({
      ...minimumEnvironment,
      CORS_ALLOWED_ORIGINS:
        "https://one.example.test, http://localhost:3000,https://one.example.test",
    });

    expect([...config.corsAllowedOrigins]).toEqual([
      "https://one.example.test",
      "http://localhost:3000",
    ]);
    expect(() =>
      loadServiceConfig({
        ...minimumEnvironment,
        CORS_ALLOWED_ORIGINS: "*",
      }),
    ).toThrow(/wildcard/i);
  });

  it("validates request-critical identifiers at startup", () => {
    expect(() =>
      loadServiceConfig({
        ...minimumEnvironment,
        GEMINI_SEARCH_MODEL: "models/gemini?key=bad",
      }),
    ).toThrow(/GEMINI_SEARCH_MODEL.*invalid/i);

    expect(() =>
      loadServiceConfig({
        ...minimumEnvironment,
        GEMINI_API_KEY: "invalid\nheader-value",
      }),
    ).toThrow(/GEMINI_API_KEY.*whitespace/i);

    expect(() =>
      loadServiceConfig({
        ...minimumEnvironment,
        APP_NAME: "unsafe\nheader",
      }),
    ).toThrow(/APP_NAME.*control/i);

    expect(
      loadServiceConfig({
        ...minimumEnvironment,
        GEMINI_SEARCH_MODEL: "models/gemini-2.5-flash",
      }).geminiSearchModel,
    ).toBe("gemini-2.5-flash");
  });
});
