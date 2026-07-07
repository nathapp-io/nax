/**
 * Auto-PR Plugin — Built-in Post-Run Action
 *
 * After a successful run, opens a draft PR/MR on GitHub or GitLab for the
 * feature branch. Reads `ctx.config.autoPr` for opt-in config, detects the
 * forge from the git remote URL, looks for an existing open PR/MR to skip
 * duplicates, pushes the feature branch to `origin` (required — forges can
 * only resolve a head ref that already exists on the remote), and shells out
 * to `gh` / `glab` to create the draft.
 *
 * Fail-open: a failed PR open never fails the run. The post-run driver in
 * `run-cleanup.ts` already swallows thrown exceptions and logs `{ success: false }`
 * as a non-blocking warning.
 */

import * as path from "node:path";
import type { IPostRunAction, NaxPlugin, PluginLogger, PostRunActionResult, PostRunContext } from "@/plugins/types";
import { detectForge as _detectForge, hasOpenPr as _hasOpenPr, openDraft as _openDraft } from "./forge";
import { type PrBodyContext, buildBody, buildTitle } from "./pr-body";
import { findPrTemplate as _findPrTemplate } from "./template";
import type { AutoPrConfig, AutoPrDeps } from "./types";

const PLUGIN_NAME = "nax-auto-pr";
const PLUGIN_VERSION = "0.1.0";

const GIT_REMOTE_CMD: readonly string[] = ["git", "remote", "get-url", "origin"] as const;

/**
 * Default subprocess runner — wraps Bun.spawn with concurrent stdout/stderr
 * reads so non-trivial output does not deadlock. Tests override `_autoPrDeps.run`.
 */
