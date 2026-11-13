/**
 * spec ci-starved-checks US-008: `nax workflow promote --waive-starved <reason>` — the reason
 * validated before the run is loaded, the `ci-green` check that passes a starved CI and prints what
 * it waived, and the `waiver` action that records the decision on the PR between `comment` and
 * `ready`.
 *
 * Every test enters through the `commander` program `registerWorkflowCommand` built, with
 * `WorkflowForgeDeps` stubbed by the shared draft-run fixture
 * (`test/helpers/workflow-promote-fixture.ts`): the CI wait answers whatever the test needs, so a
 * test states only the one thing it varies.
 */

import { describe, expect, test } from "bun:test";
import {
  checkOf,
  emittedError,
  emittedJson,
  makePromoteFixture,
  PROMOTE_GREEN,
  PROMOTE_HEAD,
  PROMOTE_URL,
  type PromoteFixture,
  prWrites,
  withTempDir,
} from "@test/helpers";
import { NaxError } from "@/errors";
import type { CiWaitResult } from "@/workflow/ci-wait";
import { parseCiWaiver, parseWaiverReason } from "@/workflow/ci-waiver";

const STARVATION = "runner starvation";
/** A wait that ended starved on check `x`, in the shape US-002 reports. */
const STARVED: CiWaitResult = {
  outcome: "starved",
  detail: "1 check(s) never got a runner: x; re-run them, or accept with --waive-starved <reason>",
  starvedChecks: ["x"],
};
const FAILED: CiWaitResult = { outcome: "failed", detail: "CI failed: x" };
/** A starved wait that named no check: the shape no waiver record may certify (M16). */
const STARVED_NO_CHECKS: CiWaitResult = { outcome: "starved", detail: "0 check(s) never got a runner" };
/** The head the PR reports after a push during the waiver write. */
const MOVED_HEAD = "f".repeat(40);
/** Every reason `parseWaiverReason` refuses: empty, multiline, over-length and marker-bearing. */
const INVALID_REASONS: readonly string[] = ["", "a\nb", "x".repeat(301), "runner <!--holding--> starvation"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `--body` / `-m` payload of a forge command line, or "" when it carries none. */
function payloadOf(argv: readonly string[]): string {
  const at = argv.findIndex((word) => word === "--body" || word === "-m");
  return at === -1 ? "" : (argv[at + 1] ?? "");
}

/** The waiver comment the forge received: the one comment line whose body reads back as a waiver. */
function waiverArgv(fx: PromoteFixture): readonly string[] | undefined {
  return fx.forgeCalls.find((call) => parseCiWaiver(payloadOf(call)) !== null);
}

/** A write command whose first words are `prefix`, or undefined when the command never ran it. */
function writeFor(calls: readonly (readonly string[])[], prefix: readonly string[]): readonly string[] | undefined {
  return calls.find((call) => prefix.every((word, i) => call[i] === word));
}

/** The report's action names, in the order the actions ran. */
function actionNames(report: Record<string, unknown>): string[] {
  const actions = report.actions;
  if (!Array.isArray(actions)) throw new Error(`no actions in ${JSON.stringify(actions)}`);
  return actions.map((action) => {
    if (!isRecord(action) || typeof action.name !== "string") {
      throw new Error(`not an action: ${JSON.stringify(action)}`);
    }
    return action.name;
  });
}

/** The `status` of one named action in the report. */
function statusOf(report: Record<string, unknown>, name: string): string {
  const actions = report.actions;
  const found = Array.isArray(actions) ? actions.find((action) => isRecord(action) && action.name === name) : undefined;
  if (!isRecord(found)) throw new Error(`no ${name} action in ${JSON.stringify(actions)}`);
  return String(found.status);
}

/** The error `parseWaiverReason` refuses `raw` with, so the command's refusal is compared to it. */
function refusalOf(raw: string): NaxError {
  try {
    parseWaiverReason(raw);
  } catch (err) {
    if (err instanceof NaxError) return err;
    throw err;
  }
  throw new Error(`parseWaiverReason accepted ${JSON.stringify(raw)}`);
}

/** The sidecar the fixture wrote, as a required path — the tests comparing its bytes need one. */
function writtenSidecar(fx: PromoteFixture): string {
  if (fx.sidecarPath === undefined) throw new Error("the fixture wrote no sidecar");
  return fx.sidecarPath;
}

describe("nax workflow promote --waive-starved: the reason", () => {
  test("AC-1: a multiline reason exits 1 before the run is loaded", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir);
      await fx.run(["--waive-starved", "a\nb"]);
      expect(fx.codes).toEqual([1]);
      expect(fx.resolveOutputDirCalls).toEqual([]);
      expect(fx.checkCalls).toEqual([]);
    });
  });

  test.each([...INVALID_REASONS])("AC-12: %p is refused before any forge call", async (raw) => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir);
      await fx.run(["--waive-starved", raw]);
      const refusal = refusalOf(raw);
      expect(refusal.code).toBe("CI_WAIVER_REASON_INVALID");
      expect(fx.err).toEqual([refusal.message]);
      expect(fx.codes).toEqual([1]);
      expect(fx.resolveOutputDirCalls).toEqual([]);
      expect(fx.forgeCalls).toEqual([]);
      expect(fx.checkCalls).toEqual([]);
    });
  });

  test("AC-2: the promote check is one poll that never re-runs a starved job", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { ci: STARVED });
      await fx.run(["--waive-starved", STARVATION]);
      expect(fx.checkOptions).toHaveLength(1);
      expect("rerunStarved" in (fx.checkOptions[0] ?? {})).toBe(false);
    });
  });
});

