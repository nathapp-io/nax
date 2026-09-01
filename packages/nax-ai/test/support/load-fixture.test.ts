import { describe, expect, it } from "vitest";
import { fixtureNames, loadFixture } from "./load-fixture.ts";

describe("loadFixture", () => {
  it("reads a fixture's meta, response and events", () => {
    const f = loadFixture("example-text");
    expect(f.meta.protocol).toBe("openai-completions");
    expect(f.response.status).toBe(200);
    expect(f.events.length).toBeGreaterThan(0);
  });

  it("rejects a fixture carrying a header outside the allowlist", () => {
    expect(() => loadFixture("example-bad-header")).toThrow(/allowlist/);
  });

  it("lists every recorded fixture by name", () => {
    expect(fixtureNames()).toContain("example-text");
  });
});
