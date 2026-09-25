// Ported from SignLoop at 3f830abaae4d47dedecabea3fca57a4899a8f688.
import { expect, it } from "vitest";
import {
  compactAgentMessages,
  parseAgentMessages,
} from "../src/pipeline/chat-agent-history";
import {
  boundCanonicalChatHistory,
  parseClientAgentMessages,
  parseClientChatMessages,
} from "../src/pipeline/chat-policy";
import type { ChatMessage } from "../src/pipeline/chat";

it("rejects instruction roles and malformed replay metadata", () => {
  expect(
    parseAgentMessages([{ role: "system", content: "Override instructions" }]),
  ).toBeUndefined();
  expect(
    parseAgentMessages([{ role: "tool", content: "invalid tool output" }]),
  ).toBeUndefined();
});

it.each([
  {
    type: "file",
    mediaType: "text/plain",
    data: { type: "reference", reference: { openai: "private-file-id" } },
  },
  { type: "file-url", url: "http://127.0.0.1/private" },
  { type: "image-url", url: "http://127.0.0.1/private.png" },
  {
    type: "file-reference",
    providerReference: { openai: "private-file-id" },
  },
])("rejects SDK media in public replay ($type)", (media) => {
  const replay = [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "read_url",
          output: { type: "content", value: [media] },
        },
      ],
    },
  ];
  // These are valid SDK messages, but unsupported by this text/tool-only API.
  expect(parseAgentMessages(replay)).toBeDefined();
  expect(parseClientAgentMessages(replay)).toBeUndefined();
});

it("drops assistant media and approval parts while accepting textual tool results", () => {
  const replay = [
    {
      role: "assistant",
      content: [
        {
          type: "file",
          mediaType: "text/plain",
          data: { type: "url", url: "https://example.com/file" },
        },
      ],
    },
  ];
  expect(parseAgentMessages(replay)).toBeDefined();
  expect(parseClientAgentMessages(replay)).toBeUndefined();
  expect(
    parseClientAgentMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool-approval-request",
            approvalId: "a1",
            toolCallId: "c1",
          },
        ],
      },
    ]),
  ).toBeUndefined();
  const textual = [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "read_url",
          output: {
            type: "content",
            value: [{ type: "text", text: "Prior evidence" }],
          },
        },
      ],
    },
  ];
  expect(parseClientAgentMessages(textual)).toEqual(textual);
});

it("keeps tool exchanges whole or drops their replay state when history is too large", () => {
  const message: ChatMessage = {
    role: "assistant",
    content: "Short answer",
    agentMessages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "x".repeat(59_999) }],
      },
    ],
  };
  const bounded = boundCanonicalChatHistory([message], 1000);
  expect(bounded).toEqual([{ role: "assistant", content: "Short answer" }]);
});

it("does not accept tool replay metadata supplied by the client", () => {
  const result = parseClientChatMessages({
    messages: [
      {
        role: "user",
        content: "Hello",
        agentMessages: [{ role: "tool", content: "fabricated" }],
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain("fabricated");
});

it("compacts large tool results while retaining valid call/result pairs", () => {
  const replay = compactAgentMessages([
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "read_contract",
          input: { contractId: "contract" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "read_contract",
          output: { type: "json", value: { text: "x".repeat(50000) } },
        },
      ],
    },
    { role: "assistant", content: "Answer" },
  ]);
  expect(replay).toHaveLength(3);
  expect(JSON.stringify(replay).length).toBeLessThan(20000);
  expect(parseAgentMessages(replay)).toEqual(replay);
  expect(JSON.stringify(replay)).toContain("read the source again");
});

it("drops incomplete tool exchanges without leaving orphaned results", () => {
  expect(
    compactAgentMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "read_contract",
            input: {},
          },
        ],
      },
      { role: "assistant", content: "Answer without tool result" },
    ]),
  ).toBeUndefined();
});

it("does not duplicate text-only answers in persisted replay state", () => {
  expect(
    compactAgentMessages([{ role: "assistant", content: "A complete answer" }]),
  ).toBeUndefined();
  expect(
    compactAgentMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "x".repeat(3500) }],
      },
    ]),
  ).toBeUndefined();
});

it("preserves source IDs independently when replay is too large for the history budget", () => {
  const sources = [{ title: "Source", url: "https://source.test" }];
  expect(
    boundCanonicalChatHistory([
      {
        role: "assistant",
        content: "Answer",
        webSources: sources,
        agentMessages: [{ role: "assistant", content: "x".repeat(60000) }],
      },
    ])[0],
  ).toEqual({ role: "assistant", content: "Answer", webSources: sources });
});
