import { describe, expect, it } from "vitest";
import { loadFixture } from "../support/load-fixture.ts";
import { drainFixture } from "../support/replay.ts";

describe("error path", () => {
  it("classifies a 429 as rate-limit and carries retry-after through", async () => {
    const events = await drainFixture(loadFixture("error-rate-limit"));
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    if (err?.type !== "error") throw new Error("no error event");
    expect(err.error.kind).toBe("rate-limit");
    expect(err.error.status).toBe(429);
    expect(err.error.retryAfter).toBe(30);
  });

  it("still reports usage the failed request burned", async () => {
    const events = await drainFixture(loadFixture("error-rate-limit"));
    const usage = events.find((e) => e.type === "usage");
    expect(usage).toBeDefined();
  });
});
