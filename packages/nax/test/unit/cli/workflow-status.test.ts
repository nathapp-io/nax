/**
 * US-003: `nax workflow status` — the verdict of a feature's newest workflow run.
 *
 * ACs 1-15 of `docs/specs/SPEC-workflow-status.md`. The fixtures spell the on-disk path out
 * (`.nax/features/<feature>/workflow/<runId>/result.json`) rather than deriving it with
 * `workflowFeatureDir`, so a wrong base directory in the command cannot make its own test agree.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, readdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { makeAdviceDecision, withTempDir, writeTrustedDecision } from "@test/helpers";
import { Command } from "commander";
import { _workflowForgeDeps, registerWorkflowCommand, type WorkflowCliDeps, type WorkflowForgeDeps } from "@/cli";
import type { WorkflowFeatureRecord, WorkflowResultFile } from "@/workflow";
import { newFeatureRecord } from "@/workflow/feature-record";
import { newStoryRecord } from "@/workflow/result";

const FEATURE = "auth";
const NOW = "2026-10-12T00:00:00.000Z";

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

async function run(deps: WorkflowCliDeps, argv: string[]): Promise<void> {
  const program = new Command();
  registerWorkflowCommand(program, deps);
  await program.parseAsync(["node", "nax", "workflow", "status", ...argv]);
}

/** The workflow tree of the feature, exactly where the spec puts it. */
const workflowDir = (dir: string): string => join(dir, ".nax", "features", FEATURE, "workflow");

function featureRecord(over: Partial<WorkflowFeatureRecord> = {}): WorkflowFeatureRecord {
  return { ...newFeatureRecord({ now: NOW, seed: null, minors: [] }), step: "done", ...over };
}

/** Writes one run directory's `result.json`; returns the directory. */
async function writeResult(dir: string, runId: string, file: Partial<WorkflowResultFile> = {}): Promise<string> {
  const runDir = join(workflowDir(dir), runId);
  await mkdir(runDir, { recursive: true });
  await Bun.write(
    join(runDir, "result.json"),
    JSON.stringify({ schemaVersion: 1, runId, feature: FEATURE, stories: {}, ...file }),
  );
  return runDir;
}

/** The JSON object the command printed (its `--json` output is one object on one line). */
function emittedJson(out: readonly string[]): Record<string, unknown> {
  expect(out).toHaveLength(1);
  return JSON.parse(out[0] ?? "null") as Record<string, unknown>;
}

function openItemsOf(report: Record<string, unknown>): { id: string; kind: string; issue: string }[] {
  return report.openItems as { id: string; kind: string; issue: string }[];
}

const HELD = { approved: false, rationale: "advisor held: x", decisionId: "D-1" };

/** The draft fixture of AC-1, AC-2, AC-11 and AC-14. */
const DRAFT = {
  featureWorkflow: featureRecord({
    outcome: "draft",
    url: "https://gh/pr/7",
    ci: "green",
    approval: HELD,
  }),
};