async function defaultRun(
  cmd: string[],
  opts: { cwd: string },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/**
 * Default UTF-8 reader — returns `null` on missing files so callers can probe
 * the candidate template paths without try/catch noise.
 */
async function defaultReadText(path: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return file.text();
}

/**
 * Default git remote resolver — best-effort; returns `null` for non-git
 * directories or remotes the caller cannot resolve.
 */
async function defaultGetRemoteUrl(workdir: string): Promise<string | null> {
  const result = await _autoPrDeps.run([...GIT_REMOTE_CMD], { cwd: workdir });
  if (result.exitCode !== 0) return null;
  const trimmed = result.stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Module-level deps for testability (`_deps` pattern).
 *
 * Production callers read through these references; tests mutate fields on the
 * exported object to inject fakes without `mock.module()`.
 */
export const _autoPrDeps: {
  run: AutoPrDeps["run"];
  readText: AutoPrDeps["readText"];
  getRemoteUrl: (workdir: string) => Promise<string | null>;
  detectForge: typeof _detectForge;
  hasOpenPr: typeof _hasOpenPr;
  openDraft: typeof _openDraft;
  findPrTemplate: typeof _findPrTemplate;
} = {
  run: defaultRun,
  readText: defaultReadText,
  getRemoteUrl: defaultGetRemoteUrl,
  detectForge: _detectForge,
  hasOpenPr: _hasOpenPr,
  openDraft: _openDraft,
  findPrTemplate: _findPrTemplate,
};

/** Read the loose `autoPr` block from `ctx.config`. Defaults to enabled=false. */
function getAutoPrConfig(context: PostRunContext): AutoPrConfig {
  const cfg = context.config as Record<string, unknown> | undefined;
  if (!cfg) return { enabled: false, draft: true };
  const autoPr = cfg.autoPr as Partial<AutoPrConfig> | undefined;
  if (!autoPr) return { enabled: false, draft: true };
  return {
    enabled: autoPr.enabled === true,
    draft: autoPr.draft !== false,
  };
}

/** `PostRunContext` already exposes a tightly-typed `paused` count. */
function getStorySummary(context: PostRunContext): PostRunContext["storySummary"] {
  return context.storySummary;
}

/**
 * Render the PRD path repo-relative so the PR body never leaks an absolute
 * local filesystem path (e.g. `/Users/alice/workspace/.../prd.json`). When the
 * PRD lives outside the workdir (`..`-relative) or `prdPath` is empty, fall back
 * to the raw value rather than emitting a misleading relative path.
 */
function relativePrdPath(workdir: string, prdPath: string): string {
  if (!prdPath) return prdPath;
  const rel = path.relative(workdir, prdPath);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : prdPath;
}

/** Sub-context handed to the pure body builders (does not include `paused`). */
function toPrBodyContext(context: PostRunContext): PrBodyContext {
  const summary = getStorySummary(context);
  return {
    feature: context.feature,
    totalCost: context.totalCost,
    totalDurationMs: context.totalDurationMs,
    prdPath: relativePrdPath(context.workdir, context.prdPath),
    storySummary: {
      completed: summary.completed,
      failed: summary.failed,
      skipped: summary.skipped,
    },
    stories: context.stories,
  };
}

/**
 * Auto-PR post-run action implementation.
 */
const autoPrAction: IPostRunAction = {
  name: PLUGIN_NAME,
  description: "Opens a draft PR/MR after a successful nax run",

  async shouldRun(context: PostRunContext): Promise<boolean> {
    const cfg = getAutoPrConfig(context);
    if (!cfg.enabled) return false;

    const summary = getStorySummary(context);
    if (summary.completed === 0) return false;
    if (summary.failed > 0) return false;
    if (summary.paused > 0) return false;

    const remoteUrl = await _autoPrDeps.getRemoteUrl(context.workdir);
    if (!remoteUrl) return false;

    const forge = _autoPrDeps.detectForge(remoteUrl);
    if (!forge) return false;

    const exists = await _autoPrDeps.hasOpenPr(
      forge,
      context.branch,
      {
        run: _autoPrDeps.run,
        readText: _autoPrDeps.readText,
      },
      context.workdir,
    );
    if (exists) {
      context.logger.warn("Skipping auto-PR — open PR/MR already exists for branch", {
        branch: context.branch,
        forge,
      });
      return false;
    }

    return true;
  },

  async execute(context: PostRunContext): Promise<PostRunActionResult> {
    try {
      const cfg = getAutoPrConfig(context);
      const remoteUrl = await _autoPrDeps.getRemoteUrl(context.workdir);
      if (!remoteUrl) {
        return { success: false, message: "Could not resolve git remote URL" };
      }
      const forge = _autoPrDeps.detectForge(remoteUrl);
      if (!forge) {
        return { success: false, message: "Remote host is not GitHub or GitLab" };
      }

      const pushResult = await _autoPrDeps.run(["git", "push", "-u", "origin", context.branch], {
        cwd: context.workdir,
      });
      if (pushResult.exitCode !== 0) {
        const message = pushResult.stderr.trim() || `git push exited with code ${pushResult.exitCode}`;
        return { success: false, message: `Failed to push branch "${context.branch}" to origin: ${message}` };
      }

      const template = await _autoPrDeps.findPrTemplate(context.workdir, forge, {
        run: _autoPrDeps.run,
        readText: _autoPrDeps.readText,
      });

      const prCtx = toPrBodyContext(context);
      const title = buildTitle(prCtx);
      const body = buildBody(prCtx, template);

      return await _autoPrDeps.openDraft(
        forge,
        { title, body, branch: context.branch, draft: cfg.draft },
        { run: _autoPrDeps.run, readText: _autoPrDeps.readText },
        context.workdir,
      );
    } catch (err) {
      context.logger.warn("Auto-PR execute failed", { error: String(err) });
      return { success: false, message: `Auto-PR failed: ${String(err)}` };
    }
  },
};

/**
 * Built-in auto-PR plugin.
 */
export const autoPrPlugin: NaxPlugin = {
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  provides: ["post-run-action"],

  async setup(_config: Record<string, unknown>, _logger: PluginLogger): Promise<void> {
    // No initialization required
  },

  async teardown(): Promise<void> {
    // No cleanup required
  },

  extensions: {
    postRunAction: autoPrAction,
  },
};
