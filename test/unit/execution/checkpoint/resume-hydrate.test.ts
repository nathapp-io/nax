/**
 * Resume-Hydrate Tests
 *
 * Tests for the new helpers introduced by the story
 * "Integrate Resume Into Story Orchestrator":
 *
 *   - `captureTreeState(workdir, deps)` returns a `TreeState` whose
 *     `headSha` equals the value from `captureGitRef` and whose
 *     `dirtyDigest` is derived from the `git status --porcelain`
 *     output (AC8). Uses `_gitDeps` injection for hermeticity.
 *
 *   - `hydrateFromResumePlan(plan, phaseOutputs)` seeds
 *     `phaseOutputs[phase] = { success: true }` for each
 *     `skipPhases` entry. After seeding, `phasePassed(phase, …)`
 *     returns true AND `extractPhaseFindings(phaseOutputs[phase])`
 *     returns `[]` — so a seeded phase carries no phantom findings
 *     and no phantom gate-failure keys (AC4 / AC7).
 *
 *   - `buildCheckpointLogData(storyId, …other)` returns a logger
 *     data object whose first key is `storyId` (AC9).
 *
 * Coverage matrix:
 *   AC4 — phasePassed({success:true}) → true; extractPhaseFindings → []
 *   AC7 — hydrateFromResumePlan seeds every entry from skipPhases
 *   AC8 — captureTreeState composes headSha + dirtyDigest from injected deps
 *   AC9 — checkpoint log data object lists storyId as the first key
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildResumePlan,
  buildCheckpointLogData,
  captureTreeState,
  extractPhaseFindings,
  hydrateFromResumePlan,
  phasePassed,
  type ResumePlan,
  type StoryCheckpoint,
  type TreeState,
} from "@/execution";

// _gitDeps is the project's injectable Bun.spawn seam. Tests must NOT depend
// on real git — we substitute a fake spawn and observe the args it receives.
import { _gitDeps } from "@/utils/git";

// ===========================================================================
// Test fixtures
// ===========================================================================

const TREE: TreeState = { headSha: "abc123def", dirtyDigest: "deadbeef01" };

function cp(greenPhases: PhaseKind[], tree: TreeState = TREE): StoryCheckpoint {
  return { storyId: "US-001", greenPhases, tree };
}

type PhaseKind =
  | "test-writer"
  | "greenfield-gate"
  | "implementer"
  | "test-presence-gate"
  | "full-suite-gate"
  | "mutation-check"
  | "verifier"
  | "verify-scoped"
  | "lint-check"
  | "typecheck-check"
  | "semantic-review"
  | "adversarial-review";

// ===========================================================================
// captureTreeState (AC8)
// ===========================================================================

/** Build a fake `_gitDeps.spawn` whose stdout is the given string. */
function mockSpawnOutput(stdout: string, exitCode = 0): ReturnType<typeof mock> {
  const bytes = new TextEncoder().encode(stdout);
  return mock((_args: string[], _opts: unknown) => ({
    stdout: new ReadableStream({ start(c) {
      c.enqueue(bytes);
      c.close();
    } }),
    stderr: new ReadableStream({ start(c) {
      c.close();
    } }),
    exited: Promise.resolve(exitCode),
    kill: mock(() => {}),
  }));
}

let origGitSpawn: typeof _gitDeps.spawn;
let tempDir: string | undefined;

beforeEach(() => {
  origGitSpawn = _gitDeps.spawn;
  tempDir = mkdtempSync(join(tmpdir(), "nax-resume-hydrate-"));
});