describe("nax workflow status --json", () => {
  test("AC-1: reports the feature, the run, the outcome, the url and the advisor item", async () => {
    await withTempDir(async (dir) => {
      await writeResult(dir, "r1", DRAFT);
      const h = harness();
      await run(h.deps, ["-f", FEATURE, "--json", "-d", dir]);
      const report = emittedJson(h.out);
      expect(report.feature).toBe(FEATURE);
      expect(report.runId).toBe("r1");
      expect(report.runDir).toBe(join(".nax", "features", FEATURE, "workflow", "r1"));
      expect(report.step).toBe("done");
      expect(report.outcome).toBe("draft");
      expect(report.url).toBe("https://gh/pr/7");
      expect(report.ci).toBe("green");
      expect(report.workflowPassed).toBe(false);
      expect(openItemsOf(report)).toContainEqual({ id: "D-1", kind: "advisor", issue: "advisor held: x" });
    });
  });

  test("AC-2: a held approval exits 2 (a human is needed)", async () => {
    await withTempDir(async (dir) => {
      await writeResult(dir, "r1", DRAFT);
      const h = harness();
      await run(h.deps, ["-f", FEATURE, "--json", "-d", dir]);
      expect(h.codes).toEqual([2]);
    });
  });

  test("AC-3: a ready run with nothing open prints openItems [] and exits 0", async () => {
    await withTempDir(async (dir) => {
      await writeResult(dir, "r1", { featureWorkflow: featureRecord({ outcome: "ready", passed: true }) });
      const h = harness();
      await run(h.deps, ["-f", FEATURE, "--json", "-d", dir]);
      const report = emittedJson(h.out);
      expect(report.openItems).toEqual([]);
      expect(report.workflowPassed).toBe(true);
      expect(h.codes).toEqual([0]);
    });
  });

  test("AC-4: a ready run with a cannot-verify item exits 2", async () => {
    await withTempDir(async (dir) => {
      await writeResult(dir, "r1", {
        featureWorkflow: featureRecord({ outcome: "ready", passed: true, cannotVerify: ["needs a human to check"] }),
      });
      const h = harness();
      await run(h.deps, ["-f", FEATURE, "--json", "-d", dir]);
      const report = emittedJson(h.out);
      expect(openItemsOf(report).map((i) => i.kind)).toEqual(["cannot-verify"]);
      expect(h.codes).toEqual([2]);
    });
  });

  test("AC-5: storyStates are filled from result.stories when the record has none", async () => {
    await withTempDir(async (dir) => {
      await writeResult(dir, "r1", {
        featureWorkflow: featureRecord({ outcome: "draft" }),
        stories: {
          "US-002": { ...newStoryRecord("US-002", 3, NOW), state: "complete-gate-open", reason: "red: lint" },
        },
      });
      const h = harness();
      await run(h.deps, ["-f", FEATURE, "--json", "-d", dir]);
      const report = emittedJson(h.out);
      // The AC's precondition: the fixture carries no top-level verdict to fall back on.
      const written = (await Bun.file(join(workflowDir(dir), "r1", "result.json")).json()) as Record<string, unknown>;
      expect("verdict" in written).toBe(false);
      expect(openItemsOf(report)).toContainEqual({
        id: "US-002",
        kind: "story",
        issue: "US-002 ended complete-gate-open: red: lint",
      });
    });
  });

  test("AC-6: the newest run directory's result.json wins", async () => {
    await withTempDir(async (dir) => {
      await writeResult(dir, "r-old", DRAFT);
      await writeResult(dir, "r-new", DRAFT);
      await utimes(join(workflowDir(dir), "r-old", "result.json"), new Date(1000), new Date(1000));
      await utimes(join(workflowDir(dir), "r-new", "result.json"), new Date(2000), new Date(2000));
      const h = harness();
      await run(h.deps, ["-f", FEATURE, "--json", "-d", dir]);
      expect(emittedJson(h.out).runId).toBe("r-new");
    });
  });

  test("AC-7: an unreadable newer result.json falls back to the older run directory", async () => {
    await withTempDir(async (dir) => {
      await writeResult(dir, "r-old", DRAFT);
      const newer = await writeResult(dir, "r-new", DRAFT);
      await Bun.write(join(newer, "result.json"), "{not json");
      await utimes(join(workflowDir(dir), "r-old", "result.json"), new Date(1000), new Date(1000));
      await utimes(join(newer, "result.json"), new Date(2000), new Date(2000));
      const h = harness();
      await run(h.deps, ["-f", FEATURE, "--json", "-d", dir]);
      expect(emittedJson(h.out).runId).toBe("r-old");
    });
  });

  test("AC-13: a run that never published has no outcome and no workflowPassed, and exits 2", async () => {
    await withTempDir(async (dir) => {
      await writeResult(dir, "r1", {
        featureWorkflow: featureRecord({ step: "final-gates" }),
        stories: { "US-002": { ...newStoryRecord("US-002", 3, NOW), state: "complete-gate-open" } },
      });
      const h = harness();
      await run(h.deps, ["-f", FEATURE, "--json", "-d", dir]);
      const report = emittedJson(h.out);
      expect(openItemsOf(report).map((i) => i.id)).toContain("US-002");
      expect("outcome" in report).toBe(false);
      expect("workflowPassed" in report).toBe(false);
      expect("ci" in report).toBe(false);
      expect("url" in report).toBe(false);
      expect(h.codes).toEqual([2]);
    });
  });
});

