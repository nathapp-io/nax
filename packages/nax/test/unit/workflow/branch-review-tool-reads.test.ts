/**
 * US-009 — the branch review credits the files its own session actually read.
 *
 * A slice's `inspectedFiles` list is self-reported. The tool audit holds what the session really
 * did, so after the last slice the review reads this run's `wf-branch-review` ledger and drops the
 * files it credits from `unreadFiles` — and from there only: observations never enter the verdict's
 * `inspectedFiles`, so a verdict's provenance stays exactly what the reviewer said.
 *
 * `_reviewToolReadsDeps.glob` / `.readText` stand in for the audit tree, so the assertions can
 * count the scans (AC-3 and AC-4 turn on the loader NOT being reached) and place a ledger in the
 * canonical directory without touching the disk. AC-7 is the exception: its whole point is the real
 * scan of a directory that is not there, so it wraps the real `glob` instead of replacing it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { basename, dirname } from "node:path";
import type { ToolCallRecord } from "@nathapp/nax-agent";
import {
  cleanupTempDir,
  makeFeatureContext,
  makeResolvedTestPatterns,
  makeScriptedCallOp,
  makeTempDir,
} from "@test/helpers";
import { toolAuditDir } from "@/config/paths";
import { _branchReviewDeps, runBranchReview } from "@/workflow/branch-review";
import type { BranchStepContext } from "@/workflow/branch-step-context";
import { _reviewToolReadsDeps, TOOL_READ_CREDIT_MAX_BYTES } from "@/workflow/review-tool-reads";
import { _workflowDeps } from "@/workflow/step-context";
import type { BranchReviewVerdict } from "@/workflow/types";

const originalWorkflowDeps = { ..._workflowDeps };
const originalBranchDeps = { ..._branchReviewDeps };
const originalToolReadsDeps = { ..._reviewToolReadsDeps };
const dirs: string[] = [];

afterEach(async () => {
  Object.assign(_workflowDeps, originalWorkflowDeps);
  Object.assign(_branchReviewDeps, originalBranchDeps);
  Object.assign(_reviewToolReadsDeps, originalToolReadsDeps);
  await Promise.all(dirs.splice(0).map(cleanupTempDir));
});

const AT = "2026-01-01T00:00:00.000Z";
const RUN_ID = "r1";
/** `<feature>-<sessionRole>`: the name the dispatch writes for this review's session. */
const SESSION = "f-wf-branch-review";
/** When the first slice started, as `_workflowDeps.now()` reports it. */
const START = 1_700_000_000_000;
/** The branch's changed files, and therefore the review's required set. */
const REQUIRED = ["src/a.ts", "src/b.ts", "src/c.ts"];

const facts = { stories: [], minors: [], parked: [], cannotVerify: [], gateFindings: [] };

/** A branch-review context over its own temp run dir, with the branch changing exactly `files`. */
function context(over: Partial<BranchStepContext> = {}, files: readonly string[] = REQUIRED): BranchStepContext {
  const runDir = makeTempDir("wf-br-tool-reads-");
  dirs.push(runDir);
  _workflowDeps.now = () => START;
  const changes = files.map((file) => `M\0${file}`).join("\0");
  _workflowDeps.git = async (args) => ({
    stdout: args.includes("--name-status") ? `${changes}\0` : "",
    exitCode: 0,
  });
  // No path is classified as a test file, so every changed path stays in the required set.
  _workflowDeps.resolveTestPatterns = async () => makeResolvedTestPatterns({ regex: [] });
  return { ...makeFeatureContext({ runDir }), ...over };
}

/** The review session's ledger dir — the helper the dispatch writes through, not a re-spelling. */
function auditDirOf(ctx: BranchStepContext): string {
  return toolAuditDir({ root: ctx.projectDir, outputDir: ctx.outputDir ?? "" }, ctx.feature);
}

/** An in-memory audit tree: directory → file name → parsed body. */
type AuditTree = Map<string, Map<string, unknown>>;

