import { describe, expect, it } from "vitest";

import {
  parseResearchMode,
  shouldResearchLatestUserMessage,
  shouldResearchUserMessage,
} from "../src/pipeline/research-policy";

describe("research policy", () => {
  it.each([
    "Hello",
    "Reply with exactly: diagnostic ok.",
    "Rewrite this paragraph",
    "Explain recursion",
    "Tell me a joke",
  ])("skips ambiguous or conversational prompt: %s", (prompt) => {
    expect(shouldResearchUserMessage(prompt)).toBe(false);
  });

  it.each([
    "Search the web for this announcement",
    "Look up the latest release",
    "Research this and find sources",
    "Cite sources and include links",
    "What is the weather in Istanbul?",
    "What are today's football scores?",
    "Who is currently the prime minister of Canada?",
    "Were there recent changes to this law?",
  ])("enables research for explicit or volatile prompt: %s", (prompt) => {
    expect(shouldResearchUserMessage(prompt)).toBe(true);
  });

  it("examines only the latest user message", () => {
    expect(
      shouldResearchLatestUserMessage([
        { role: "user", content: "Find sources about recursion" },
        { role: "assistant", content: "What would you like next?" },
        { role: "user", content: "Tell me a joke" },
      ]),
    ).toBe(false);
  });

  it("defaults a missing mode to auto and rejects all other values", () => {
    expect(parseResearchMode(undefined)).toBe("auto");
    expect(parseResearchMode("auto")).toBe("auto");
    expect(parseResearchMode("always")).toBe("always");
    expect(parseResearchMode("never")).toBe("never");
    expect(parseResearchMode("sometimes")).toBeNull();
    expect(parseResearchMode(null)).toBeNull();
  });
});
