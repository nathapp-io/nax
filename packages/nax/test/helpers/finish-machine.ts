import type { AcceptanceGroupResult } from "@/cli";
import type { FinishContext, FinishOps, FinishReviewOutput, FinishState, HandoffRecord } from "@/finish";
import { _finishGitDeps, createFinishState } from "@/finish";

/** A stopped `review` handoff of run-1, as `setAside` would record it. */
export function makeHandoffRecord(auditDir: string, over: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    n: 1,
    dir: `${auditDir}/run-1.handoff-1`,
    phase: "review",
    limit: "fix",
    baseSha: "sha1",
    headSha: "sha1",
    findingIds: [],
    newUntracked: [],
    changedPaths: [],
    stoppedAt: "t",
    hasNote: false,
    patchSaved: true,
    restored: true,
    consumed: false,
    untrackedRestored: [],
    untrackedMovedAside: [],
    untrackedFailed: [],
    ...over,
  };
}

export function makeFinishContext(overrides: Partial<FinishContext> = {}): FinishContext {
  const group: AcceptanceGroupResult = {
    packageDir: "",
    testPath: "test/acceptance/feat.test.ts",
    exists: true,
    cwd: "",
  };
  return {
    base: "origin/main",
    specPath: ".nax/features/feat/spec.md",
    acceptanceStatus: "ok",
    groups: [group],
    testFileRegex: ["\\.test\\.ts$"],
    commitsAhead: 3,
    route: "proceed",
    ...overrides,
  };
}

export function makeFinishState(overrides: Partial<FinishState> = {}): FinishState {
  const state = createFinishState({
    feature: "feat",
    workdir: "/repo",
    branch: "feat/x",
    runId: "run-1",
    base: "origin/main",
    specPath: ".nax/features/feat/spec.md",
  });
  return { ...state, ...overrides };
}

export const CLEAN_REVIEW: FinishReviewOutput = { findings: [], covered: [] };

/** Scripted A4 ops: each review call shifts the next scripted output (default clean). Records a call trail. */
export function makeFinishOps(
  trail: string[],
  script: { spec?: FinishReviewOutput[]; quality?: FinishReviewOutput[] } = {},
  overrides: Partial<FinishOps> = {},
): FinishOps {
  const spec = [...(script.spec ?? [])];
  const quality = [...(script.quality ?? [])];
  return {
    reviewSpec: async () => {
      trail.push("review:spec");
      return spec.shift() ?? CLEAN_REVIEW;
    },
    reviewBranch: async () => {
      trail.push("review:quality");
      return quality.shift() ?? CLEAN_REVIEW;
    },
    fix: async (phase) => {
      trail.push(`fix:${phase}`);
      return {};
    },
    openDraftPr: async () => {
      trail.push("openDraftPr");
      return { url: "https://x/pr/1" };
    },
    promotePr: async () => {
      trail.push("promotePr");
      return { status: "promoted", url: "https://x/pr/1" };
    },
    finalizeDraftPr: async () => {
      trail.push("finalizeDraftPr");
      return { status: "draft", url: "https://x/pr/1" };
    },
    ...overrides,
  };
}

/** Mutable git model behind {@link installFinishGit}: HEAD advances on every commit; a fixer sets `dirty`. */
export interface FinishGitModel {
  dirty: boolean;
  head: number;
  /** What `git show --name-only` reports for a fix commit (newline-separated). Default: one production file. */
  files?: string;
  /** What `changedFiles()` (`diff --name-only <base>...HEAD`) reports. */
  changedFiles?: string[];
  /** When true, `git apply` fails (a handoff re-apply that no longer fits). */
  applyFails?: boolean;
}

type GitResult = { exitCode: number; stdout: string; stderr: string };
const ok = (stdout = ""): GitResult => ({ exitCode: 0, stdout, stderr: "" });

function diffResult(model: FinishGitModel, args: string[]): GitResult | undefined {
  if (args.includes("--name-only")) {
    // changedFiles() diffs `<base>...HEAD`; set-aside diffs one sha against the tree
    if (args.some((a) => a.includes("..."))) return ok((model.changedFiles ?? []).join("\n"));
    return ok(model.dirty ? `a.ts${args.includes("-z") ? "\0" : "\n"}` : "");
  }
  if (args.includes("--binary")) return ok(model.dirty ? "diff --git a/a.ts b/a.ts\n" : "");
  if (args.includes("--cached")) return { exitCode: model.dirty ? 1 : 0, stdout: "", stderr: "" };
  return undefined;
}

function applyResult(model: FinishGitModel, args: string[], trail?: string[]): GitResult {
  if (args.includes("--numstat")) return ok(`1\t1\ta.ts${args.includes("-z") ? "\0" : "\n"}`);
  const failed: GitResult = { exitCode: 1, stdout: "", stderr: "conflict" };
  if (args.includes("--check")) {
    trail?.push("apply-check");
    return model.applyFails ? failed : ok();
  }
  // Every real apply is recorded, a failing one too: "no apply after a failed check" must be observable.
  trail?.push("apply");
  if (model.applyFails) return failed;
  model.dirty = true;
  return ok();
}

function gitResult(model: FinishGitModel, args: string[], trail?: string[]): GitResult {
  switch (args[0]) {
    case "rev-parse":
      return args.includes("--show-toplevel") ? ok("/repo\n") : ok(`sha${model.head}\n`);
    case "stash":
      return ok(model.dirty ? "stashsha\n" : "");
    case "ls-tree":
      return ok("a.ts\0"); // a.ts is in every base
    case "status":
      return ok(model.dirty ? " M a.ts\n" : "");
    case "diff":
      return diffResult(model, args) ?? ok();
    case "apply":
      return applyResult(model, args, trail);
    case "restore":
      trail?.push("restore");
      model.dirty = false;
      return ok();
    case "commit":
      trail?.push("commit");
      model.head += 1;
      model.dirty = false;
      return ok();
    case "show":
      return ok(`${model.files ?? "src/prod.ts"}\n`);
    default:
      return ok();
  }
}

/**
 * Stubs `_finishGitDeps.git` so `commitFixes` commits exactly when `model.dirty` is set, and the
 * set-aside / re-apply commands follow the same model. Returns a restore function for `afterEach`.
 * `commit`, `restore` and `apply` are appended to `trail` when given.
 */
export function installFinishGit(model: FinishGitModel, trail?: string[]): () => void {
  const original = _finishGitDeps.git;
  _finishGitDeps.git = async (rawArgs) => {
    // set-aside runs every git call with a leading `--literal-pathspecs`
    const args = rawArgs[0] === "--literal-pathspecs" ? rawArgs.slice(1) : rawArgs;
    return gitResult(model, args, trail);
  };
  return () => {
    _finishGitDeps.git = original;
  };
}
