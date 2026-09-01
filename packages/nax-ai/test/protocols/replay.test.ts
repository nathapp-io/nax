import { describe, expect, it } from "vitest";
import { sequenceViolations } from "../support/conformance.ts";
import { fixtureNames, loadFixture } from "../support/load-fixture.ts";
import { drainFixture } from "../support/replay.ts";

// `example-bad-header` exists to prove the loader rejects it, so it is not
// replayable by construction.
const REPLAYABLE = fixtureNames().filter((n) => n !== "example-bad-header");

describe("recorded fixtures", () => {
  it("has at least one fixture per protocol", () => {
    const protocols = new Set(REPLAYABLE.map((n) => loadFixture(n).meta.protocol));
    expect([...protocols].sort()).toEqual(
      ["anthropic-messages", "openai-codex-responses", "openai-completions", "openai-responses"].sort(),
    );
  });

  for (const name of REPLAYABLE) {
    describe(name, () => {
      it("satisfies the protocol sequence contract", async () => {
        const fixture = loadFixture(name);
        const events = await drainFixture(fixture);

        // An error fixture legitimately ends in an error rather than done.
        if (fixture.response.status >= 400) {
          expect(events.at(-1)?.type).toBe("error");
          return;
        }

        // sequenceViolations always reports "emitted no text delta", because
        // it was written for the text case. A turn that only calls a tool has
        // no prose and is not in violation of anything, so that one line is
        // excused when a tool call is present. Excusing it structurally rather
        // than by fixture name keeps the rule true if fixtures are renamed.
        const hasToolCall = events.some((e) => e.type === "tool-call");
        const excused = hasToolCall ? new Set(["emitted no text delta"]) : new Set<string>();
        expect(sequenceViolations(events).filter((v) => !excused.has(v))).toEqual([]);
      });

      it("carries a note saying what it is evidence of", () => {
        expect(loadFixture(name).meta.note.length).toBeGreaterThan(20);
      });
    });
  }
});
