import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERSONALITY_MODE,
  isAllowedPersonalityMode,
  PERSONALITY_OPTIONS,
} from "../src/pipeline/personality";

describe("personality policy", () => {
  it("defaults to SignLoop and allows only the two server-supported modes", () => {
    expect(DEFAULT_PERSONALITY_MODE).toBe("signloop-assistant");
    expect(PERSONALITY_OPTIONS).toEqual(["bare-llm", "signloop-assistant"]);
    expect(isAllowedPersonalityMode("signloop-assistant")).toBe(true);
    expect(isAllowedPersonalityMode("bare-llm")).toBe(true);
    expect(isAllowedPersonalityMode("client-system-prompt")).toBe(false);
  });
});
