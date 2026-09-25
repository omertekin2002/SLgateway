import { afterEach, expect, it, vi } from "vitest";
import { loadServiceConfig } from "../src/config";
import { createRequestHandler } from "../src/handler";
import { clearPrimaryModelAvailabilityCache } from "../src/pipeline/provider-models";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  clearPrimaryModelAvailabilityCache();
});

function stream(events: unknown[]) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    {
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}
const start = {
  type: "response.created",
  response: { id: "r1", model: "test", created_at: 1 },
};
const finish = {
  type: "response.completed",
  response: { status: "completed" },
};
function answer(text: string) {
  return stream([
    start,
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "m1" },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      item_id: "m1",
      delta: text,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: "m1" },
    },
    finish,
  ]);
}
function readPage() {
  const call = {
    type: "function_call",
    id: "fc1",
    call_id: "c1",
    name: "read_url",
    arguments: '{"url":"https://source.test/page"}',
  };
  return stream([
    start,
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...call, arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: "fc1",
      delta: call.arguments,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { ...call, status: "completed" },
    },
    finish,
  ]);
}
const config = () =>
  loadServiceConfig({
    PRIMARY_LLM_BASE_URL: "https://primary.test/v1",
    PRIMARY_LLM_API_KEY: "test-only-secret",
    PRIMARY_LLM_MODEL: "test",
  });

it("keeps client media out of SDK preparation and the provider request", async () => {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models"))
        return Response.json({ data: [{ id: "test" }] });
      expect(url).toBe("https://primary.test/v1/responses");
      expect(String(init?.body)).not.toContain("127.0.0.1");
      expect(String(init?.body)).toContain("Prior answer");
      return answer("Follow-up answer");
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  const handler = createRequestHandler({ config: config(), log: () => {} });
  const response = await handler(
    request([
      { role: "user", content: "Previous question" },
      {
        role: "assistant",
        content: "Prior answer",
        agentMessages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "c1",
                toolName: "http_get",
                input: {},
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "c1",
                toolName: "http_get",
                output: {
                  type: "content",
                  value: [
                    {
                      type: "file-url",
                      mediaType: "text/plain",
                      url: "http://127.0.0.1/private",
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      { role: "user", content: "Follow up" },
    ]),
  );
  expect(response.status).toBe(200);
  expect((await response.json()).message).toBe("Follow-up answer");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
function request(messages: unknown[], stream = false, research = "auto") {
  return new Request("https://gateway.test/v1/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, stream, research }),
  });
}

it("runs the real HTTP + SDK + reader path and replays evidence on the next turn", async () => {
  const providerRequests: Array<Record<string, unknown>> = [];
  vi.stubEnv("OPENAI_CUSTOM_HEADERS", "X-Secret: unrelated-secret");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/models"))
        return Response.json({ data: [{ id: "test" }] });
      if (url.startsWith("https://r.jina.ai/")) {
        expect(new Headers(init?.headers).get("Authorization")).toBeNull();
        return Response.json({
          data: {
            title: "Source",
            content: "Verified source text",
            url: "https://wrong.test/",
          },
        });
      }
      expect(url).toBe("https://primary.test/v1/responses");
      expect(new Headers(init?.headers).get("X-Secret")).toBeNull();
      const body = JSON.parse(String(init?.body));
      providerRequests.push(body);
      return providerRequests.length === 1
        ? readPage()
        : answer("Verified answer [1]");
    }),
  );
  const log = vi.fn();
  const handler = createRequestHandler({ config: config(), log });
  const first = await handler(
    request([{ role: "user", content: "Read the page" }], false, "always"),
  );
  expect(first.status).toBe(200);
  const reply = await first.json();
  expect(reply.message).toContain("- [1] [Source](<https://source.test/page>)");
  expect(reply.readSources).toEqual([1]);
  expect(reply.toolActivity).toEqual([
    expect.objectContaining({ tool: "read_url", status: "complete" }),
  ]);
  expect(
    reply.agentMessages.some(
      (message: { role: string }) => message.role === "tool",
    ),
  ).toBe(true);
  expect(providerRequests[0]?.tool_choice).toBe("required");
  expect(providerRequests[0]?.store).toBe(false);
  expect(JSON.stringify(providerRequests[1]?.input)).toContain(
    "function_call_output",
  );
  const second = await handler(
    request([
      { role: "user", content: "Read the page" },
      {
        role: "assistant",
        content: reply.message,
        agentMessages: reply.agentMessages,
        webSources: reply.webSources,
      },
      { role: "user", content: "Explain the same source" },
    ]),
  );
  expect(second.status).toBe(200);
  const followup = await second.json();
  expect(followup.readSources).toEqual([]);
  expect(followup.message).toContain("- [1] [Source]");
  expect(JSON.stringify(providerRequests[2]?.input)).toContain(
    "Verified source text",
  );
  expect(JSON.stringify(log.mock.calls)).not.toMatch(
    /test-only-secret|Verified source text|Read the page/,
  );
});

it("streams tool activity before the canonical answer through the real HTTP boundary", async () => {
  let step = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/models"))
        return Response.json({ data: [{ id: "test" }] });
      if (url.startsWith("https://r.jina.ai/"))
        return Response.json({
          data: { title: "Source", content: "Fresh evidence" },
        });
      return step++ === 0 ? readPage() : answer("Answer [1]");
    }),
  );
  const handler = createRequestHandler({ config: config(), log: () => {} });
  const response = await handler(
    request([{ role: "user", content: "Read a page" }], true),
  );
  const events = (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events.map((event) => event.type)).toEqual([
    "tool",
    "tool",
    "delta",
    "done",
  ]);
  expect(events.at(-1).message).toContain("Sources:");
});

it("returns the stable strict-research error when the provider gives an unresearched answer", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/models")
        ? Response.json({ data: [{ id: "test" }] })
        : answer("Unsupported answer"),
    ),
  );
  const handler = createRequestHandler({ config: config(), log: () => {} });
  const response = await handler(
    request([{ role: "user", content: "Research this" }], false, "always"),
  );
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({
    error: "Grounded research is temporarily unavailable.",
    code: "research_unavailable",
  });
  const streamed = await handler(
    request([{ role: "user", content: "Research this" }], true, "always"),
  );
  expect(
    (await streamed.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toEqual([
    {
      type: "error",
      error: "Grounded research is temporarily unavailable.",
      code: "research_unavailable",
    },
  ]);
});
