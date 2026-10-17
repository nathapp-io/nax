/**
 * SPEC-workflow-record-promote US-002: `nax workflow record` — the validated writer of the run's
 * decisions sidecar, and the live PR read its `promoted` / `verified-ready` outcomes need.
 *
 * The fixtures spell the on-disk path out (`.nax/features/<feature>/workflow/<runId>/result.json`)
 * rather than deriving it with `workflowFeatureDir`, so a wrong base directory in the command cannot
 * make its own test agree.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { assertDefined, makeAdviceDecision, withTempDir, writeTrustedDecision } from "@test/helpers";
import { Command } from "commander";
import { _workflowForgeDeps, registerWorkflowCommand, type WorkflowCliDeps, type WorkflowForgeDeps } from "@/cli";
import type { ForgeDeps, ForgeRunResult } from "@/forge";
import type { WorkflowFeatureRecord, WorkflowFinding } from "@/workflow";
import { type DecisionEntry, type DecisionsSidecar, newestSidecar } from "@/workflow/decisions-sidecar";
import { newFeatureRecord } from "@/workflow/feature-record";

const FEATURE = "auth";
const RUN_ID = "r1";
const PR_URL = "https://gh/pr/7";
const NOW = new Date("2026-10-13T09:12:00.417Z");
const ISO_STAMP = "2026-10-13T09-12-00-417Z";
const SIDECAR_NAME = `decisions-${ISO_STAMP}.json`;
const SIDECAR_REL = join(".nax", "features", FEATURE, "workflow", RUN_ID, SIDECAR_NAME);
const REMOTE = "git@github.com:o/r.git\n";
const PR_READY = JSON.stringify({ isDraft: false, body: "B", url: PR_URL });
const PR_DRAFT = JSON.stringify({ isDraft: true, body: "B", url: PR_URL });

const ENTRY_B1: DecisionEntry = {
  id: "B1",
  kind: "finding",
  disposition: "fixed",
  reason: "retry path fixed",
  sha: "a1b2c3d",
};
const ENTRY_B2: DecisionEntry = { id: "B2", kind: "finding", disposition: "waived", reason: "accepted risk" };

/** One open finding of the run's verdict; `buildOpenItems` lists it as an item of kind `finding`. */
const finding = (id: string): WorkflowFinding => ({
  id,
  kind: "spec",
  severity: "important",
  issue: `${id} is broken`,
  file: "src/a.ts",
  line: 3,
});

function harness(): { deps: WorkflowCliDeps; out: string[]; err: string[]; codes: number[] } {
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  const deps: WorkflowCliDeps = {
    log: (text) => out.push(text),
    logErr: (text) => err.push(text),
    exit: (code) => codes.push(code),
  };
  return { deps, out, err, codes };
}

