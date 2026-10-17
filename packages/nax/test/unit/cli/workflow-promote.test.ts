/**
 * SPEC-workflow-record-promote US-004: `nax workflow promote` — the validation steps, the
 * `items-ruled` and `ci-green` checks, and the dry run that performs no forge write.
 *
 * Every test enters through the `commander` program `registerWorkflowCommand` built, with
 * `WorkflowForgeDeps` stubbed by the shared draft-run fixture
 * (`test/helpers/workflow-promote-fixture.ts`), and asserts on the report the command printed, the
 * argv the forge stub received and the exit code.
 */
import { describe, expect, test } from "bun:test";
import {
  assertDefined,
  checkOf,
  emittedError,
  emittedJson,
  makePromoteFixture,
  PROMOTE_FEATURE,
  PROMOTE_HEAD,
  PROMOTE_RUN_ID,
  PROMOTE_SHA,
  PROMOTE_URL,
  prWrites,
  withTempDir,
} from "@test/helpers";
import { Command } from "commander";
import { registerWorkflowCommand, workflowPromoteCommand } from "@/cli";

const FEATURE = PROMOTE_FEATURE;

describe("nax workflow promote --json (the dry run)", () => {
  test("AC-1: a draft run with a ruled item and green checks exits 0 with the dry-run report", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir);
      await fx.run(["--json"]);
      expect(emittedJson(fx.out)).toEqual({
        feature: FEATURE,
        runId: PROMOTE_RUN_ID,
        url: PROMOTE_URL,
        dryRun: true,
        promoted: false,
        checks: [
          { name: "items-ruled", passed: true, detail: "" },
          { name: "ci-green", passed: true, detail: "" },
        ],
        actions: [],
      });
      expect(fx.codes).toEqual([0]);
    });
  });

  test("AC-2: the dry run reads the PR and writes none of it back", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir);
      await fx.run(["--json"]);
      expect(fx.forgeCalls).toContainEqual(["gh", "pr", "view", PROMOTE_URL, "--json", "isDraft,body,url"]);
      expect(prWrites(fx.forgeCalls)).toEqual([]);
      expect(emittedJson(fx.out).dryRun).toBe(true);
      expect(fx.codes).toEqual([0]);
    });
  });

  test("AC-8: the one CI wait names the forge, the url, no timeout and the pushed head", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir);
      await fx.run(["--json"]);
      expect(fx.forgeCalls).toContainEqual(["git", "rev-parse", "HEAD"]);
      expect(fx.checkCalls).toEqual([
        { forge: "github", prRef: PROMOTE_URL, cwd: dir, timeoutMs: 0, pollMs: 0, expectedSha: PROMOTE_HEAD },
      ]);
    });
  });
});

