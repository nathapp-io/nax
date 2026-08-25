/**
 * Assembles a `FinishPrContext` from the artifacts a finish run leaves on disk.
 *
 * Ported from `flows/nax-finish/steps/pr-body.ts` (read-only reference, never
 * imported — `flows/` runs in acpx's own Node process). Every read here is
 * fail-open: the PR body is useful without any one section, and a finish that
 * reached this point has already done all of its real work. Losing the PR to a
 * permissions error on a file most repos do not have is the failure this
 * policy exists to prevent.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { featureDir } from "@/config";
import type { ForgeKind } from "@/forge";
import { defaultForgeDeps, findPrTemplate } from "@/forge";
import { readSpecSummary, resolveNarrative } from "@/operations";
import type { AuditTarget } from "../audit";
import { readRounds } from "../audit";
import { resolveTitle } from "../pr-title";
import type { FinishState } from "../state";
// TemplateMode is re-exported by ../types from @/forge (Task 1, D4.8) --
// import it from ../types like every other finish-side type, not from @/forge.
import type { FinishPrBodySettings, FinishRound, TemplateMode } from "../types";

/** One row in the Stories table. */
export interface FinishPrStory {
  id: string;
  title: string;
  acCount: number;
}

/** Everything the PR body renders, sourced from finish-audit artifacts. */
export interface FinishPrContext {
  feature: string;
  stories: FinishPrStory[];
  outOfScope: string[];
  acceptance?: string;
  regression?: string;
  gatesRan: string[];
  diffstat?: string;
  /**
   * `--shortstat` for the nax artifacts held out of `diffstat`. Absent when the
   * branch touched none, so a repo that gitignores them renders nothing.
   */
  artifactSummary?: string;
  /** Repository PR/MR template, verbatim. Absent when none resolves. */
  template?: string;
  /** How `template` is honoured. Absent → `merge`. See `pr-template-merge.ts`. */
  templateMode?: TemplateMode;
  /** Repo overrides for the template-heading → section-key table. */
  templateSectionMap?: Record<string, string>;
  /** Resolved "What changed" prose. Absent when neither source produced text. */
  narrative?: string;
  /**
   * Resolved conventional-commit PR title. Always set — `resolveTitle` falls
   * back to `feat: <feature>` when the narrative node produced nothing usable.
   */
  title: string;
  rounds: FinishRound[];
  run: {
    durationMs?: number;
    storiesPassed?: number;
    storiesTotal?: number;
  };
}

/** Everything `loadFinishPrContext` needs to assemble the context. */
export interface LoadPrContextArgs {
  state: FinishState;
  /** Where this run's round trail lives. */
  audit: AuditTarget;
  /** The repo's forge, for template discovery. Absent → no template section. */
  forge?: ForgeKind;
  /** The narrative op's prose; falls back to the spec summary when absent. */
  narrative?: string;
  /** The narrative op's conventional-commit subject; falls back to `feat: <feature>`. */
  title?: string;
  /** `FinishPrBodySettings` from `../types` — do not redeclare the shape (D4.8). */
  prBody?: FinishPrBodySettings;
}

