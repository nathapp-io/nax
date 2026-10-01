import { describe, expect, it } from "vitest";
import { loadFixture } from "./load-fixture.ts";
import { drainFixture, protocolFromFixture } from "./replay.ts";

describe("replay harness", () => {
  it("maps a recorded stream to protocol events", async () => {
    const events = await drainFixture(loadFixture("example-text"));
    expect(events.map((e) => e.type)).toEqual(["text-delta", "usage", "done"]);
  });

  it("yields a fresh stream on every call, so one fixture drives many assertions", async () => {
    const f = loadFixture("example-text");
    const a = await drainFixture(f);
    const b = await drainFixture(f);
    expect(a).toEqual(b);
  });

  it("names the protocol from the fixture", () => {
    expect(protocolFromFixture(loadFixture("example-text")).name).toBe("openai-completions");
  });
});
