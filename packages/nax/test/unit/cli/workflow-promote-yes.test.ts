/**
 * SPEC-workflow-record-promote US-005: `nax workflow promote --yes` — the four forge writes
 * (tick, comment, ready, record) that take a draft run's PR to ready.
 *
 * Every test enters through the `commander` program `registerWorkflowCommand` built, with
 * `WorkflowForgeDeps` stubbed by the shared draft-run fixture
 * (`test/helpers/workflow-promote-fixture.ts`), and asserts on the argv the forge stub received, the
 * report the command printed, the exit code and the sidecar on disk.
 */

import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  emittedError,
  emittedJson,
  makePromoteFixture,
  PROMOTE_FEATURE,
  PROMOTE_RUN_ID,
  PROMOTE_SHA,
  PROMOTE_SIDECAR_NAME,
  PROMOTE_URL,
  type PromoteFixture,
  prWrites,
  withTempDir,
} from "@test/helpers";

/** The action's `status` in the report, or a thrown error naming what the report held instead. */
function actionOf(report: Record<string, unknown>, name: string): string {
  const actions = report.actions;
  const found = Array.isArray(actions)
    ? actions.find((a) => typeof a === "object" && a !== null && (a as { name?: unknown }).name === name)
    : undefined;
  if (typeof found !== "object" || found === null) {
    throw new Error(`no ${name} action in ${JSON.stringify(actions)}`);
  }
  return String((found as { status?: unknown }).status);
}

/** The argv the stub received for a command whose first words are `prefix`, or undefined. */
function writeFor(calls: readonly (readonly string[])[], prefix: readonly string[]): readonly string[] | undefined {
  return calls.find((call) => prefix.every((word, i) => call[i] === word));
}

/** The `--body` / `-m` payload of a forge command line, or "" when it carries none. */
function payloadOf(argv: readonly string[] | undefined): string {
  const at = argv?.findIndex((word) => word === "--body" || word === "-m") ?? -1;
  return at === -1 ? "" : (argv?.[at + 1] ?? "");
}

/** Every `decisions-*.json` name the run directory holds. */
async function sidecarNames(runDir: string): Promise<string[]> {
  const names = await readdir(runDir);
  return names.filter((name) => name.startsWith("decisions-") && name.endsWith(".json"));
}

/** The sidecar the fixture wrote, as a required path — the tests that compare its bytes need one. */
function writtenSidecar(fx: PromoteFixture): string {
  if (fx.sidecarPath === undefined) throw new Error("the fixture wrote no sidecar");
  return fx.sidecarPath;
}

const DEFAULT_TICKED_LINE = "- [x] **B1** (important, finding) `src/a.ts:3` — B1 is broken — fixed in a1b2c3d";