export const _finishPrDeps: {
  run(cmd: string[], opts: { cwd: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readText(path: string): Promise<string | null>;
  warn(message: string, details: { path: string; error: unknown }): void;
} = {
  // D4.11 — the shared default, so a finish and an auto-PR spawn subprocesses
  // identically. Never a second local spawner.
  run: defaultForgeDeps.run,
  // ENOENT is the routine case (status.json/prd.json not yet written) and must
  // stay silent — mirrors `_qualityDeps.readText` in `steps/quality.ts`. Only a
  // genuine I/O failure (permission denied, corrupted mount) should warn.
  readText: async (path: string) => {
    try {
      return await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  },
  warn: (message: string, details: { path: string; error: unknown }) =>
    process.emitWarning(message, { detail: `${details.path}: ${String(details.error)}` }),
};

interface PrdArtifact {
  userStories?: { id: string; title: string; acceptanceCriteria?: unknown[] }[];
  outOfScope?: string[];
}

interface StatusArtifact {
  postRun?: { acceptance?: { status?: string }; regression?: { status?: string } };
  durationMs?: number;
  progress?: { passed?: number; total?: number };
}

async function readJson(path: string): Promise<unknown> {
  let text: string | null;
  try {
    text = await _finishPrDeps.readText(path);
  } catch (error) {
    _finishPrDeps.warn("[finish-pr] Failed to read PR context artifact", { path, error });
    return undefined;
  }
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    _finishPrDeps.warn("[finish-pr] Failed to parse PR context artifact", { path, error });
    return undefined;
  }
}

function storiesFrom(prd: PrdArtifact | undefined): FinishPrStory[] {
  if (!Array.isArray(prd?.userStories)) return [];
  // A hand-edited or older-schema PRD can carry a story with a missing/non-string
  // `id`/`title` — drop only that row rather than letting `escapeTableCell` throw
  // and take down the entire PR body (caught upstream by `open_pr`'s fallback).
  return prd.userStories
    .filter((story) => typeof story.id === "string" && typeof story.title === "string")
    .map((story) => ({
      id: story.id,
      title: story.title,
      acCount: Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria.length : 0,
    }));
}

/**
 * Pathspec matching nax's own run artifacts, at any depth.
 *
 * `**` and the `glob` magic word are both load-bearing. nax writes artifacts
 * to a repo-root `.nax/` *and* to a per-package `<pkg>/.nax/` — a root-anchored
 * `:!.nax/**` silently keeps the per-package copy, which is routinely the
 * largest file in the diff (587 of 2039 insertions on the run that motivated
 * this). Without `glob`, git's default wildmatch lets `*` cross `/` and the
 * two forms stop being distinguishable.
 */
const NAX_ARTIFACT_PATHSPEC = "**/.nax/**";

/** The two halves of the branch's diff: what is under review, and what was held out. */
interface DiffstatResult {
  diffstat?: string;
  artifactSummary?: string;
}

/** Run `git diff <...args>` under `workdir`, or `undefined` on any non-happy path. */
async function runGitDiff(workdir: string, args: string[]): Promise<string | undefined> {
  try {
    const res = await _finishPrDeps.run(["git", "diff", ...args], { cwd: workdir });
    if (res.exitCode !== 0) return undefined;
    return res.stdout;
  } catch {
    return undefined;
  }
}

/**
 * Diffstat of the branch, excluding nax's own artifacts.
 *
 * The artifacts (`spec.md`, `prd.json`, the generated acceptance test) are
 * committed and real, but they are the run's exhaust rather than the change
 * under review, and they dominate the totals — quoting them in the headline
 * advertises a 2039-line change where 791 lines are reviewable code.
 * `artifactSummary` keeps them accounted for rather than silently dropped, so
 * the body still reconciles against `gh pr diff`.
 *
 * Fail-open on every non-happy path — a non-zero exit (no commits, divergent
 * branch, base missing), a rejected run promise (forks too slow to start), or
 * any thrown error — returning `undefined`. The PR's Verification block is
 * optional, and a routine empty-branch finish must not lose `open_pr` to a
 * throw that the body can simply skip.
 */
async function runDiffstat(workdir: string, base: string): Promise<DiffstatResult> {
  // An empty `base` would interpolate to `...HEAD`, which git resolves as
  // `HEAD...HEAD` — exit 0, empty stdout — masking the missing-base case as
  // "no changes" instead of skipping explicitly.
  if (!base) return {};
  const range = `${base}...HEAD`;
  const [diffstat, artifacts] = await Promise.all([
    runGitDiff(workdir, ["--stat", range, "--", `:(glob,exclude)${NAX_ARTIFACT_PATHSPEC}`]),
    runGitDiff(workdir, ["--shortstat", range, "--", `:(glob)${NAX_ARTIFACT_PATHSPEC}`]),
  ]);
  const summary = artifacts?.trim();
  return { diffstat, artifactSummary: summary ? summary : undefined };
}

/**
 * Resolve the repository's PR/MR template, fail-open.
 *
 * An absent template is the common case and never warns. A genuine read failure
 * is swallowed too: the body is useful without this section, and `open_pr` must
 * not lose a PR to a permissions error on a file most repos do not have.
 */
async function loadTemplate(workdir: string, forge: ForgeKind | undefined): Promise<string | undefined> {
  if (forge === undefined) return undefined;
  try {
    return (
      (await findPrTemplate(workdir, forge, { run: _finishPrDeps.run, readText: _finishPrDeps.readText })) ?? undefined
    );
  } catch {
    return undefined;
  }
}

export async function loadFinishPrContext(args: LoadPrContextArgs): Promise<FinishPrContext> {
  const featureDirPath = featureDir(args.state.workdir, args.state.feature);
  // [US-004] The audit trail (`rounds`), the diffstat, and the spec summary
  // are independent of the PRD/status reads — fetching them in parallel keeps
  // the loader's wall clock at max(readRounds, readJson×2, diffstat, spec).
  const [prd, status, rounds, stat, template, specSummary] = (await Promise.all([
    readJson(join(featureDirPath, "prd.json")),
    readJson(join(featureDirPath, "status.json")),
    readRounds(args.audit),
    runDiffstat(args.state.workdir, args.state.base),
    loadTemplate(args.state.workdir, args.forge),
    readSpecSummary(args.state.specPath, _finishPrDeps.readText),
  ])) as [
    PrdArtifact | undefined,
    StatusArtifact | undefined,
    FinishRound[],
    DiffstatResult,
    string | undefined,
    string | null,
  ];
  return {
    feature: args.state.feature,
    stories: storiesFrom(prd),
    outOfScope: Array.isArray(prd?.outOfScope) ? prd.outOfScope : [],
    acceptance: status?.postRun?.acceptance?.status,
    regression: status?.postRun?.regression?.status,
    gatesRan: args.state.gatesRan ?? [],
    rounds,
    diffstat: stat.diffstat,
    artifactSummary: stat.artifactSummary,
    template,
    ...(args.prBody?.template !== undefined ? { templateMode: args.prBody.template } : {}),
    ...(args.prBody?.sectionMap !== undefined ? { templateSectionMap: args.prBody.sectionMap } : {}),
    narrative: resolveNarrative(args.narrative, specSummary),
    title: resolveTitle(args.title, args.state.feature),
    run: {
      durationMs: status?.durationMs,
      storiesPassed: status?.progress?.passed,
      storiesTotal: status?.progress?.total,
    },
  };
}
