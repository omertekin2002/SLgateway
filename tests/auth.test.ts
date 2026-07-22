import { describe, expect, it } from "vitest";
import {
  InferenceSemaphore,
  hasValidServiceAuthorization,
  timingSafeSecretEqual,
} from "../src/auth";

describe("service authentication", () => {
  it("accepts exactly the configured Bearer secret", () => {
    const request = new Request("http://service.test/v1/chat", {
      headers: { Authorization: "Bearer expected-secret" },
    });

    expect(hasValidServiceAuthorization(request, "expected-secret")).toBe(true);
    expect(hasValidServiceAuthorization(request, "different-secret")).toBe(
      false,
    );
  });

  it("rejects missing and malformed authorization", () => {
    expect(
      hasValidServiceAuthorization(
        new Request("http://service.test/v1/chat"),
        "expected-secret",
      ),
    ).toBe(false);
    expect(
      hasValidServiceAuthorization(
        new Request("http://service.test/v1/chat", {
          headers: { Authorization: "Basic expected-secret" },
        }),
        "expected-secret",
      ),
    ).toBe(false);
  });

  it("compares secrets safely even when their lengths differ", () => {
    expect(timingSafeSecretEqual("short", "a-much-longer-secret")).toBe(false);
    expect(timingSafeSecretEqual("same", "same")).toBe(true);
  });
});

describe("InferenceSemaphore", () => {
  it("rejects excess work and releases each slot once", () => {
    const semaphore = new InferenceSemaphore(1);
    const release = semaphore.tryAcquire();

    expect(release).not.toBeNull();
    expect(semaphore.active).toBe(1);
    expect(semaphore.tryAcquire()).toBeNull();

    release?.();
    release?.();
    expect(semaphore.active).toBe(0);
    expect(semaphore.tryAcquire()).not.toBeNull();
  });
});