describe("nax workflow promote checks", () => {
  test("AC-3: an open item the sidecar does not rule fails items-ruled and exits 2", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { openItems: ["B1", "B2"], rulings: ["B1"] });
      await fx.run(["--json"]);
      const report = emittedJson(fx.out);
      expect(checkOf(report, "items-ruled")).toEqual({ passed: false, detail: "no ruling recorded for B2" });
      expect(checkOf(report, "ci-green").passed).toBe(true);
      expect(fx.codes).toEqual([2]);
    });
  });

  test("AC-4: a run with no sidecar at all names the command that writes one", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { rulings: null });
      await fx.run(["--json"]);
      expect(checkOf(emittedJson(fx.out), "items-ruled")).toEqual({
        passed: false,
        detail: "no decisions recorded; run nax workflow record",
      });
      expect(fx.codes).toEqual([2]);
    });
  });

  test("AC-5: a pending CI wait fails ci-green with the wait's own detail", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { ci: { outcome: "pending", detail: "no CI result within 0ms" } });
      await fx.run(["--json"]);
      expect(checkOf(emittedJson(fx.out), "ci-green")).toEqual({
        passed: false,
        detail: "ci pending: no CI result within 0ms",
      });
      expect(fx.codes).toEqual([2]);
    });
  });

  test("AC-6: a run with no checks reported fails ci-green", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { ci: { outcome: "no-checks", detail: "no CI check reported" } });
      await fx.run(["--json"]);
      expect(checkOf(emittedJson(fx.out), "ci-green").passed).toBe(false);
      expect(fx.codes).toEqual([2]);
    });
  });

  test("AC-7: a conflicting PR fails ci-green", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, {
        ci: { outcome: "conflicting", detail: "PR has merge conflicts with main" },
      });
      await fx.run(["--json"]);
      expect(checkOf(emittedJson(fx.out), "ci-green").passed).toBe(false);
      expect(fx.codes).toEqual([2]);
    });
  });

  test("AC-9: an unruled item and failed CI are both reported — neither check hides the other", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, {
        openItems: ["B1", "B2"],
        rulings: ["B1"],
        ci: { outcome: "failed", detail: "a check failed" },
      });
      await fx.run(["--json"]);
      const report = emittedJson(fx.out);
      expect(checkOf(report, "items-ruled")).toEqual({ passed: false, detail: "no ruling recorded for B2" });
      expect(checkOf(report, "ci-green")).toEqual({ passed: false, detail: "ci failed: a check failed" });
      expect(fx.codes).toEqual([2]);
    });
  });

  test("AC-20: a head the checks do not match fails ci-green, and --yes writes nothing", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, {
        ci: { outcome: "unavailable", detail: "checks report a1b2c3d4 but HEAD is e5f6a7b8" },
      });
      await fx.run(["--yes", "--json"]);
      expect(checkOf(emittedJson(fx.out), "ci-green")).toEqual({
        passed: false,
        detail: "ci unavailable: checks report a1b2c3d4 but HEAD is e5f6a7b8",
      });
      expect(fx.codes).toEqual([2]);
      expect(prWrites(fx.forgeCalls)).toEqual([]);
    });
  });
});

describe("nax workflow promote refusals", () => {
  test("AC-10: a PR the forge reports as ready is refused, and nothing is written", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, {
        prViews: [{ stdout: JSON.stringify({ isDraft: false, body: "B", url: PROMOTE_URL }) }],
      });
      await fx.run(["--json"]);
      expect(emittedError(fx.out)).toBe(`PR is already ready: ${PROMOTE_URL}`);
      expect(fx.codes).toEqual([1]);
      expect(prWrites(fx.forgeCalls)).toEqual([]);
    });
  });

  test("AC-11: a run that ended ready is refused", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { outcome: "ready" });
      await fx.run(["--json"]);
      expect(emittedError(fx.out)).toBe(`workflow for ${FEATURE} ended ready; only a draft can be promoted`);
      expect(fx.codes).toEqual([1]);
    });
  });

  test("AC-12: a run that never published is refused", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { outcome: null });
      await fx.run(["--json"]);
      expect(emittedError(fx.out)).toBe(`workflow for ${FEATURE} ended not published; only a draft can be promoted`);
      expect(fx.codes).toEqual([1]);
    });
  });

  test("AC-13: a draft with no PR url is refused", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { url: null });
      await fx.run(["--json"]);
      expect(emittedError(fx.out)).toBe("the workflow result has no PR url");
      expect(fx.codes).toEqual([1]);
    });
  });

  test("AC-14: no forge is detected", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { remote: { exitCode: 1, stderr: "no remote" } });
      await fx.run(["--json"]);
      expect(emittedError(fx.out)).toBe(`no forge detected for ${dir}`);
      expect(fx.codes).toEqual([1]);
    });
  });

  test("a forge that reports no draft flag is a read failure, not a ready PR", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { prViews: [{ stdout: "{}" }] });

      await fx.run(["--yes", "--json"]);

      expect(emittedError(fx.out)).toBe(`cannot read PR ${PROMOTE_URL}: the forge reported no isDraft boolean`);
      expect(fx.codes).toEqual([1]);
      expect(fx.checkCalls).toEqual([]);
      expect(prWrites(fx.forgeCalls)).toEqual([]);
    });
  });

  test("AC-15: a HEAD that cannot be read is refused, and no CI wait runs", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { head: { exitCode: 128, stderr: "not a git repository" } });
      await fx.run(["--json"]);
      expect(emittedError(fx.out)).toBe("cannot read HEAD: not a git repository");
      expect(fx.codes).toEqual([1]);
      expect(fx.checkCalls).toEqual([]);
    });
  });

  test("AC-18: a feature with no readable run reports the missing result", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { result: "missing" });
      await fx.run(["--json"]);
      expect(emittedError(fx.out)).toBe(`no workflow result for feature ${FEATURE}`);
      expect(fx.codes).toEqual([1]);
    });
  });

  test("AC-19: a run that never started its feature steps says so", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { result: "no-feature-workflow" });
      await fx.run(["--json"]);
      expect(emittedError(fx.out)).toBe(
        `workflow for ${FEATURE} has not started its feature steps (run ${PROMOTE_RUN_ID})`,
      );
      expect(fx.codes).toEqual([1]);
    });
  });
});

