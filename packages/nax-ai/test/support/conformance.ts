/**
 * Contract every Protocol backend must satisfy.
 *
 * Run against each registered backend. A hand-written backend inherits these
 * the day it is created, which is what keeps "replace a protocol" a bounded
 * task rather than an open-ended one.
 *
 * Assertions here are sequence invariants, never provider content: model output
 * varies between runs and is not assertable.
 */

import { describe, expect, it } from "vitest";
import type { Protocol, ProtocolEvent } from "../../src/protocols/types.ts";

export interface ConformanceCase {
  readonly name: string;
  readonly request: Parameters<Protocol["stream"]>[0];
}

/**
 * The sequence invariants below, as pure checks over an event list. The suite
 * asserts on these and the self-test drains through them, so the fused logic
 * lives in exactly one place — a future edit that vacuous weakens the suite's
 * assertions also weakens the self-test and gets caught.
 */
export function sequenceViolations(events: readonly ProtocolEvent[]): string[] {
  const violations: string[] = [];

  // Done is terminal: exactly one done event, and it is last.
  const doneIndexes = events.flatMap((e, i) => (e.type === "done" ? [i] : []));
  if (doneIndexes.length !== 1 || doneIndexes[0] !== events.length - 1) {
    violations.push("ended without exactly one done event, and done must be last");
  }

  // Usage precedes done.
  const usageIndex = events.findIndex((e) => e.type === "usage");
  const doneIndex = events.findIndex((e) => e.type === "done");
  if (usageIndex < 0 || doneIndex < 0 || usageIndex >= doneIndex) {
    violations.push("usage must precede done");
  }

  // A text request must produce text.
  if (!events.some((e) => e.type === "text-delta")) {
    violations.push("emitted no text delta");
  }

  // Token counts are non-negative.
  const usage = events.find((e) => e.type === "usage");
  if (usage?.type === "usage" && (usage.usage.inputTokens < 0 || usage.usage.outputTokens < 0)) {
    violations.push("reported a negative token count");
  }

  // An error is terminal even though it is an event.
  const errorIndex = events.findIndex((e) => e.type === "error");
  if (errorIndex >= 0 && errorIndex !== events.length - 1) {
    violations.push("emitted events after an error");
  }

  return violations;
}

async function drain(protocol: Protocol, req: ConformanceCase["request"]): Promise<ProtocolEvent[]> {
  const events: ProtocolEvent[] = [];
  for await (const event of protocol.stream(req)) events.push(event);
  return events;
}

export function runProtocolConformance(
  suiteName: string,
  makeProtocol: () => Promise<Protocol>,
  cases: { readonly text: ConformanceCase; readonly tool?: ConformanceCase },
): void {
  describe(`${suiteName} conformance`, () => {
    it("exposes a non-empty name", async () => {
      const protocol = await makeProtocol();
      expect(protocol.name).toBeTruthy();
    });

    it("ends with exactly one done event, and it is last", async () => {
      const events = await drain(await makeProtocol(), cases.text.request);
      expect(sequenceViolations(events)).not.toContain("ended without exactly one done event, and done must be last");
    });

    it("emits usage before done", async () => {
      const events = await drain(await makeProtocol(), cases.text.request);
      expect(sequenceViolations(events)).not.toContain("usage must precede done");
    });

    it("emits at least one text delta for a text request", async () => {
      const events = await drain(await makeProtocol(), cases.text.request);
      expect(sequenceViolations(events)).not.toContain("emitted no text delta");
    });

    it("reports non-negative token counts", async () => {
      const events = await drain(await makeProtocol(), cases.text.request);
      expect(sequenceViolations(events)).not.toContain("reported a negative token count");
    });

    it("emits no events after an error", async () => {
      // An error is terminal for the stream even though it is an event.
      const events = await drain(await makeProtocol(), cases.text.request);
      expect(sequenceViolations(events)).not.toContain("emitted events after an error");
    });

    if (cases.tool !== undefined) {
      const toolCase = cases.tool;

      it("emits parsed tool calls, never raw strings", async () => {
        const events = await drain(await makeProtocol(), toolCase.request);
        const calls = events.filter((e) => e.type === "tool-call");
        expect(calls.length).toBeGreaterThan(0);
        for (const event of calls) {
          if (event.type !== "tool-call") throw new Error("unreachable");
          expect(typeof event.call.input).not.toBe("string");
          expect(event.call.id).toBeTruthy();
          expect(event.call.name).toBeTruthy();
        }
      });

      it("emits any tool-call-partial before the matching tool-call", async () => {
        const events = await drain(await makeProtocol(), toolCase.request);
        const firstFinal = events.findIndex((e) => e.type === "tool-call");
        const lastPartial = events.map((e) => e.type).lastIndexOf("tool-call-partial");
        if (lastPartial >= 0) expect(lastPartial).toBeLessThan(firstFinal);
      });

      it("reports stopReason tool_use when tool calls were emitted", async () => {
        const events = await drain(await makeProtocol(), toolCase.request);
        const done = events.at(-1);
        if (done?.type !== "done") throw new Error("stream did not end with done");
        expect(done.stopReason).toBe("tool_use");
      });
    }
  });
}