afterEach(() => {
  _gitDeps.spawn = origGitSpawn;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("captureTreeState (AC8)", () => {
  test("AC8: returns a TreeState whose headSha equals captureGitRef's value", async () => {
    // captureGitRef runs `git rev-parse HEAD` — fake that to return the sha.
    _gitDeps.spawn = mockSpawnOutput("deadbeef-head-sha\n");
    const state = await captureTreeState(tempDir!, { _deps: _gitDeps });
    expect(state.headSha).toBe("deadbeef-head-sha");
  });

  test("AC8: derives dirtyDigest from `git status --porcelain` output", async () => {
    // First spawn: `git rev-parse HEAD` → fake head sha.
    // Second spawn: `git status --porcelain` → fake dirty listing.
    const capturedArgs: string[][] = [];
    _gitDeps.spawn = mock((args: string[]) => {
      capturedArgs.push(args as string[]);
      const stdout =
        capturedArgs.length === 1
          ? "abc123\n"
          : " M src/foo.ts\n M src/bar.ts\n?? untracked.txt\n";
      const bytes = new TextEncoder().encode(stdout);
      return {
        stdout: new ReadableStream({ start(c) {
          c.enqueue(bytes);
          c.close();
        } }),
        stderr: new ReadableStream({ start(c) {
          c.close();
        } }),
        exited: Promise.resolve(0),
        kill: mock(() => {}),
      };
    });

    const state = await captureTreeState(tempDir!, { _deps: _gitDeps });

    // Must have called both `git rev-parse HEAD` and `git status --porcelain`.
    const calledRevParse = capturedArgs.some((a) => a.includes("rev-parse") && a.includes("HEAD"));
    const calledPorcelain = capturedArgs.some((a) => a.includes("status") && a.includes("--porcelain"));
    expect(calledRevParse).toBe(true);
    expect(calledPorcelain).toBe(true);

    // dirtyDigest is a stable hash of the porcelain output — exact format
    // is implementation-defined (crc32 / sha1-of-normalised-text), so we
    // assert shape instead: non-empty string, identical across two runs
    // of the same input.
    expect(typeof state.dirtyDigest).toBe("string");
    expect(state.dirtyDigest.length).toBeGreaterThan(0);

    const repeated = await captureTreeState(tempDir!, { _deps: _gitDeps });
    expect(repeated.dirtyDigest).toBe(state.dirtyDigest);
  });

  test("AC8: a clean working tree yields an empty/controlled dirtyDigest distinct from dirty output", async () => {
    // Track args to differentiate the two spawn calls.
    let callIndex = 0;
    let dirtyOutput = " M src/dirty.ts\n";
    _gitDeps.spawn = mock((_args: string[]) => {
      const bytes = new TextEncoder().encode(callIndex === 0 ? "cleanhead\n" : dirtyOutput);
      callIndex++;
      return {
        stdout: new ReadableStream({ start(c) {
          c.enqueue(bytes);
          c.close();
        } }),
        stderr: new ReadableStream({ start(c) {
          c.close();
        } }),
        exited: Promise.resolve(0),
        kill: mock(() => {}),
      };
    });

    const dirty = await captureTreeState(tempDir!, { _deps: _gitDeps });
    dirtyOutput = "";
    callIndex = 0;
    const clean = await captureTreeState(tempDir!, { _deps: _gitDeps });
    expect(clean.dirtyDigest).not.toBe(dirty.dirtyDigest);
  });

  test("#1521: rewriting an already-modified file (same porcelain status, different diff content) moves dirtyDigest", async () => {
    // `git status --porcelain` only lists filenames + status codes — it is
    // IDENTICAL for two edits to the same already-modified file. A resume
    // digest that hashes only that output cannot distinguish "nothing
    // changed since last attempt" from "the escalated agent rewrote the
    // file" — which made buildResumePlan return "resume" and elide the
    // implementer phase on every escalated retry. The fix folds `git diff`
    // (+ `git diff --cached`) content into the digest.
    const porcelain = " M src/foo.ts\n";
    let diffOutput = "diff --git a/src/foo.ts b/src/foo.ts\n-old line\n+new line v1\n";

    _gitDeps.spawn = mock((args: string[]) => {
      let stdout: string;
      if (args.includes("rev-parse")) {
        stdout = "abc123\n";
      } else if (args.includes("status")) {
        stdout = porcelain;
      } else if (args.includes("--cached")) {
        stdout = ""; // nothing staged
      } else {
        stdout = diffOutput; // `git diff`
      }
      const bytes = new TextEncoder().encode(stdout);
      return {
        stdout: new ReadableStream({ start(c) {
          c.enqueue(bytes);
          c.close();
        } }),
        stderr: new ReadableStream({ start(c) {
          c.close();
        } }),
        exited: Promise.resolve(0),
        kill: mock(() => {}),
      };
    });

    const first = await captureTreeState(tempDir!, { _deps: _gitDeps });

    // Simulate the escalated agent rewriting the same already-modified file:
    // `git status --porcelain` is unchanged (still just " M src/foo.ts"),
    // but the actual diff content differs.
    diffOutput = "diff --git a/src/foo.ts b/src/foo.ts\n-old line\n+new line v2 (rewritten by escalated agent)\n";
    const second = await captureTreeState(tempDir!, { _deps: _gitDeps });

    expect(first.dirtyDigest).not.toBe(second.dirtyDigest);
  });

  test("AC8 timeout: a hung git subprocess does not stall captureTreeState (proxy for gitWithTimeout enforcement)", async () => {
    // Adversarial-review finding: captureTreeState must not block on an
    // unkillable git subprocess. Every other git call in the project routes
    // through `gitWithTimeout` (src/utils/git.ts:45, GIT_TIMEOUT_MS=10_000)
    // which enforces a SIGKILL deadline. This test asserts the same invariant
    // via an unresolvable proc — the helper must return within a small
    // budget. The 200 ms ceiling is far below GIT_TIMEOUT_MS because the
    // helper either runs its own kill timer (true positive) or hangs forever
    // and the test's own timeout trips (true negative). With the source fix,
    // the helper's internal timeout-aborted proc.exited resolves and the
    // outer Promise.all completes; without it, this test times out.
    let killCalls = 0;
    _gitDeps.spawn = mock((_args: string[]) => {
      // proc.exited NEVER resolves — the hung-process scenario.
      // proc.kill is a spy; the helper (after fix) MUST call kill on the
      // hung proc to enforce its timeout budget.
      return {
        stdout: new ReadableStream({ start(c) {
          // Never enqueue — proc.stdout stays open.
          // Close is intentionally NOT called, mimicking a subprocess whose
          // stdout pipe is held open by the parent (the hung git binary).
        } }),
        stderr: new ReadableStream({ start(c) {
          c.close();
        } }),
        exited: new Promise<number>(() => {}),
        kill: mock(() => {
          killCalls++;
        }),
      };
    });

    const start = Date.now();
    // Race the helper against a 200 ms budget — captured by Promise.race.
    // If the helper hasn't returned by then, this test times out (Bun's
    // default per-test timeout is much larger, so the runner will report
    // the test as failed rather than deadlocking the suite). The race
    // gives us a deterministic failure mode even if the fix is missing.
    const timedCapture = async (): Promise<TreeState | "TIMEOUT"> => {
      return Promise.race<Promise<TreeState> | Promise<"TIMEOUT">>([
        captureTreeState(tempDir!, { _deps: _gitDeps }),
        new Promise<"TIMEOUT">((resolve) => setTimeout(() => resolve("TIMEOUT"), 200)),
      ]);
    };
    const result = await timedCapture();
    const elapsed = Date.now() - start;

    // Either captureTreeState resolved in time (good, the helper enforces
    // its own SIGKILL deadline on the hung proc) or it stalled (BAD — the
    // helper has no timeout guard).
    if (result === "TIMEOUT") {
      throw new Error(
        `captureTreeState stalled on hung git subprocess (no timeout guard) — elapsed=${elapsed}ms`,
      );
    }
    // Belt-and-braces: directly bound the elapsed time, even if the helper
    // resolves correctly today but starts hanging tomorrow.
    expect(elapsed).toBeLessThan(500);

    // Source-level invariant: the helper must call kill on hung procs
    // exactly the same way gitWithTimeout does (one signal per proc). With
    // the source fix, kill is invoked at least once across the two
    // subprocesses (rev-parse + status). Without the fix, it is never
    // invoked because the helper awaits an unresolvable exited Promise.
    expect(killCalls).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// hydrateFromResumePlan (AC4 + AC7)
// ===========================================================================

describe("hydrateFromResumePlan (AC4 + AC7)", () => {
  test("AC7: seeds phaseOutputs for every entry returned in plan.skipPhases", () => {
    const plan: ResumePlan = {
      skipPhases: ["test-writer", "implementer", "verifier"],
      revalidateGates: ["verify-scoped", "lint-check", "typecheck-check"],
      reason: "resume",
    };
    const phaseOutputs: Record<string, unknown> = {};
    hydrateFromResumePlan(plan, phaseOutputs);

    expect("test-writer" in phaseOutputs).toBe(true);
    expect("implementer" in phaseOutputs).toBe(true);
    expect("verifier" in phaseOutputs).toBe(true);
    // Cheap gates must NOT be seeded even though the plan ran.
    expect("verify-scoped" in phaseOutputs).toBe(false);
    expect("lint-check" in phaseOutputs).toBe(false);
    expect("typecheck-check" in phaseOutputs).toBe(false);
  });

  test("AC7: builds the plan via buildResumePlan and uses its skipPhases for seeding", () => {
    const checkpoint: StoryCheckpoint = {
      storyId: "US-007",
      greenPhases: ["test-writer", "implementer"],
      tree: TREE,
    };
    const plan = buildResumePlan(checkpoint, TREE);
    expect(plan.reason).toBe("resume");
    expect(plan.skipPhases).toEqual(["test-writer", "implementer"]);

    const phaseOutputs: Record<string, unknown> = {};
    hydrateFromResumePlan(plan, phaseOutputs);
    expect(Object.keys(phaseOutputs).sort()).toEqual(["implementer", "test-writer"]);
  });

  test("AC4: phasePassed returns true for a seeded phase output { success: true }", () => {
    const plan: ResumePlan = {
      skipPhases: ["implementer"],
      revalidateGates: ["verify-scoped", "lint-check", "typecheck-check"],
      reason: "resume",
    };
    const phaseOutputs: Record<string, unknown> = {};
    hydrateFromResumePlan(plan, phaseOutputs);

    const output = phaseOutputs["implementer"];
    expect(phasePassed("implementer", output, "US-001")).toBe(true);
  });

  test("AC4: extractPhaseFindings returns empty array for a seeded phase output", () => {
    const plan: ResumePlan = {
      skipPhases: ["implementer"],
      revalidateGates: ["verify-scoped", "lint-check", "typecheck-check"],
      reason: "resume",
    };
    const phaseOutputs: Record<string, unknown> = {};
    hydrateFromResumePlan(plan, phaseOutputs);

    const output = phaseOutputs["implementer"];
    expect(extractPhaseFindings(output)).toEqual([]);
  });

  test("AC4 boundary: a seeded phase carries no phantom gate-failure keys — extractPhaseFindings yields [] even for a gate phase", () => {
    // Even though we're not seeding gate phases in AC7, the contract is
    // about the output shape: a `{success:true}` object must produce
    // zero findings. Verify with a strict verdict phase.
    const plan: ResumePlan = {
      skipPhases: ["full-suite-gate"],
      revalidateGates: ["verify-scoped"],
      reason: "resume",
    };
    const phaseOutputs: Record<string, unknown> = {};
    hydrateFromResumePlan(plan, phaseOutputs);

    const output = phaseOutputs["full-suite-gate"];
    expect(extractPhaseFindings(output)).toEqual([]);
  });

  test("AC7 boundary: empty skipPhases is a no-op (no entries written to phaseOutputs)", () => {
    const phaseOutputs: Record<string, unknown> = {};
    hydrateFromResumePlan(
      { skipPhases: [], revalidateGates: ["verify-scoped", "lint-check", "typecheck-check"], reason: "no-checkpoint" },
      phaseOutputs,
    );
    expect(phaseOutputs).toEqual({});
  });
});

// ===========================================================================
// buildCheckpointLogData (AC9)
// ===========================================================================

describe("buildCheckpointLogData (AC9)", () => {
  test("AC9: data object lists storyId as the FIRST key when checkpoint metadata is included", () => {
    const data = buildCheckpointLogData({
      storyId: "US-042",
      phase: "test-writer",
      headSha: "abc123",
      dirtyDigest: "deadbeef",
      runId: "run-001",
    });

    const keys = Object.keys(data);
    expect(keys[0]).toBe("storyId");
  });

  test("AC9: when the input meta is constructed in a different key order, storyId is still first", () => {
    // Build the input by setting fields explicitly (so insertion order
    // is NOT storyId-first). The helper must enforce canonical order.
    const meta: Record<string, unknown> = {};
    meta.runId = "run-99";
    meta.headSha = "head-sha";
    meta.phase = "implementer";
    meta.storyId = "US-099";
    meta.dirtyDigest = "d";

    const data = buildCheckpointLogData(meta);
    expect(Object.keys(data)[0]).toBe("storyId");
  });

  test("AC9: helper returns an object — not undefined, not a string — so the caller can spread it", () => {
    const data = buildCheckpointLogData({
      storyId: "US-001",
      phase: "test-writer",
      headSha: "h",
      dirtyDigest: "d",
      runId: "run",
    });
    expect(typeof data).toBe("object");
    expect(data).not.toBeNull();
  });
});

// ===========================================================================
// Test sanity (unique-id generation)
// ===========================================================================

describe("test fixture sanity", () => {
  test("randomUUID produces distinct ids across iterations", () => {
    const a = randomUUID();
    const b = randomUUID();
    expect(a).not.toBe(b);
  });
});