/** A forge stub: detection answers `origin`, `gh pr view` answers `prView`, everything else is inert. */
function forgeStub(opts: { prView?: Partial<ForgeRunResult>; noForge?: boolean } = {}): {
  forge: ForgeDeps;
  calls: string[][];
} {
  const calls: string[][] = [];
  const forge: ForgeDeps = {
    run: async (cmd) => {
      calls.push(cmd);
      if (opts.noForge) return { exitCode: 1, stdout: "", stderr: "no remote" };
      if (cmd[0] === "git") return { exitCode: 0, stdout: REMOTE, stderr: "" };
      if (cmd[0] === "gh" && cmd[1] === "pr") {
        return { exitCode: 0, stdout: PR_READY, stderr: "", ...opts.prView };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    readText: async () => null,
  };
  return { forge, calls };
}

/** The `WorkflowForgeDeps` the command runs against — the shared shape, with the forge and clock faked. */
function wfDeps(stub: { forge: ForgeDeps } = forgeStub()): WorkflowForgeDeps {
  return { ..._workflowForgeDeps, forge: stub.forge, now: () => NOW };
}

/** The workflow tree of the feature, exactly where the spec puts it. */
const workflowDir = (dir: string): string => join(dir, ".nax", "features", FEATURE, "workflow");

function featureRecord(over: Partial<WorkflowFeatureRecord> = {}): WorkflowFeatureRecord {
  return {
    ...newFeatureRecord({ now: ISO_STAMP, seed: null, minors: [] }),
    step: "done",
    outcome: "draft",
    url: PR_URL,
    reasons: [],
    ...over,
  };
}

/** Writes one run directory's `result.json`; returns the directory. */
async function writeRun(dir: string, over: Partial<WorkflowFeatureRecord> = {}): Promise<string> {
  const runDir = join(workflowDir(dir), RUN_ID);
  await mkdir(runDir, { recursive: true });
  await Bun.write(
    join(runDir, "result.json"),
    JSON.stringify({
      schemaVersion: 1,
      runId: RUN_ID,
      feature: FEATURE,
      stories: {},
      featureWorkflow: featureRecord(over),
    }),
  );
  return runDir;
}

/** Writes the decisions file the command is pointed at; `entries` may be raw text. */
async function writeDecisions(dir: string, entries: readonly DecisionEntry[] | string): Promise<string> {
  const path = join(dir, "decisions.json");
  await Bun.write(path, typeof entries === "string" ? entries : JSON.stringify(entries));
  return path;
}

/** The sidecar a hand-written file holds: the shape the command writes, with no entries. */
const SIDECAR_BASE: DecisionsSidecar = {
  artifact: `${RUN_ID}/result.json`,
  feature: FEATURE,
  resumedAt: ISO_STAMP,
  reasons: [],
  decisions: [],
  outcome: "pending",
  url: PR_URL,
};

/** Writes a sidecar file verbatim — a hand-written one the command must validate, not trust. */
async function writeSidecarFile(runDir: string, body: Partial<DecisionsSidecar> | string): Promise<string> {
  const path = join(runDir, SIDECAR_NAME);
  await Bun.write(path, typeof body === "string" ? body : JSON.stringify({ ...SIDECAR_BASE, ...body }, null, 2));
  return path;
}

/** The run's `decisions-*.json` names, sorted. */
async function sidecarNames(runDir: string): Promise<string[]> {
  return (await readdir(runDir)).filter((name) => name.startsWith("decisions-") && name.endsWith(".json")).sort();
}

async function readSidecar(runDir: string): Promise<DecisionsSidecar> {
  expect(await sidecarNames(runDir)).toEqual([SIDECAR_NAME]);
  const found = await newestSidecar(runDir);
  assertDefined(found, `${SIDECAR_NAME} in ${runDir}`);
  return found.sidecar;
}

async function record(deps: WorkflowCliDeps, forge: WorkflowForgeDeps, argv: string[]): Promise<void> {
  const program = new Command();
  registerWorkflowCommand(program, deps, forge);
  await program.parseAsync(["node", "nax", "workflow", "record", ...argv]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The single JSON object the command printed. */
function emittedJson(out: readonly string[]): Record<string, unknown> {
  expect(out).toHaveLength(1);
  const parsed: unknown = JSON.parse(out[0] ?? "null");
  if (!isRecord(parsed)) throw new Error("the command did not print one JSON object");
  return parsed;
}

function emittedError(out: readonly string[]): string {
  const error = emittedJson(out).error;
  return typeof error === "string" ? error : "";
}

/** The open run of AC-5 to AC-16: story `B1`, or `B1` and `B2`. */
const open = (ids: readonly string[]): Partial<WorkflowFeatureRecord> => ({ reviewOpen: ids.map(finding) });

describe("nax workflow record --json", () => {
  test("AC-5: creates exactly one sidecar for the run, copying the run's facts", async () => {
    await withTempDir(async (dir) => {
      const runDir = await writeRun(dir, open(["B1"]));
      const decisions = await writeDecisions(dir, [ENTRY_B1]);
      const h = harness();
      await record(h.deps, wfDeps(), ["-f", FEATURE, "--decisions", decisions, "--json", "-d", dir]);
      expect(await sidecarNames(runDir)).toEqual([SIDECAR_NAME]);
      const sidecar = await readSidecar(runDir);
      expect(sidecar.artifact).toBe(`${RUN_ID}/result.json`);
      expect(sidecar.feature).toBe(FEATURE);
      expect(sidecar.resumedAt).toBe(ISO_STAMP);
      expect(sidecar.outcome).toBe("pending");
      expect(sidecar.decisions).toEqual([ENTRY_B1]);
      expect(sidecar.reasons).toEqual(featureRecord().reasons);
    });
  });

  test("AC-5: the sidecar copies the run's reasons verbatim", async () => {
    await withTempDir(async (dir) => {
      const reasons = ["the branch review was incomplete", "a ruling is held"];
      const runDir = await writeRun(dir, { ...open(["B1"]), reasons });
      const decisions = await writeDecisions(dir, [ENTRY_B1]);
      const h = harness();
      await record(h.deps, wfDeps(), ["-f", FEATURE, "--decisions", decisions, "--json", "-d", dir]);
      expect((await readSidecar(runDir)).reasons).toEqual(reasons);
    });
  });

  test("AC-6: prints one report and exits 0", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, open(["B1"]));
      const decisions = await writeDecisions(dir, [ENTRY_B1]);
      const h = harness();
      await record(h.deps, wfDeps(), ["-f", FEATURE, "--decisions", decisions, "--json", "-d", dir]);
      expect(emittedJson(h.out)).toEqual({
        feature: FEATURE,
        runId: RUN_ID,
        sidecar: SIDECAR_REL,
        outcome: "pending",
        decisions: 1,
        unruled: [],
      });
      expect(h.codes).toEqual([0]);
    });
  });

  test("AC-7: an unruled open item is listed and the exit code stays 0", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, open(["B1", "B2"]));
      const decisions = await writeDecisions(dir, [ENTRY_B1]);
      const h = harness();
      await record(h.deps, wfDeps(), ["-f", FEATURE, "--decisions", decisions, "--json", "-d", dir]);
      expect(emittedJson(h.out).unruled).toEqual(["B2"]);
      expect(h.codes).toEqual([0]);
    });
  });

  test("#2578: rulings on a trusted advisor decision and a story-level cannot-verify line are recorded", async () => {
    await withTempDir(async (dir) => {
      const runDir = await writeRun(dir, open(["B1"]));
      const outputDir = join(dir, "out");
      const trusted = makeAdviceDecision({
        id: "D-2",
        action: { type: "waive", reason: "low risk" },
        auditRef: `advisor-audit/${FEATURE}/D-2.json`,
      });
      await writeTrustedDecision(dir, FEATURE, outputDir, trusted);
      await Bun.write(join(runDir, "ledger.md"), "US-001: cannot-verify: Redis TTL\n");
      const extra: DecisionEntry[] = [
        { id: "D-2", kind: "advisor", disposition: "verified", reason: "read src/a.ts:3; the risk is as stated" },
        { id: "US-001:cv1", kind: "cannot-verify", disposition: "verified", reason: "ran the TTL test: 3 passed" },
      ];
      const decisions = await writeDecisions(dir, [ENTRY_B1, ...extra]);
      const h = harness();
      const forge = { ...wfDeps(), resolveOutputDir: async () => outputDir };
      await record(h.deps, forge, ["-f", FEATURE, "--decisions", decisions, "--json", "-d", dir]);
      expect(h.codes).toEqual([0]);
      expect(emittedJson(h.out).unruled).toEqual([]);
      expect((await readSidecar(runDir)).decisions).toEqual([ENTRY_B1, ...extra]);
    });
  });

  test("#2578: an advisor id that is neither open nor in the advisor ledger is still refused", async () => {
    await withTempDir(async (dir) => {
      const runDir = await writeRun(dir, open(["B1"]));
      const decisions = await writeDecisions(dir, [
        { id: "D-9", kind: "advisor", disposition: "verified", reason: "no such decision" },
      ]);
      const h = harness();
      await record(h.deps, wfDeps(), ["-f", FEATURE, "--decisions", decisions, "--json", "-d", dir]);
      expect(h.codes).toEqual([1]);
      expect(emittedJson(h.out)).toEqual({ error: "unknown item D-9; open items: B1" });
      expect(await sidecarNames(runDir)).toEqual([]);
    });
  });

  test("AC-8: a second call merges its entry into the one sidecar, after the first", async () => {
    await withTempDir(async (dir) => {
      const runDir = await writeRun(dir, open(["B1", "B2"]));
      const h = harness();
      const forge = wfDeps();
      await record(h.deps, forge, ["-f", FEATURE, "--decisions", await writeDecisions(dir, [ENTRY_B1]), "-d", dir]);
      await record(h.deps, forge, ["-f", FEATURE, "--decisions", await writeDecisions(dir, [ENTRY_B2]), "-d", dir]);
      expect(await sidecarNames(runDir)).toEqual([SIDECAR_NAME]);
      const sidecar = await readSidecar(runDir);
      expect(sidecar.decisions).toEqual([ENTRY_B1, ENTRY_B2]);
    });
  });

  test("AC-9: re-ruling an entry replaces it in place", async () => {
    await withTempDir(async (dir) => {
      const runDir = await writeRun(dir, open(["B1", "B2"]));
      const h = harness();
      const forge = wfDeps();
      await record(h.deps, forge, [
        "-f",
        FEATURE,
        "--decisions",
        await writeDecisions(dir, [ENTRY_B1, ENTRY_B2]),
        "-d",
        dir,
      ]);
      const overruled: DecisionEntry = {
        id: "B1",
        kind: "finding",
        disposition: "waived",
        reason: "accepted for this release",
      };
      await record(h.deps, forge, ["-f", FEATURE, "--decisions", await writeDecisions(dir, [overruled]), "-d", dir]);
      expect(await sidecarNames(runDir)).toEqual([SIDECAR_NAME]);
      expect((await readSidecar(runDir)).decisions).toEqual([overruled, ENTRY_B2]);
    });
  });

  test("AC-10: --outcome abandoned rewrites the sidecar's outcome and keeps its decisions", async () => {
    await withTempDir(async (dir) => {
      const runDir = await writeRun(dir, open(["B1"]));
      const h = harness();
      const forge = wfDeps();
      await record(h.deps, forge, ["-f", FEATURE, "--decisions", await writeDecisions(dir, [ENTRY_B1]), "-d", dir]);
      await record(h.deps, forge, ["-f", FEATURE, "--outcome", "abandoned", "-d", dir]);
      const sidecar = await readSidecar(runDir);
      expect(sidecar.outcome).toBe("abandoned");
      expect(sidecar.decisions).toEqual([ENTRY_B1]);
    });
  });

  test("AC-15: --outcome promoted on a ready PR stores the outcome and the record's url", async () => {
    await withTempDir(async (dir) => {
      const runDir = await writeRun(dir, open(["B1"]));
      const h = harness();
      await record(h.deps, wfDeps(), ["-f", FEATURE, "--decisions", await writeDecisions(dir, [ENTRY_B1]), "-d", dir]);
      const ready = wfDeps(forgeStub({ prView: { stdout: PR_READY } }));
      await record(h.deps, ready, ["-f", FEATURE, "--outcome", "promoted", "-d", dir]);
      const sidecar = await readSidecar(runDir);
      expect(sidecar.outcome).toBe("promoted");
      expect(sidecar.url).toBe(PR_URL);
      expect(h.codes).toEqual([0, 0]);
    });
  });

  test("AC-15: the promoted call reads the PR with the record's url", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, open(["B1"]));
      const h = harness();
      await record(h.deps, wfDeps(), ["-f", FEATURE, "--decisions", await writeDecisions(dir, [ENTRY_B1]), "-d", dir]);
      const stub = forgeStub({ prView: { stdout: PR_READY } });
      await record(h.deps, wfDeps(stub), ["-f", FEATURE, "--outcome", "promoted", "-d", dir]);
      expect(stub.calls).toContainEqual(["gh", "pr", "view", PR_URL, "--json", "isDraft,body,url"]);
    });
  });
});

