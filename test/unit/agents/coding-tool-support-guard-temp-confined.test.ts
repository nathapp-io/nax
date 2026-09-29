/**
 * US-004 — the session's sandbox state reaches the command guard's temp-only
 * exemption through `buildCodingToolSupport`.
 *
 * `isTempConfined(launcher)` is true exactly when the launcher is available
 * AND `sharedTmp === false`: only then are temp writes confined to this run's
 * own temp root, which is the condition under which the guard may skip the
 * classifier for a temp-only command. Every other launcher state — an
 * available one without `sharedTmp`, and a disabled one — must read as not
 * confined, so the classifier is consulted as before.
 *
 * Driven through `buildCodingToolSupport -> runtime.callTool` with a STUB
 * launcher and a recording guard, so nothing is spawned, classified or
 * written: the assertion is on the `GuardInput` the real Bash tool's allowed
 * call produces.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { cleanupTempDir, makeCommandShadowRecorder, makeTempDir } from "@test/helpers";
import { buildCodingToolSupport, type CodingToolSupport } from "@/agents/coding-tool-support";
import type { CommandGuard, CommandShadow, GuardDecision, GuardInput } from "@/command-safety";
import { type CommandLauncher, DISABLED_SANDBOX_STATE, type SandboxState } from "@/sandbox";

let root: string;

beforeEach(() => {
  root = realpathSync(makeTempDir("cs-guard-support-"));
});

afterEach(() => {
  cleanupTempDir(root);
});

/** The guard fixture's unflagged answer: identical in all three sandbox states. */
const NOT_FLAGGED: GuardDecision = { flagged: false, score: 0.055, threshold: 0.75, basis: "model" };

/**
 * A launcher that answers every run instead of performing it — modelled on
 * `coding-tool-support-sandbox-wrapped.test.ts`'s stub, so the raw screen is
 * exercised without spawning anything.
 */
function stubLauncher(state: SandboxState): CommandLauncher {
  return {
    state,
    run: async (req) => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      executed: req.spec.kind === "shell" ? [req.spec.shell, "-c", req.spec.command] : req.spec.argv,
      sandbox: { backend: "none", wrapped: false },
    }),
  };
}

/** A guard answering `decision` and recording every `assess` input. */
function guardRecorder(decision: GuardDecision): { shadow: CommandShadow; calls: GuardInput[] } {
  const calls: GuardInput[] = [];
  const guard: CommandGuard = {
    threshold: decision.threshold,
    assess: async (input) => {
      calls.push(input);
      return decision;
    },
  };
  return { shadow: makeCommandShadowRecorder({ guard }).shadow, calls };
}

/** Raw Bash with a wildcard grant and the guard under test. */
function supportFor(launcher: CommandLauncher, commandShadow: CommandShadow): CodingToolSupport {
  const support = buildCodingToolSupport({
    root,
    declared: ["Bash"],
    grants: [{ tool: "Bash", patterns: ["*"] }],
    bashApproval: "raw",
    launcher,
    commandShadow,
  });
  if (support === undefined) throw new Error("expected coding-tool support for a raw Bash grant");
  return support;
}

describe("buildCodingToolSupport — temp confinement into the guard (US-004)", () => {
  test("AC14: an available launcher with sharedTmp false reads as temp-confined", async () => {
    const launcher = stubLauncher({ kind: "available", backend: "srt", network: "open", sharedTmp: false });
    const { shadow, calls } = guardRecorder(NOT_FLAGGED);

    const out = await supportFor(launcher, shadow).runtime.callTool("Bash", { command: "ls" });

    expect(out.kind).toBe("ok");
    expect(calls).toEqual([{ command: "ls", cwd: root, tempConfined: true }]);
  });

  test("AC15: an available launcher without a sharedTmp field reads as not confined", async () => {
    const launcher = stubLauncher({ kind: "available", backend: "srt", network: "open" });
    const { shadow, calls } = guardRecorder(NOT_FLAGGED);

    const out = await supportFor(launcher, shadow).runtime.callTool("Bash", { command: "ls" });

    expect(out.kind).toBe("ok");
    expect(calls).toEqual([{ command: "ls", cwd: root, tempConfined: false }]);
  });

  test("AC16: a disabled launcher reads as not confined", async () => {
    const launcher = stubLauncher(DISABLED_SANDBOX_STATE);
    const { shadow, calls } = guardRecorder(NOT_FLAGGED);

    const out = await supportFor(launcher, shadow).runtime.callTool("Bash", { command: "ls" });

    expect(out.kind).toBe("ok");
    expect(calls).toEqual([{ command: "ls", cwd: root, tempConfined: false }]);
  });
});