describe("nax workflow promote validates the sidecar it loads", () => {
  test("a ruling that names no open item is refused before any check runs or forge write", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { rulings: ["B9"] });

      await fx.run(["--yes", "--json"]);

      expect(emittedError(fx.out)).toBe("unknown item B9; open items: B1");
      expect(fx.codes).toEqual([1]);
      expect(fx.checkCalls).toEqual([]);
      expect(prWrites(fx.forgeCalls)).toEqual([]);
      expect((await fx.sidecar())?.outcome).toBe("pending");
    });
  });

  test("a hand-edited ruling the command cannot trust is refused, not ticked into the body", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir);
      assertDefined(fx.sidecarPath, "the fixture wrote a sidecar");
      const current = await fx.sidecar();
      assertDefined(current, "the fixture wrote a sidecar");
      const handWritten = JSON.stringify({
        ...current,
        decisions: [{ id: "B1", kind: "finding", disposition: "accepted", reason: "hand written", sha: PROMOTE_SHA }],
      });
      await Bun.write(fx.sidecarPath, handWritten);

      await fx.run(["--yes", "--json"]);

      expect(emittedError(fx.out)).toBe(
        `invalid decisions sidecar ${fx.sidecarPath}: decision B1: disposition must be one of fixed, waived, confirmed, overridden, verified`,
      );
      expect(fx.codes).toEqual([1]);
      expect(prWrites(fx.forgeCalls)).toEqual([]);
      expect(await Bun.file(fx.sidecarPath).text()).toBe(handWritten);
    });
  });
});

describe("nax workflow promote (plain)", () => {
  test("AC-16: one line per check, then the dry-run line", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir);
      await fx.run();
      expect(fx.out).toEqual(["pass  items-ruled", "pass  ci-green", "ready to promote; rerun with --yes"]);
      expect(fx.err).toEqual([]);
      expect(fx.codes).toEqual([0]);
    });
  });

  test("AC-17: a failed check prints FAIL and its detail", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { ci: { outcome: "pending", detail: "no CI result within 0ms" } });
      await fx.run();
      expect(fx.out.filter((line) => line.startsWith("FAIL  ci-green  ci pending"))).toHaveLength(1);
      expect(fx.codes).toEqual([2]);
    });
  });

  test("a refusal without --json goes to stderr, not stdout", async () => {
    await withTempDir(async (dir) => {
      const fx = await makePromoteFixture(dir, { outcome: "ready" });
      await fx.run();
      expect(fx.out).toEqual([]);
      expect(fx.err).toEqual([`workflow for ${FEATURE} ended ready; only a draft can be promoted`]);
      expect(fx.codes).toEqual([1]);
    });
  });
});

describe("nax workflow promote registration", () => {
  test("AC-21: the group registers status, record then promote, and the parse path exits with its code", async () => {
    await withTempDir(async (dir) => {
      const group = registerWorkflowCommand(new Command());
      expect(group.name()).toBe("workflow");
      expect(group.commands.map((c) => c.name())).toEqual(["status", "record", "promote"]);

      const fx = await makePromoteFixture(dir);
      const code = await workflowPromoteCommand(
        { dir, feature: FEATURE, yes: true, json: true },
        fx.deps,
        fx.forgeDeps,
      );
      expect(emittedJson(fx.out).promoted).toBe(true);
      fx.reset();
      await fx.run(["--yes", "--json"]);
      expect(fx.codes).toEqual([code]);
    });
  });
});