describe("nax workflow promote --yes: the four actions", () => {
  test("AC-1: --yes edits the body, comments, marks ready then records promoted", async () => {
    await withTempDir(async (dir) => {
      const url = "https://gh/pr/9";
      const fx = await makePromoteFixture(dir, { url });
      await fx.run(["--yes", "--json"]);
      expect(prWrites(fx.forgeCalls).map((call) => call.slice(0, 3).join(" "))).toEqual([
        "gh pr edit",
        "gh pr comment",
        "gh pr ready",
      ]);
      const sidecar = await fx.sidecar();
      expect(sidecar?.outcome).toBe("promoted");
      expect(sidecar?.url).toBe(url);
      const report = emittedJson(fx.out);
      expect(report.promoted).toBe(true);
      expect(report.dryRun).toBe(false);
      expect(fx.codes).toEqual([0]);
    });
  });

  test("AC-2: the edit carries the ticked line and the comment opens the evidence section", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir);
      await fx.run(["--yes", "--json"]);
      const edit = writeFor(fx.forgeCalls, ["gh", "pr", "edit"]);
      const comment = writeFor(fx.forgeCalls, ["gh", "pr", "comment"]);
      expect(payloadOf(edit)).toContain(DEFAULT_TICKED_LINE);
      expect(payloadOf(comment).startsWith("## Resolved before ready")).toBe(true);
      expect(payloadOf(comment)).toContain("- B1 (finding) fixed: B1 ruled (a1b2c3d)");
    });
  });

  test("AC-3: a body with no checklist line for the ruled id skips the tick and edits nothing", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { body: "## Summary\n\nNothing to tick here.\n" });
      await fx.run(["--yes", "--json"]);
      expect(writeFor(fx.forgeCalls, ["gh", "pr", "edit"])).toBeUndefined();
      expect(actionOf(emittedJson(fx.out), "tick")).toBe("skipped");
      expect(fx.codes).toEqual([0]);
    });
  });

  test("AC-4: the tick rewrites the body the forge holds at that moment", async () => {
    await withTempDir(async (dir) => {
      const body = "- [ ] **B1** (important, finding) `src/a.ts:3` — B1 is broken";
      const fx = await makePromoteFixture(dir, {
        prViews: [
          { stdout: JSON.stringify({ isDraft: true, body, url: PROMOTE_URL }) },
          { stdout: JSON.stringify({ isDraft: true, body: `${body}\n\nA human note added later.`, url: PROMOTE_URL }) },
        ],
      });
      await fx.run(["--yes", "--json"]);
      expect(payloadOf(writeFor(fx.forgeCalls, ["gh", "pr", "edit"]))).toContain("A human note added later.");
    });
  });

  test("AC-5: an unruled open item exits 2 and leaves the PR and the sidecar alone", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { openItems: ["B1", "B2"], rulings: ["B1"] });
      const before = await Bun.file(writtenSidecar(fx)).text();
      await fx.run(["--yes", "--json"]);
      expect(fx.codes).toEqual([2]);
      expect(prWrites(fx.forgeCalls)).toEqual([]);
      expect(await Bun.file(writtenSidecar(fx)).text()).toBe(before);
    });
  });

  test("AC-6: failed CI exits 2 and writes none of the PR", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { ci: { outcome: "failed", detail: "a check failed" } });
      await fx.run(["--yes", "--json"]);
      expect(fx.codes).toEqual([2]);
      expect(prWrites(fx.forgeCalls)).toEqual([]);
    });
  });

  test("AC-7: a comment that fails stops the run before ready", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, {
        onRun: (argv) =>
          argv[0] === "gh" && argv[1] === "pr" && argv[2] === "comment"
            ? { exitCode: 1, stderr: "rate limited" }
            : undefined,
      });
      await fx.run(["--yes", "--json"]);
      expect(emittedError(fx.out)).toBe("promote stopped at comment: rate limited");
      expect(fx.codes).toEqual([1]);
      expect(writeFor(fx.forgeCalls, ["gh", "pr", "edit"])).toBeDefined();
      expect(writeFor(fx.forgeCalls, ["gh", "pr", "ready"])).toBeUndefined();
      expect(prWrites(fx.forgeCalls).filter((call) => call.includes("--ready"))).toEqual([]);
    });
  });

  test("AC-8: a ready that fails leaves the sidecar pending after the two earlier writes", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, {
        onRun: (argv) =>
          argv[0] === "gh" && argv[1] === "pr" && argv[2] === "ready"
            ? { exitCode: 1, stderr: "not mergeable" }
            : undefined,
      });
      await fx.run(["--yes", "--json"]);
      expect(emittedError(fx.out)).toBe("promote stopped at ready: not mergeable");
      expect(fx.codes).toEqual([1]);
      expect(prWrites(fx.forgeCalls).map((call) => call.slice(0, 3).join(" "))).toEqual([
        "gh pr edit",
        "gh pr comment",
        "gh pr ready",
      ]);
      expect((await fx.sidecar())?.outcome).toBe("pending");
    });
  });

  test("AC-9: a run with no sidecar gets one with no decisions, promoted and url'd", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { openItems: [], rulings: null });
      await fx.run(["--yes", "--json"]);
      expect(fx.sidecarPath).toBeUndefined();
      expect(await fx.sidecar()).toEqual({
        artifact: `${PROMOTE_RUN_ID}/result.json`,
        feature: PROMOTE_FEATURE,
        resumedAt: "2026-10-13T09-12-00-417Z",
        reasons: [],
        decisions: [],
        outcome: "promoted",
        url: PROMOTE_URL,
      });
      expect(await Bun.file(join(fx.runDir, PROMOTE_SIDECAR_NAME)).exists()).toBe(true);
    });
  });

  test("AC-10: an abandoned sidecar is rewritten to promoted, keeping its decisions", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { sidecarOutcome: "abandoned" });
      await fx.run(["--yes", "--json"]);
      const sidecar = await fx.sidecar();
      expect(sidecar?.outcome).toBe("promoted");
      expect(sidecar?.decisions).toEqual([
        { id: "B1", kind: "finding", disposition: "fixed", reason: "B1 ruled", sha: PROMOTE_SHA },
      ]);
      expect(await sidecarNames(fx.runDir)).toEqual([PROMOTE_SIDECAR_NAME]);
    });
  });
});

describe("nax workflow promote --yes (plain)", () => {
  test("a promoted run prints one line per check, one per action, then the result", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir);
      await fx.run(["--yes"]);
      expect(fx.out).toEqual([
        "pass  items-ruled",
        "pass  ci-green",
        "tick  done",
        "comment  done",
        "ready  done",
        "record  done",
        `promoted ${PROMOTE_URL}`,
      ]);
      expect(fx.err).toEqual([]);
      expect(fx.codes).toEqual([0]);
    });
  });

  test("a skipped tick and comment still print their lines", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { body: "Nothing to tick.\n" });
      await fx.run(["--yes"]);
      expect(fx.out.filter((line) => line === "tick  skipped" || line === "comment  done")).toEqual([
        "tick  skipped",
        "comment  done",
      ]);
      expect(fx.out.at(-1)).toBe(`promoted ${PROMOTE_URL}`);
    });
  });
});
