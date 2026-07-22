import { describe, expect, it } from "vitest";

import { loadServiceConfig } from "../src/config";
import { createRequestHandler } from "../src/handler";

const runLiveTests = process.env.RUN_LIVE_TESTS === "1";

describe.skipIf(!runLiveTests)("live provider smoke test", () => {
  it(
    "returns a grounded response through the configured generation path",
    async () => {
      const config = loadServiceConfig(process.env);
      const handler = createRequestHandler({ config, log: () => {} });
      const response = await handler(
        new Request("http://service.test/v1/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messages: [
              {
                role: "user",
                content:
                  "In one sentence, state today's UTC date and cite a current source.",
              },
            ],
            stream: false,
          }),
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.message).toEqual(expect.any(String));
      expect(body.provider).toMatch(/^(primary-openai-compatible|openrouter)$/);
      expect(body.model).toEqual(expect.any(String));
      expect(body.webSources).toEqual(expect.arrayContaining([expect.any(Object)]));
    },
    240_000,
  );
});
