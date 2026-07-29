import type { ChatMessage } from "./chat";

export const RESEARCH_MODES = ["auto", "always", "never"] as const;

export type ResearchMode = (typeof RESEARCH_MODES)[number];

/** Parse the public research field. Missing values preserve API compatibility through auto mode. */
export function parseResearchMode(value: unknown): ResearchMode | null {
  if (value === undefined) return "auto";
  return value === "auto" || value === "always" || value === "never"
    ? value
    : null;
}

const EXPLICIT_RESEARCH_SIGNAL =
  /\b(?:search(?:\s+(?:the\s+)?web|\s+online)?|look\s+up|research|find\s+(?:me\s+)?sources?|cite|citations?|sources?|links?)\b/iu;
const CURRENT_TIME_SIGNAL =
  /\b(?:latest|today|currently|current|recent|recently|right\s+now|as\s+of\s+(?:today|now|\d{4}))\b/iu;
const VOLATILE_SUBJECT_SIGNAL =
  /\b(?:weather|forecast|live\s+(?:price|prices|score|scores|results?)|stock\s+(?:price|prices|quote)|crypto(?:currency)?\s+(?:price|prices)|exchange\s+rates?|sports?\s+(?:score|scores|schedule)|standings|fixtures?|game\s+schedule|flight\s+(?:status|schedule)|current\s+(?:president|prime\s+minister|office\s+holder|ceo)|recent\s+(?:law|laws|legal|regulation|regulations|ruling|rulings)\s+(?:change|changes|update|updates)?)\b/iu;

/** Conservative, deterministic classifier for whether a single prompt needs web research. */
export function shouldResearchUserMessage(message: string): boolean {
  const normalized = message.replace(/\s+/gu, " ").trim();
  if (!normalized) return false;

  return (
    EXPLICIT_RESEARCH_SIGNAL.test(normalized) ||
    CURRENT_TIME_SIGNAL.test(normalized) ||
    VOLATILE_SUBJECT_SIGNAL.test(normalized)
  );
}

/** Inspect only the latest user turn; older research requests must not force later searches. */
export function shouldResearchLatestUserMessage(
  messages: readonly ChatMessage[],
): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") {
      return shouldResearchUserMessage(message.content);
    }
  }
  return false;
}
