import type { AgreedItem, BotFixEnv } from "@/bot";
import { resolveWorkflowConfig } from "@/config";
import { makeMockCallContext } from "./call-context";
import { makeNaxConfig } from "./mock-nax-config";

export function makeBotFixEnv(agreed: readonly AgreedItem[] = []): BotFixEnv {
  const config = makeNaxConfig();
  const ref = { forge: "github" as const, host: "github.com", repo: "o/r", number: 42 };
  return {
    config,
    cost: { limitUsd: 5, spentUsd: () => 0 },
    checks: { source: "config", gates: [], preRun: [] },
    ref,
    repoRoot: "/repo",
    user: { login: "bot" },
    threads: [],
    own: [],
    ctx: {
      callCtx: makeMockCallContext(),
      config,
      workflow: resolveWorkflowConfig(config),
      feature: "bot-pr-42",
      projectDir: "/worktree",
      runDir: "/run",
      reportPath: "/run/report.md",
      packageDirs: [],
      dryRun: false,
      pr: { forge: "github", number: 42, base: "base", head: "h1" },
    },
    info: {
      number: 42,
      title: "PR",
      body: "",
      url: "",
      state: "open",
      draft: false,
      author: { login: "alice" },
      baseRef: "main",
      headRef: "fix",
      headSha: "h1",
      crossRepo: false,
    },
    checkout: {
      worktree: "/worktree",
      baseSha: "base",
      mergeBase: "merge",
      snapshotDir: "/snapshot",
      hasBaseNax: true,
      changedFiles: [],
      dispose: async () => {},
    },
    review: { version: 1, pr: ref, headSha: "h1", trusted: true, intent: "pass", quality: "changes", agreed },
    forge: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }), readText: async () => null },
  };
}

/** A draft PR: the only PR shape the bot fix ready step acts on (US-005). */
export function makeBotFixDraftEnv(overrides: { body?: string; url?: string } = {}): BotFixEnv {
  const base = makeBotFixEnv();
  return {
    ...base,
    info: {
      ...base.info,
      draft: true,
      body: overrides.body ?? "",
      url: overrides.url ?? "https://github.com/o/r/pull/42",
    },
  };
}

/** Shared orchestration boundary defaults; tests override only scenario-specific reads and nodes. */
export function makeBotFixDeps(env: BotFixEnv, runtime: ReturnType<typeof import("./runtime").makeTestRuntime>) {
  return {
    gitToplevel: async () => env.repoRoot,
    ensureProjectTrusted: async () => {},
    resolvePrRef: async () => env.ref,
    readPrInfo: async () => env.info,
    classifyPrTrust: async () => ({ trusted: true, headSha: env.info.headSha, reasons: [] }),
    preparePrCheckout: async () => env.checkout,
    loadBotConfig: async () => env.config,
    createRuntime: () => runtime,
    setupBotRuntime: async () => {},
    openBotLog: () => ({ close: async () => {} }),
    buildPrStepContext: async () => ({ ctx: env.ctx, dispose: async () => {} }),
    loadLatestReview: async () => env.review,
    savedFix: { read: async () => null, save: async () => {}, clear: async () => {} },
    resolveBotChecks: async () => env.checks,
    checkPushAccess: async (): Promise<{ ok: true }> => ({ ok: true }),
    runPreRunSteps: async () => {},
    readCurrentUser: async () => env.user,
    listReviewThreads: async () => [...env.threads],
    listPrComments: async () => [],
    randomSuffix: () => "graph-test",
    writeJson: async (_path: string, _value: unknown) => {},
    copyFile: async (_from: string, _to: string) => {},
  };
}
