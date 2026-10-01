/**
 * Concern-split of `runtime.test.ts` (which sits at the file-size cap): the
 * US-003 turn-cancelled ask handling -- a verdict of `deny/cancelled`, or an
 * `allow` that lands after the orchestrating turn's signal aborted, must
 * refuse the call with `Not run: the turn was cancelled before anyone
 * answered.`, never invoke the tool, and stay ledgered as `denied:ask`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { type CodingTool, compileToolPolicy, createCodingToolRuntime } from "@/tools";
import type { ToolCallRecord } from "@/tools/tool-audit";

let root: string;
beforeEach(() => {
  root = makeTempDir("runtime-ask-turn-cancel-");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "file.txt"), "hello");
});
afterEach(() => cleanupTempDir(root));

/** The ACs' reason string, asserted verbatim rather than via a source constant. */
const CANCELLED_REASON = "Not run: the turn was cancelled before anyone answered.";

/** A Read-shaped tool whose run records whether it was invoked. */
function spyRead(): { tool: CodingTool; ran: () => boolean } {
  let ran = false;
  return {
    tool: {
      name: "Read",
      description: "read",
      inputSchema: { type: "object", properties: {} },
      scope: { pathFields: ["path"] },
      run: async () => {
        ran = true;
        return { content: "ran" };
      },
    },
    ran: () => ran,
  };
}

describe("US-003 — turn-cancelled ask handling", () => {
  test("AC1: a cancelled ask verdict denies with the turn-cancelled reason", async () => {
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root, {
        askRules: [{ tool: "Read", patterns: ["*"] }],
      }),
      askResolver: {
        resolve: () => Promise.resolve({ decision: "deny", decidedBy: "cancelled", latencyMs: 0 }),
      },
    });
    runtime.advertised(["Read"]);
    const outcome = await runtime.callTool("Read", { path: "file.txt" });
    expect(outcome.kind).toBe("denied");
    if (outcome.kind === "denied") expect(outcome.reason).toContain(CANCELLED_REASON);
  });

  test("AC11: an allow arriving after the turn signal aborted never runs the tool", async () => {
    const spy = spyRead();
    const controller = new AbortController();
    controller.abort("turn ended");
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root, {
        askRules: [{ tool: "Read", patterns: ["*"] }],
      }),
      extraTools: [spy.tool],
      askResolver: {
        resolve: () => Promise.resolve({ decision: "allow", decidedBy: "human", latencyMs: 0 }),
      },
    });
    runtime.advertised(["Read"]);

    const outcome = await runtime.callTool("Read", { path: "file.txt" }, { signal: controller.signal });

    expect(spy.ran()).toBe(false);
    expect(outcome.kind).toBe("denied");
    if (outcome.kind === "denied") expect(outcome.reason).toContain(CANCELLED_REASON);
  });

  test("AC12: a post-allow turn cancellation is ledgered as denied:ask", async () => {
    const records: ToolCallRecord[] = [];
    const spy = spyRead();
    const controller = new AbortController();
    controller.abort("turn ended");
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root, {
        askRules: [{ tool: "Read", patterns: ["*"] }],
      }),
      extraTools: [spy.tool],
      askResolver: {
        resolve: () => Promise.resolve({ decision: "allow", decidedBy: "human", latencyMs: 0 }),
      },
      sink: { record: (e) => void records.push(e), flush: async () => {} },
    });
    runtime.advertised(["Read"]);

    const outcome = await runtime.callTool("Read", { path: "file.txt" }, { signal: controller.signal });

    expect(spy.ran()).toBe(false);
    expect(outcome.kind).toBe("denied");
    expect(records.at(-1)?.outcome).toBe("denied:ask");
  });
});