/** One ledger file for this run's review session, holding `calls`, stamped `stamp`. */
function ledger(ctx: BranchStepContext, calls: readonly ToolCallRecord[], stamp = START + 1_000): AuditTree {
  const name = `${RUN_ID}-${stamp}-${SESSION}.json`;
  return new Map([[auditDirOf(ctx), new Map([[name, { schemaVersion: 1, sessionName: SESSION, calls }]])]]);
}

/** Swap the loader's file seams for `tree`; returns the directories each scan asked for. */
function stubAudit(tree: AuditTree): string[] {
  const scanned: string[] = [];
  _reviewToolReadsDeps.glob = async (_pattern, cwd) => {
    scanned.push(cwd);
    return [...(tree.get(cwd)?.keys() ?? [])];
  };
  _reviewToolReadsDeps.readText = async (path) => {
    const body = tree.get(dirname(path))?.get(basename(path));
    if (body === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
    return JSON.stringify(body);
  };
  return scanned;
}

/** A whole-file `Read`, the shape `toolReadPaths` credits. */
function readCall(path: string): ToolCallRecord {
  return { tool: "Read", outcome: "ok", input: { path }, resultBytes: 200, at: AT, truncated: false };
}

/** A `git diff` of `paths` whose result reached the model `resultBytes` long. */
function diffCall(paths: readonly string[], resultBytes: number): ToolCallRecord {
  return { tool: "Git", outcome: "ok", input: { subcommand: "diff", paths }, resultBytes, at: AT, truncated: false };
}

/** A branch-review reply that says it inspected `inspectedFiles`. */
function verdict(inspectedFiles: readonly string[]): BranchReviewVerdict {
  return { spec: "pass", quality: "approved", findings: [], cannotVerify: [], inspectedFiles, minorTriage: [] };
}

/** Script the one slice's reply, and run the review over `ctx`. */
async function review(ctx: BranchStepContext, inspectedFiles: readonly string[]) {
  _workflowDeps.callOp = makeScriptedCallOp(() => verdict(inspectedFiles));
  const out = await runBranchReview(ctx, { seed: "seed0", facts });
  if (!out.ran) throw new Error(`the branch review did not run: ${out.why}`);
  return out.verdict;
}

describe("runBranchReview — tool-observed reads", () => {
  test("a Read of a required file no slice listed leaves it out of unreadFiles (AC-1)", async () => {
    const ctx = context();
    const scanned = stubAudit(ledger(ctx, [readCall("src/b.ts")]));

    const result = await review(ctx, ["src/a.ts", "src/c.ts"]);

    expect(scanned).toEqual([auditDirOf(ctx)]);
    expect(result.unreadFiles ?? []).not.toContain("src/b.ts");
    expect(result.unreadFiles ?? []).toEqual([]);
  });

  test("a Read of a file outside the required set adds nothing anywhere (AC-2)", async () => {
    const ctx = context();
    const scanned = stubAudit(ledger(ctx, [readCall("docs/notes.md")]));

    const result = await review(ctx, ["src/a.ts", "src/b.ts"]);

    expect(scanned).toEqual([auditDirOf(ctx)]);
    // The one required file the slice did not list is still the whole unread list.
    expect(result.unreadFiles).toEqual(["src/c.ts"]);
    // Evidence affects the unread list only — never what the reviewer is recorded as having read.
    expect(result.inspectedFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("with no runId the audit is never read (AC-3)", async () => {
    const ctx = context({ runId: undefined });
    // The ledger sits in the canonical dir a read would scan, so a missing guard credits src/b.ts.
    const scanned = stubAudit(ledger(ctx, [readCall("src/b.ts")]));

    const result = await review(ctx, ["src/a.ts"]);

    expect(scanned).toEqual([]);
    expect(result.unreadFiles).toEqual(["src/b.ts", "src/c.ts"]);
  });

  test("with no outputDir the audit is never read (AC-4)", async () => {
    const ctx = context({ outputDir: undefined });
    // `auditDirOf` resolves the same repo-local fallback `toolAuditDir` gives a run with no output
    // dir, so this ledger is exactly the one an unguarded read would find.
    const scanned = stubAudit(ledger(ctx, [readCall("src/b.ts")]));

    const result = await review(ctx, ["src/a.ts"]);

    expect(scanned).toEqual([]);
    expect(result.unreadFiles).toEqual(["src/b.ts", "src/c.ts"]);
  });

  test("no recorded calls leave the required files no slice listed unread (AC-5)", async () => {
    const ctx = context();
    // The session's file is there but holds no calls: empty evidence, not absent evidence.
    const scanned = stubAudit(new Map([[auditDirOf(ctx), new Map<string, unknown>()]]));

    const result = await review(ctx, ["src/a.ts"]);

    expect(scanned).toEqual([auditDirOf(ctx)]);
    expect(result.unreadFiles).toEqual(["src/b.ts", "src/c.ts"]);
  });

  test("a diff too large to have reached the model uncut credits nothing (AC-6)", async () => {
    const ctx = context();
    const scanned = stubAudit(ledger(ctx, [diffCall(["src/b.ts"], TOOL_READ_CREDIT_MAX_BYTES + 1)]));

    const result = await review(ctx, ["src/a.ts", "src/c.ts"]);

    expect(scanned).toEqual([auditDirOf(ctx)]);
    expect(result.unreadFiles).toEqual(["src/b.ts"]);
  });

  test("an absent audit directory leaves the review unchanged but for the credit (AC-7)", async () => {
    const outputDir = makeTempDir("wf-br-no-audit-");
    dirs.push(outputDir);
    const ctx = context({ outputDir });
    const scanned: string[] = [];
    const realGlob = _reviewToolReadsDeps.glob;
    _reviewToolReadsDeps.glob = async (pattern, cwd) => {
      scanned.push(cwd);
      return realGlob(pattern, cwd);
    };

    const result = await review(ctx, ["src/a.ts"]);

    // The canonical directory really is where it looked, and it really was not there.
    expect(scanned).toEqual([auditDirOf(ctx)]);
    expect(result.unreadFiles).toEqual(["src/b.ts", "src/c.ts"]);
  });

  test("a call stamped before the review started credits nothing", async () => {
    const ctx = context();
    const scanned = stubAudit(ledger(ctx, [readCall("src/b.ts")], START - 1));

    const result = await review(ctx, ["src/a.ts", "src/c.ts"]);

    expect(scanned).toEqual([auditDirOf(ctx)]);
    expect(result.unreadFiles).toEqual(["src/b.ts"]);
  });

  test("the ledger is read only after the last slice has resolved", async () => {
    const ctx = context();
    const order: string[] = [];
    _workflowDeps.callOp = makeScriptedCallOp(async () => {
      await Promise.resolve();
      order.push("slice");
      return verdict(REQUIRED);
    });
    _reviewToolReadsDeps.glob = async () => {
      order.push("audit");
      return [];
    };

    await runBranchReview(ctx, { seed: "seed0", facts });

    // The audit is flushed when the hop ends, so a read taken inside the slice would see nothing.
    expect(order).toEqual(["slice", "audit"]);
  });

  test("direct and part reads share one audit load", async () => {
    const ctx = context();
    const part = { path: "/run/part.diff", files: ["src/c.ts"] };
    _branchReviewDeps.writeBranchDiffParts = async () => [part];
    const scanned = stubAudit(ledger(ctx, [readCall("src/b.ts"), readCall(part.path)]));
    let dispatched = 0;
    _workflowDeps.callOp = makeScriptedCallOp(() => {
      dispatched++;
      return verdict(["src/a.ts"]);
    });
    const out = await runBranchReview(ctx, { seed: "seed0", facts });
    if (!out.ran) throw new Error("the branch review must run");
    expect(dispatched).toBe(1);
    expect(scanned).toEqual([auditDirOf(ctx)]);
    expect(out.verdict.unreadFiles ?? []).toEqual([]);
    expect(out.verdict.inspectedFiles).toEqual(["src/a.ts"]);
  });
});