describe("nax workflow status errors", () => {
  test("AC-8: no workflow directory exits 1 with the no-result error", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      await run(h.deps, ["-f", FEATURE, "--json", "-d", dir]);
      expect(emittedJson(h.out)).toEqual({ error: `no workflow result for feature ${FEATURE}` });
      expect(h.codes).toEqual([1]);
    });
  });

  test("AC-9: an invalid feature name is rejected before any directory is read", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      await run(h.deps, ["-f", "../x", "--json", "-d", join(dir, "does-not-exist")]);
      expect(emittedJson(h.out)).toEqual({ error: "Feature name must be a single path segment: ../x" });
      expect(h.codes).toEqual([1]);
    });
  });

  test("AC-10: a result.json with no featureWorkflow exits 1 naming the run", async () => {
    await withTempDir(async (dir) => {
      await writeResult(dir, "r1");
      const h = harness();
      await run(h.deps, ["-f", FEATURE, "--json", "-d", dir]);
      const error = emittedJson(h.out).error as string;
      expect(error.startsWith(`workflow for ${FEATURE} has not started its feature steps`)).toBe(true);
      expect(error).toContain("r1");
      expect(h.codes).toEqual([1]);
    });
  });

  test("an error without --json goes to stderr, not stdout", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      await run(h.deps, ["-f", FEATURE, "-d", dir]);
      expect(h.out).toEqual([]);
      expect(h.err).toEqual([`no workflow result for feature ${FEATURE}`]);
      expect(h.codes).toEqual([1]);
    });
  });
});

describe("nax workflow status (plain)", () => {
  test("AC-11: the first line is the outcome and url, then one line per open item", async () => {
    await withTempDir(async (dir) => {
      await writeResult(dir, "r1", DRAFT);
      const h = harness();
      await run(h.deps, ["-f", FEATURE, "-d", dir]);
      expect(h.out[0]).toBe("auth: draft https://gh/pr/7");
      expect(h.out[1]).toBe("- [advisor] D-1 — advisor held: x");
      expect(h.codes).toEqual([2]);
    });
  });

  test("AC-12: nothing open prints 'No open items.'", async () => {
    await withTempDir(async (dir) => {
      await writeResult(dir, "r1", { featureWorkflow: featureRecord({ outcome: "ready", passed: true }) });
      const h = harness();
      await run(h.deps, ["-f", FEATURE, "-d", dir]);
      expect(h.out).toEqual(["auth: ready", "No open items."]);
      expect(h.codes).toEqual([0]);
    });
  });

  test("a run that never published reads 'not published'", async () => {
    await withTempDir(async (dir) => {
      await writeResult(dir, "r1", { featureWorkflow: featureRecord({ step: "final-gates" }) });
      const h = harness();
      await run(h.deps, ["-f", FEATURE, "-d", dir]);
      expect(h.out[0]).toBe("auth: not published");
    });
  });
});

describe("nax workflow status (read-only)", () => {
  async function snapshot(dir: string): Promise<{ entries: string[]; files: Record<string, string> }> {
    const entries = (await readdir(workflowDir(dir))).sort();
    const files: Record<string, string> = {};
    for (const entry of entries) {
      files[entry] = await Bun.file(join(workflowDir(dir), entry, "result.json")).text();
    }
    return { entries, files };
  }

  test("AC-14: the run directories and every result.json are byte-identical afterwards", async () => {
    await withTempDir(async (dir) => {
      await writeResult(dir, "r-old", DRAFT);
      await writeResult(dir, "r-new", DRAFT);
      const before = await snapshot(dir);
      const h = harness();
      await run(h.deps, ["-f", FEATURE, "--json", "-d", dir]);
      expect(await snapshot(dir)).toEqual(before);
    });
  });
});