describe("nax workflow record errors", () => {
  test("AC-11: an outcome with no --decisions and no sidecar is refused, and writes nothing", async () => {
    await withTempDir(async (dir) => {
      const runDir = await writeRun(dir, open(["B1"]));
      const h = harness();
      await record(h.deps, wfDeps(), ["-f", FEATURE, "--outcome", "abandoned", "--json", "-d", dir]);
      expect(emittedError(h.out)).toBe(`no decisions sidecar for run ${RUN_ID}; pass --decisions`);
      expect(h.codes).toEqual([1]);
      expect(await sidecarNames(runDir)).toEqual([]);
    });
  });

  test("AC-12: neither --decisions nor --outcome is nothing to record", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      await record(h.deps, wfDeps(), ["-f", FEATURE, "--json", "-d", dir]);
      expect(emittedError(h.out)).toBe("nothing to record: pass --decisions or --outcome");
      expect(h.codes).toEqual([1]);
    });
  });

  test("AC-13: an unknown outcome is refused before any run directory is read", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      await record(h.deps, wfDeps(), ["-f", FEATURE, "--outcome", "done", "--json", "-d", join(dir, "does-not-exist")]);
      expect(emittedError(h.out)).toBe("outcome must be one of pending, promoted, verified-ready, abandoned");
      expect(h.codes).toEqual([1]);
    });
  });

  test("AC-14: recording promoted while the PR is a draft is refused, and the sidecar is byte-identical", async () => {
    await withTempDir(async (dir) => {
      const runDir = await writeRun(dir, open(["B1"]));
      const h = harness();
      await record(h.deps, wfDeps(), ["-f", FEATURE, "--decisions", await writeDecisions(dir, [ENTRY_B1]), "-d", dir]);
      const path = join(runDir, SIDECAR_NAME);
      const before = await Bun.file(path).text();
      const failed = harness();
      await record(failed.deps, wfDeps(forgeStub({ prView: { stdout: PR_DRAFT } })), [
        "-f",
        FEATURE,
        "--outcome",
        "promoted",
        "--json",
        "-d",
        dir,
      ]);
      expect(emittedError(failed.out)).toBe("cannot record outcome promoted: PR is still a draft");
      expect(failed.codes).toEqual([1]);
      expect(await Bun.file(path).text()).toBe(before);
    });
  });

  test("AC-16: recording verified-ready while the PR is a draft is refused", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, open(["B1"]));
      const h = harness();
      await record(h.deps, wfDeps(forgeStub({ prView: { stdout: PR_DRAFT } })), [
        "-f",
        FEATURE,
        "--outcome",
        "verified-ready",
        "--json",
        "-d",
        dir,
      ]);
      expect(emittedError(h.out)).toBe("cannot record outcome verified-ready: PR is still a draft");
      expect(h.codes).toEqual([1]);
    });
  });

  test("AC-17: an outcome needing a PR is refused when the record has no url", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, { ...open(["B1"]), url: undefined });
      const h = harness();
      await record(h.deps, wfDeps(), ["-f", FEATURE, "--outcome", "promoted", "--json", "-d", dir]);
      expect(emittedError(h.out)).toBe("cannot record outcome promoted: the workflow result has no PR url");
      expect(h.codes).toEqual([1]);
    });
  });

  test("AC-18: an entry naming no open item is refused, and no sidecar is created", async () => {
    await withTempDir(async (dir) => {
      const runDir = await writeRun(dir, open(["B1"]));
      const h = harness();
      const unknown: DecisionEntry = { ...ENTRY_B1, id: "B9" };
      await record(h.deps, wfDeps(), [
        "-f",
        FEATURE,
        "--decisions",
        await writeDecisions(dir, [unknown]),
        "--json",
        "-d",
        dir,
      ]);
      expect(emittedError(h.out)).toBe("unknown item B9; open items: B1");
      expect(h.codes).toEqual([1]);
      expect(await sidecarNames(runDir)).toEqual([]);
    });
  });

  test("AC-19: a decisions file that is not JSON is named as such", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, open(["B1"]));
      const path = await writeDecisions(dir, "{not json");
      const h = harness();
      await record(h.deps, wfDeps(), ["-f", FEATURE, "--decisions", path, "--json", "-d", dir]);
      expect(emittedError(h.out)).toBe(`decisions file is not valid JSON: ${path}`);
      expect(h.codes).toEqual([1]);
    });
  });

  test("AC-19: a decisions file that cannot be read is named as such", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, open(["B1"]));
      const path = join(dir, "missing.json");
      const h = harness();
      await record(h.deps, wfDeps(), ["-f", FEATURE, "--decisions", path, "--json", "-d", dir]);
      expect(emittedError(h.out)).toBe(`cannot read decisions file: ${path}`);
      expect(h.codes).toEqual([1]);
    });
  });

  test("AC-20: an invalid feature name is refused before any file is read", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      await record(h.deps, wfDeps(), [
        "-f",
        "../x",
        "--decisions",
        join(dir, "missing.json"),
        "--json",
        "-d",
        join(dir, "does-not-exist"),
      ]);
      expect(emittedError(h.out)).toBe("Feature name must be a single path segment: ../x");
      expect(h.codes).toEqual([1]);
    });
  });

  test("AC-23: an outcome needing a PR is refused when no forge is detected", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, open(["B1"]));
      const h = harness();
      await record(h.deps, wfDeps(forgeStub({ noForge: true })), [
        "-f",
        FEATURE,
        "--outcome",
        "promoted",
        "--json",
        "-d",
        dir,
      ]);
      expect(emittedError(h.out)).toBe(`no forge detected for ${dir}`);
      expect(h.codes).toEqual([1]);
    });
  });

  test("AC-24: a feature with no readable run reports the missing result", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      await record(h.deps, wfDeps(), [
        "-f",
        FEATURE,
        "--decisions",
        await writeDecisions(dir, [ENTRY_B1]),
        "--json",
        "-d",
        dir,
      ]);
      expect(emittedError(h.out)).toBe(`no workflow result for feature ${FEATURE}`);
      expect(h.codes).toEqual([1]);
    });
  });

  test("an error without --json goes to stderr, not stdout", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      await record(h.deps, wfDeps(), ["-f", FEATURE, "-d", dir]);
      expect(h.out).toEqual([]);
      expect(h.err).toEqual(["nothing to record: pass --decisions or --outcome"]);
      expect(h.codes).toEqual([1]);
    });
  });
});

