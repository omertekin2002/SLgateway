import { createHash, timingSafeEqual } from "node:crypto";

function digestSecret(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time secret comparison, including when the original lengths differ. */
export function timingSafeSecretEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(digestSecret(actual), digestSecret(expected));
}

export function getBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization) return null;

  const match = /^Bearer[\t ]+([^\s]+)[\t ]*$/i.exec(authorization);
  return match?.[1] ?? null;
}

export function hasValidServiceAuthorization(
  request: Request,
  expectedApiKey: string,
): boolean {
  const token = getBearerToken(request);
  return token !== null && timingSafeSecretEqual(token, expectedApiKey);
}

export type ReleaseSlot = () => void;

/** A deliberately per-process inference concurrency limiter. */
export class InferenceSemaphore {
  readonly limit: number;
  #active = 0;

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("Inference concurrency limit must be a positive integer");
    }
    this.limit = limit;
  }

  get active(): number {
    return this.#active;
  }

  tryAcquire(): ReleaseSlot | null {
    if (this.#active >= this.limit) return null;
    this.#active += 1;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
    };
  }
}