describe("nax workflow promote: the ci-green check under a waiver", () => {
  test("AC-3: a starved CI passes when the reason is given, with the waived checks as detail", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { ci: STARVED });
      await fx.run(["--waive-starved", STARVATION, "--json"]);
      expect(checkOf(emittedJson(fx.out), "ci-green")).toEqual({ passed: true, detail: "waived: x" });
      expect(fx.codes).toEqual([0]);
    });
  });

  test("AC-4: without --yes the waiver is a report: no forge write, and the detail prints", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { ci: STARVED });
      await fx.run(["--waive-starved", STARVATION]);
      expect(prWrites(fx.forgeCalls)).toEqual([]);
      expect(fx.out).toContain("pass  ci-green  waived: x");
      expect(fx.codes).toEqual([0]);
    });
  });

  test("AC-10: without the flag a starved CI fails the check", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { ci: STARVED });
      await fx.run(["--json"]);
      const check = checkOf(emittedJson(fx.out), "ci-green");
      expect(check.passed).toBe(false);
      expect(check.detail).toStartWith("ci starved:");
      expect(fx.codes).toEqual([2]);
    });
  });

  test("AC-11: a waiver never covers a failed CI", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { ci: FAILED });
      await fx.run(["--waive-starved", STARVATION, "--json"]);
      const check = checkOf(emittedJson(fx.out), "ci-green");
      expect(check.passed).toBe(false);
      expect(check.detail).toStartWith("ci failed:");
      expect(fx.codes).toEqual([2]);
    });
  });
});