describe("nax workflow record validates the sidecar it loads", () => {
  test("an existing sidecar with an entry the command cannot trust is refused, byte for byte", async () => {
    await withTempDir(async (dir) => {
      const runDir = await writeRun(dir, open(["B1"]));
      const handWritten = JSON.stringify(
        { ...SIDECAR_BASE, decisions: [{ ...ENTRY_B1, disposition: "accepted" }] },
        null,
        2,
      );
      await writeSidecarFile(runDir, handWritten);
      const h = harness();

      await record(h.deps, wfDeps(), ["-f", FEATURE, "--outcome", "abandoned", "--json", "-d", dir]);

      expect(emittedError(h.out)).toBe(
        `invalid decisions sidecar ${join(runDir, SIDECAR_NAME)}: decision B1: disposition must be one of fixed, waived, confirmed, overridden, verified`,
      );
      expect(h.codes).toEqual([1]);
      expect(await Bun.file(join(runDir, SIDECAR_NAME)).text()).toBe(handWritten);
    });
  });

  test("an existing sidecar naming no open item is refused, and the incoming entry is not written", async () => {
    await withTempDir(async (dir) => {
      const runDir = await writeRun(dir, open(["B1"]));
      const handWritten = JSON.stringify({ ...SIDECAR_BASE, decisions: [{ ...ENTRY_B1, id: "B9" }] }, null, 2);
      await writeSidecarFile(runDir, handWritten);
      const h = harness();

      await record(h.deps, wfDeps(), [
        "-f",
        FEATURE,
        "--decisions",
        await writeDecisions(dir, [ENTRY_B1]),
        "--json",
        "-d",
        dir,
      ]);

      expect(emittedError(h.out)).toBe("unknown item B9; open items: B1");
      expect(h.codes).toEqual([1]);
      expect(await Bun.file(join(runDir, SIDECAR_NAME)).text()).toBe(handWritten);
    });
  });

  test("a sidecar whose entries the run still owns is merged as before", async () => {
    await withTempDir(async (dir) => {
      const runDir = await writeRun(dir, open(["B1", "B2"]));
      await writeSidecarFile(runDir, { decisions: [ENTRY_B1] });
      const h = harness();

      await record(h.deps, wfDeps(), ["-f", FEATURE, "--decisions", await writeDecisions(dir, [ENTRY_B2]), "-d", dir]);

      expect(h.codes).toEqual([0]);
      expect((await readSidecar(runDir)).decisions).toEqual([ENTRY_B1, ENTRY_B2]);
    });
  });

  test("a forge that reports no draft flag cannot record promoted", async () => {
    await withTempDir(async (dir) => {
      const runDir = await writeRun(dir, open(["B1"]));
      const h = harness();
      await record(h.deps, wfDeps(), ["-f", FEATURE, "--decisions", await writeDecisions(dir, [ENTRY_B1]), "-d", dir]);
      const path = join(runDir, SIDECAR_NAME);
      const before = await Bun.file(path).text();
      const failed = harness();

      await record(failed.deps, wfDeps(forgeStub({ prView: { stdout: "{}" } })), [
        "-f",
        FEATURE,
        "--outcome",
        "promoted",
        "--json",
        "-d",
        dir,
      ]);

      expect(emittedError(failed.out)).toBe(`cannot read PR ${PR_URL}: the forge reported no isDraft boolean`);
      expect(failed.codes).toEqual([1]);
      expect(await Bun.file(path).text()).toBe(before);
    });
  });
});