/** Where the trusted advisor decisions' audit artifacts are written, and where the command looks. */
const outDir = (dir: string): string => join(dir, "out");

/** The real forge deps, with the output directory pointed at the fixture's. */
const forgeFor = (dir: string): WorkflowForgeDeps => ({
  ..._workflowForgeDeps,
  resolveOutputDir: async () => outDir(dir),
});

async function runIn(dir: string, deps: WorkflowCliDeps, argv: string[]): Promise<void> {
  const program = new Command();
  registerWorkflowCommand(program, deps, forgeFor(dir));
  await program.parseAsync(["node", "nax", "workflow", "status", ...argv]);
}

/** One trusted advisor decision and one run ledger line, where #2578's supplementary items come from. */
async function writeSupplementarySources(dir: string, runDir: string): Promise<void> {
  const decision = makeAdviceDecision({
    id: "D-2",
    kind: "finish-approval",
    action: { type: "approve" },
    rationale: "gates green",
    auditRef: `advisor-audit/${FEATURE}/D-2.json`,
  });
  await writeTrustedDecision(dir, FEATURE, outDir(dir), decision);
  await Bun.write(join(runDir, "ledger.md"), "US-001: cannot-verify: Redis TTL\n");
}

const SUPPLEMENTARY = [
  { id: "D-2", kind: "advisor", issue: "finish-approval approve: gates green" },
  { id: "US-001:cv1", kind: "cannot-verify", issue: "Redis TTL" },
];

const READY = { featureWorkflow: featureRecord({ outcome: "ready", passed: true }) };

describe("nax workflow status supplementary items (#2578)", () => {
  test("--json lists them apart from openItems, and they do not change a ready run's exit code", async () => {
    await withTempDir(async (dir) => {
      await writeSupplementarySources(dir, await writeResult(dir, "r1", READY));
      const h = harness();
      await runIn(dir, h.deps, ["-f", FEATURE, "--json", "-d", dir]);
      const report = emittedJson(h.out);
      expect(report.openItems).toEqual([]);
      expect(report.supplementaryItems).toEqual(SUPPLEMENTARY);
      expect(h.codes).toEqual([0]);
    });
  });

  test("--json prints an empty list when there are none", async () => {
    await withTempDir(async (dir) => {
      await writeResult(dir, "r1", DRAFT);
      const h = harness();
      await runIn(dir, h.deps, ["-f", FEATURE, "--json", "-d", dir]);
      expect(emittedJson(h.out).supplementaryItems).toEqual([]);
      expect(h.codes).toEqual([2]);
    });
  });

  test("plain output lists them after the open items, under their own heading", async () => {
    await withTempDir(async (dir) => {
      await writeSupplementarySources(dir, await writeResult(dir, "r1", DRAFT));
      const h = harness();
      await runIn(dir, h.deps, ["-f", FEATURE, "-d", dir]);
      expect(h.out).toEqual([
        "auth: draft https://gh/pr/7",
        "- [advisor] D-1 — advisor held: x",
        "Also to verify (not blocking):",
        "- [advisor] D-2 — finish-approval approve: gates green",
        "- [cannot-verify] US-001:cv1 — Redis TTL",
      ]);
      expect(h.codes).toEqual([2]);
    });
  });
});

describe("nax workflow registration", () => {
  test("AC-15: the cli barrel exports the group and its subcommands", () => {
    const group = registerWorkflowCommand(new Command());
    expect(group.name()).toBe("workflow");
    expect(group.commands.map((c) => c.name())).toEqual(["status", "record", "promote"]);
  });
});