describe("nax workflow promote --yes: the waiver action", () => {
  test("AC-5: the actions are tick, comment, waiver, ready, record and the waiver is done", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { ci: STARVED });
      await fx.run(["--waive-starved", STARVATION, "--yes", "--json"]);
      const report = emittedJson(fx.out);
      expect(actionNames(report)).toEqual(["tick", "comment", "waiver", "ready", "record"]);
      expect(statusOf(report, "waiver")).toBe("done");
      expect(fx.codes).toEqual([0]);
    });
  });

  test("AC-6: the waiver action posts commentArgv naming the head, the starved check and the reason", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { ci: STARVED });
      await fx.run(["--waive-starved", STARVATION, "--yes"]);
      const waiver = waiverArgv(fx);
      if (waiver === undefined) throw new Error(`no waiver comment posted: ${JSON.stringify(fx.forgeCalls)}`);
      expect(waiver.slice(0, 4)).toEqual(["gh", "pr", "comment", PROMOTE_URL]);
      expect(waiver.slice(4)).toEqual(["--body", payloadOf(waiver)]);
      expect(parseCiWaiver(payloadOf(waiver))).toEqual({
        headSha: PROMOTE_HEAD,
        checks: ["x"],
        reason: STARVATION,
      });
    });
  });

  test("AC-7: a refusal from the forge stops the promotion at the waiver", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, {
        ci: STARVED,
        onRun: (argv) => (parseCiWaiver(payloadOf(argv)) === null ? undefined : { exitCode: 1, stderr: "denied" }),
      });
      await fx.run(["--waive-starved", STARVATION, "--yes", "--json"]);
      expect(emittedError(fx.out)).toBe("promote stopped at waiver: denied");
      expect(fx.codes).toEqual([1]);
      expect(writeFor(fx.forgeCalls, ["gh", "pr", "ready"])).toBeUndefined();
    });
  });

  test("AC-13: a failed waiver leaves the record action unrun and the sidecar pending", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, {
        ci: STARVED,
        onRun: (argv) => (parseCiWaiver(payloadOf(argv)) === null ? undefined : { exitCode: 1, stderr: "denied" }),
      });
      const before = await Bun.file(writtenSidecar(fx)).text();
      await fx.run(["--waive-starved", STARVATION, "--yes"]);
      expect(fx.err).toEqual(["promote stopped at waiver: denied"]);
      expect(await Bun.file(writtenSidecar(fx)).text()).toBe(before);
      expect((await fx.sidecar())?.outcome).toBe("pending");
    });
  });

  test("AC-8: a green CI skips the waiver action and posts no waiver comment", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { ci: PROMOTE_GREEN });
      await fx.run(["--waive-starved", STARVATION, "--yes", "--json"]);
      const report = emittedJson(fx.out);
      expect(statusOf(report, "waiver")).toBe("skipped");
      expect(actionNames(report)).toEqual(["tick", "comment", "waiver", "ready", "record"]);
      expect(waiverArgv(fx)).toBeUndefined();
      expect(fx.codes).toEqual([0]);
    });
  });

  test("AC-9: with no flag a promoted run has no waiver action at all", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { ci: PROMOTE_GREEN });
      await fx.run(["--yes", "--json"]);
      expect(actionNames(emittedJson(fx.out))).toEqual(["tick", "comment", "ready", "record"]);
      expect(fx.codes).toEqual([0]);
    });
  });

  test("B4: a head that moves while the waiver is written stops the promotion before ready", async () => {
    await withTempDir(async (dir) => {
      // The stub pushes while the waiver comment is being written: every head read after the post
      // reports the new commit, exactly as a competing push would.
      let waived = false;
      const fx = await makePromoteFixture(dir, {
        ci: STARVED,
        onRun: (argv) => {
          if (parseCiWaiver(payloadOf(argv)) !== null) {
            waived = true;
            return undefined;
          }
          if (!argv.includes("headRefOid")) return undefined;
          return { stdout: JSON.stringify({ headRefOid: waived ? MOVED_HEAD : PROMOTE_HEAD }) };
        },
      });
      const before = await Bun.file(writtenSidecar(fx)).text();
      await fx.run(["--waive-starved", STARVATION, "--yes", "--json"]);
      expect(emittedError(fx.out)).toBe(
        `promote stopped at waiver: the PR head changed to ${MOVED_HEAD.slice(0, 7)}; the waiver names ${PROMOTE_HEAD.slice(0, 7)}`,
      );
      expect(fx.codes).toEqual([1]);
      expect(writeFor(fx.forgeCalls, ["gh", "pr", "ready"])).toBeUndefined();
      expect(await Bun.file(writtenSidecar(fx)).text()).toBe(before);
      expect((await fx.sidecar())?.outcome).toBe("pending");
    });
  });

  test("B4: a head that cannot be re-read stops the promotion too", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, {
        ci: STARVED,
        onRun: (argv) => (argv.includes("headRefOid") ? { exitCode: 1, stderr: "rate limited" } : undefined),
      });
      await fx.run(["--waive-starved", STARVATION, "--yes"]);
      expect(fx.err).toEqual([
        "promote stopped at waiver: the PR head could not be re-read, so the waiver cannot be tied to it",
      ]);
      expect(fx.codes).toEqual([1]);
      expect(writeFor(fx.forgeCalls, ["gh", "pr", "ready"])).toBeUndefined();
    });
  });

  test("M16: a starved CI that named no check is not waived", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { ci: STARVED_NO_CHECKS });
      await fx.run(["--waive-starved", STARVATION, "--yes", "--json"]);
      const check = checkOf(emittedJson(fx.out), "ci-green");
      expect(check.passed).toBe(false);
      expect(check.detail).toStartWith("ci starved:");
      expect(fx.codes).toEqual([2]);
      expect(waiverArgv(fx)).toBeUndefined();
      expect(prWrites(fx.forgeCalls)).toEqual([]);
    });
  });
});