describe("nax workflow record (plain)", () => {
  test("AC-21: one line naming the sidecar, and a second only when something is unruled", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, open(["B1", "B2"]));
      const h = harness();
      const forge = wfDeps();
      await record(h.deps, forge, ["-f", FEATURE, "--decisions", await writeDecisions(dir, [ENTRY_B1]), "-d", dir]);
      await record(h.deps, forge, ["-f", FEATURE, "--outcome", "abandoned", "-d", dir]);
      expect(h.out).toEqual([
        `${FEATURE}: recorded 1 decision(s) in ${SIDECAR_REL}; outcome pending`,
        "unruled: B2",
        `${FEATURE}: recorded 1 decision(s) in ${SIDECAR_REL}; outcome abandoned`,
        "unruled: B2",
      ]);
      expect(h.codes).toEqual([0, 0]);
    });
  });

  test("AC-21: nothing unruled prints only the recorded line", async () => {
    await withTempDir(async (dir) => {
      await writeRun(dir, open(["B1"]));
      const h = harness();
      await record(h.deps, wfDeps(), ["-f", FEATURE, "--decisions", await writeDecisions(dir, [ENTRY_B1]), "-d", dir]);
      expect(h.out).toEqual([`${FEATURE}: recorded 1 decision(s) in ${SIDECAR_REL}; outcome pending`]);
      expect(h.codes).toEqual([0]);
    });
  });
});

describe("nax workflow registration", () => {
  test("AC-22: the workflow group registers status, record then promote", () => {
    const group = registerWorkflowCommand(new Command());
    expect(group.name()).toBe("workflow");
    expect(group.commands.map((c) => c.name())).toEqual(["status", "record", "promote"]);
  });
});
