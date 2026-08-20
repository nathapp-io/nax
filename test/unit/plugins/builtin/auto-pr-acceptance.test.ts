/**
 * Auto-PR Plugin — Acceptance Criteria Tests
 *
 * Mirrors every AC for the assembly story:
 *  - AC1: shouldRun returns false when config.autoPr.enabled === false
 *  - AC2: shouldRun returns false when storySummary.failed > 0
 *  - AC3: shouldRun returns false when storySummary.paused > 0
 *  - AC4: shouldRun returns false when storySummary.completed === 0
 *  - AC5: shouldRun returns false when detectForge returns null
 *  - AC6: shouldRun returns false when hasOpenPr reports an existing PR
 *  - AC7: shouldRun returns true on the happy path
 *  - AC8: execute invokes openDraft with buildTitle/buildBody and returns success+url
 *  - AC9: execute returns { success: false } when openDraft reports forge failure
 *  - AC10: execute returns { success: false } + logger.warn when openDraft throws
 *  - AC11: loadPlugins registers "nax-auto-pr" when not in the disabled set
 *
 * The plugin module exposes `_autoPrDeps` for test injection — no mock.module().
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { loadPlugins } from "@/plugins";
import type { PostRunContext } from "@/plugins/extensions";
import { makeStory } from "@test/helpers";
import { _autoPrDeps, autoPrPlugin } from "@/plugins/builtin/auto-pr";
import { buildBody, buildTitle } from "@/plugins/builtin/auto-pr/pr-body";
import type { AutoPrDeps } from "@/plugins/builtin/auto-pr/types";

const PLUGIN_NAME = "nax-auto-pr";

function makeContext(overrides: Partial<PostRunContext> = {}): PostRunContext {
  return {
    runId: "run-1",
    feature: "auto-pr-plugin",
    workdir: "/tmp/workdir",
    prdPath: "/tmp/workdir/prd.json",
    branch: "nax/auto-pr",
    totalDurationMs: 60_000,
    totalCost: 0.42,
    storySummary: { completed: 2, failed: 0, skipped: 0, paused: 0 },
    stories: [
      makeStory({ id: "US-001", title: "Config", acceptanceCriteria: ["a"] }),
      makeStory({ id: "US-002", title: "Helpers", acceptanceCriteria: ["a"] }),
    ],
    version: "0.1.0",
    pluginConfig: {},
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    config: { autoPr: { enabled: true, draft: true } },
    ...overrides,
  };
}

function makeDeps(): AutoPrDeps {
  return {
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    readText: async () => null,
  };
}

let saved: typeof _autoPrDeps;

beforeEach(() => {
  saved = {
    run: _autoPrDeps.run,
    readText: _autoPrDeps.readText,
    getRemoteUrl: _autoPrDeps.getRemoteUrl,
    detectForge: _autoPrDeps.detectForge,
    hasOpenPr: _autoPrDeps.hasOpenPr,
    openDraft: _autoPrDeps.openDraft,
    findPrTemplate: _autoPrDeps.findPrTemplate,
  };
  _autoPrDeps.run = makeDeps().run;
  _autoPrDeps.readText = makeDeps().readText;
  _autoPrDeps.getRemoteUrl = async () => "https://github.com/owner/repo.git";
  _autoPrDeps.detectForge = (() => "github") as typeof _autoPrDeps.detectForge;
  _autoPrDeps.hasOpenPr = (async () => false) as typeof _autoPrDeps.hasOpenPr;
  _autoPrDeps.openDraft = (async () => ({ success: true, message: "ok" })) as typeof _autoPrDeps.openDraft;
  _autoPrDeps.findPrTemplate = (async () => null) as typeof _autoPrDeps.findPrTemplate;
});

afterEach(() => {
  _autoPrDeps.run = saved.run;
  _autoPrDeps.readText = saved.readText;
  _autoPrDeps.getRemoteUrl = saved.getRemoteUrl;
  _autoPrDeps.detectForge = saved.detectForge;
  _autoPrDeps.hasOpenPr = saved.hasOpenPr;
  _autoPrDeps.openDraft = saved.openDraft;
  _autoPrDeps.findPrTemplate = saved.findPrTemplate;
});

// ─── Plugin metadata ────────────────────────────────────────────────────────

describe("autoPrPlugin — metadata", () => {
  test("name is nax-auto-pr", () => {
    expect(autoPrPlugin.name).toBe(PLUGIN_NAME);
  });

  test("provides a post-run-action extension", () => {
    expect(autoPrPlugin.provides).toContain("post-run-action");
    expect(autoPrPlugin.extensions.postRunAction).toBeDefined();
    expect(autoPrPlugin.extensions.postRunAction?.name).toBe(PLUGIN_NAME);
  });
});

// ─── AC1–AC7: shouldRun ─────────────────────────────────────────────────────

describe("autoPrPlugin.shouldRun", () => {
  test("AC1 — returns false when ctx.config.autoPr.enabled === false", async () => {
    const ctx = makeContext({ config: { autoPr: { enabled: false, draft: true } } });
    expect(await autoPrPlugin.extensions.postRunAction!.shouldRun(ctx)).toBe(false);
  });

  test("AC2 — returns false when ctx.storySummary.failed > 0", async () => {
    const ctx = makeContext({
      storySummary: { completed: 1, failed: 1, skipped: 0, paused: 0 },
    });
    expect(await autoPrPlugin.extensions.postRunAction!.shouldRun(ctx)).toBe(false);
  });

  test("AC3 — returns false when ctx.storySummary.paused > 0", async () => {
    const ctx = makeContext({
      storySummary: { completed: 1, failed: 0, skipped: 0, paused: 1 },
    });
    expect(await autoPrPlugin.extensions.postRunAction!.shouldRun(ctx)).toBe(false);
  });

  test("AC4 — returns false when ctx.storySummary.completed === 0", async () => {
    const ctx = makeContext({
      storySummary: { completed: 0, failed: 0, skipped: 0, paused: 0 },
    });
    expect(await autoPrPlugin.extensions.postRunAction!.shouldRun(ctx)).toBe(false);
  });

  test("AC5 — returns false when detectForge returns null", async () => {
    _autoPrDeps.detectForge = (() => null) as typeof _autoPrDeps.detectForge;
    const ctx = makeContext();
    expect(await autoPrPlugin.extensions.postRunAction!.shouldRun(ctx)).toBe(false);
  });

  test("AC6 — returns false when hasOpenPr reports an existing PR and logs skip reason", async () => {
    let warned: { message: string; data?: Record<string, unknown> } | null = null;
    _autoPrDeps.hasOpenPr = (async () => true) as typeof _autoPrDeps.hasOpenPr;
    const ctx = makeContext({
      logger: {
        debug: () => {},
        info: () => {},
        warn: (message, data) => {
          warned = { message, ...(data !== undefined ? { data } : {}) };
        },
        error: () => {},
      },
    });

    expect(await autoPrPlugin.extensions.postRunAction!.shouldRun(ctx)).toBe(false);
    expect(warned).not.toBeNull();
    expect(warned?.message.toLowerCase()).toContain("open pr");
  });

  test("AC7 — returns true on the happy path", async () => {
    const ctx = makeContext();
    expect(await autoPrPlugin.extensions.postRunAction!.shouldRun(ctx)).toBe(true);
  });
});

// ─── AC8–AC10: execute ──────────────────────────────────────────────────────

describe("autoPrPlugin.execute", () => {
  test("AC8 — invokes openDraft with buildTitle/buildBody and returns success+url", async () => {
    const captured: Array<{ title: string; body: string; branch: string; draft: boolean }> = [];
    _autoPrDeps.openDraft = (async (_forge, input) => {
      captured.push({
        title: input.title,
        body: input.body,
        branch: input.branch,
        draft: input.draft,
      });
      return {
        success: true,
        message: "Opened PR",
        url: "https://github.com/owner/repo/pull/42",
      };
    }) as typeof _autoPrDeps.openDraft;

    const ctx = makeContext({
      config: { autoPr: { enabled: true, draft: true } },
    });

    const result = await autoPrPlugin.extensions.postRunAction!.execute(ctx);

    expect(result.success).toBe(true);
    expect(result.url).toBe("https://github.com/owner/repo/pull/42");
    expect(captured.length).toBe(1);

    const expectedTitle = buildTitle({
      feature: ctx.feature,
      totalDurationMs: ctx.totalDurationMs,
      prdPath: ctx.prdPath,
      storySummary: {
        completed: ctx.storySummary.completed,
        failed: ctx.storySummary.failed,
        skipped: ctx.storySummary.skipped,
      },
      stories: ctx.stories,
    });
    // execute() relativizes prdPath against the workdir so the PR body never
    // leaks an absolute local path.
    const relPrdPath = relative(ctx.workdir, ctx.prdPath);
    const expectedBody = buildBody(
      {
        feature: ctx.feature,
        totalDurationMs: ctx.totalDurationMs,
        prdPath: relPrdPath,
        storySummary: {
          completed: ctx.storySummary.completed,
          failed: ctx.storySummary.failed,
          skipped: ctx.storySummary.skipped,
        },
        stories: ctx.stories,
      },
      null,
    );

    expect(captured[0]?.title).toBe(expectedTitle);
    expect(captured[0]?.body).toBe(expectedBody);
    expect(captured[0]?.branch).toBe(ctx.branch);
    expect(captured[0]?.draft).toBe(true);
    // Guard against absolute-path leakage in the rendered body.
    expect(captured[0]?.body).toContain(`- PRD: ${relPrdPath}`);
    expect(captured[0]?.body).not.toContain(`- PRD: ${ctx.prdPath}`);
  });

  test("AC8b — pushes the branch to origin before calling openDraft", async () => {
    const pushCalls: string[][] = [];
    const openDraftCalls: string[] = [];
    _autoPrDeps.run = (async (cmd: string[]) => {
      pushCalls.push(cmd);
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as typeof _autoPrDeps.run;
    _autoPrDeps.openDraft = (async () => {
      openDraftCalls.push("called");
      return { success: true, message: "ok" };
    }) as typeof _autoPrDeps.openDraft;

    const ctx = makeContext();
    const result = await autoPrPlugin.extensions.postRunAction!.execute(ctx);

    expect(result.success).toBe(true);
    expect(pushCalls).toContainEqual(["git", "push", "-u", "origin", ctx.branch]);
    expect(openDraftCalls).toEqual(["called"]);
  });

  test("AC8c — returns { success: false } and never calls openDraft when git push fails", async () => {
    _autoPrDeps.run = (async (cmd: string[]) => {
      if (cmd[0] === "git" && cmd[1] === "push") {
        return { exitCode: 1, stdout: "", stderr: "remote: Permission denied" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as typeof _autoPrDeps.run;
    let openDraftCalled = false;
    _autoPrDeps.openDraft = (async () => {
      openDraftCalled = true;
      return { success: true, message: "ok" };
    }) as typeof _autoPrDeps.openDraft;

    const ctx = makeContext();
    const result = await autoPrPlugin.extensions.postRunAction!.execute(ctx);

    expect(result.success).toBe(false);
    expect(result.message).toContain(ctx.branch);
    expect(result.message).toContain("Permission denied");
    expect(openDraftCalled).toBe(false);
  });

  test("AC9 — returns { success: false } when openDraft reports forge failure and does not throw", async () => {
    _autoPrDeps.openDraft = (async () => ({
      success: false,
      message: "gh: not authenticated",
    })) as typeof _autoPrDeps.openDraft;

    const ctx = makeContext();
    let threw = false;
    let result;
    try {
      result = await autoPrPlugin.extensions.postRunAction!.execute(ctx);
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(result?.success).toBe(false);
    expect(typeof result?.message).toBe("string");
  });

  test("AC10 — returns { success: false }, calls ctx.logger.warn, and never calls console.* when openDraft throws", async () => {
    const originalConsole = {
      log: console.log,
      warn: console.warn,
      error: console.error,
      info: console.info,
      debug: console.debug,
    };
    const consoleCalls: string[] = [];
    const spy = (kind: keyof typeof originalConsole) => {
      const original = originalConsole[kind];
      return mock((...args: unknown[]) => {
        consoleCalls.push(`${kind}:${args.map(String).join(" ")}`);
        return original.apply(console, args);
      }) as unknown as typeof console.log;
    };
    console.log = spy("log");
    console.warn = spy("warn");
    console.error = spy("error");
    console.info = spy("info");
    console.debug = spy("debug");

    let warned: { message: string; data?: Record<string, unknown> } | null = null;
    _autoPrDeps.openDraft = (async () => {
      throw new Error("forge CLI unavailable");
    }) as typeof _autoPrDeps.openDraft;

    const ctx = makeContext({
      logger: {
        debug: () => {},
        info: () => {},
        warn: (message, data) => {
          warned = { message, ...(data !== undefined ? { data } : {}) };
        },
        error: () => {},
      },
    });

    let result;
    let threw = false;
    try {
      result = await autoPrPlugin.extensions.postRunAction!.execute(ctx);
    } catch {
      threw = true;
    } finally {
      console.log = originalConsole.log;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
      console.info = originalConsole.info;
      console.debug = originalConsole.debug;
    }

    expect(threw).toBe(false);
    expect(result?.success).toBe(false);
    expect(warned).not.toBeNull();
    expect(consoleCalls).toEqual([]);
  });
});

// ─── AC11: loader registration ──────────────────────────────────────────────

describe("loadPlugins — autoPr registration", () => {
  test("AC11 — getPostRunActions() includes 'nax-auto-pr' exactly once when not disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "autopr-registration-"));
    const registry = await loadPlugins(join(root, "global"), join(root, "project"), [], root, []);
    const actions = registry.getPostRunActions();
    // Regression: auto-pr must be a side-channel action only (like auto-route),
    // never also a full plugin — otherwise getPostRunActions returns it twice
    // and the action fires twice per run (first opens the PR, second warns
    // "open PR/MR already exists for branch"). See registry.ts layout comment.
    const autoPrActions = actions.filter((a) => a.name === PLUGIN_NAME);
    expect(autoPrActions).toHaveLength(1);
    // And it must not appear in the full plugins list (side-channel only).
    expect(registry.plugins.some((p) => p.name === PLUGIN_NAME)).toBe(false);
  });

  test("autoPr is excluded from getPostRunActions() when 'nax-auto-pr' is in disabledPlugins", async () => {
    const root = await mkdtemp(join(tmpdir(), "autopr-registration-"));
    const registry = await loadPlugins(join(root, "global"), join(root, "project"), [], root, [PLUGIN_NAME]);
    const actions = registry.getPostRunActions();
    expect(actions.some((a) => a.name === PLUGIN_NAME)).toBe(false);
  });
});
