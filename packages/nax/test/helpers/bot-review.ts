import type { _botReviewDeps } from "@/bot/review-run";
import { type NaxConfig, resolveWorkflowConfig } from "@/config";
import type { PrInfo, PrThread } from "@/forge";
import { makeMockCallContext } from "./call-context";
import type { makeTestRuntime } from "./runtime";

/** Isolate forge, checkout and runtime I/O while exercising the real bot review graph. */
export function makeBotReviewDeps(input: {
  config: NaxConfig;
  runtime: ReturnType<typeof makeTestRuntime>;
  info: () => PrInfo;
  threads?: () => PrThread[];
  onCheckout?: () => void;
}): Partial<typeof _botReviewDeps> {
  const { config, runtime } = input;
  const ref = { forge: "github", host: "test", repo: "o/r", number: 7 } as const;
  return {
    gitToplevel: async () => "/repo",
    ensureProjectTrusted: async () => {},
    resolvePrRef: async () => ref,
    readPrInfo: async () => input.info(),
    classifyPrTrust: async () => ({ trusted: true, headSha: input.info().headSha, reasons: [] }),
    preparePrCheckout: async () => {
      input.onCheckout?.();
      return {
        worktree: "/checkout",
        snapshotDir: "/snapshot",
        baseSha: "base",
        mergeBase: "merge",
        hasBaseNax: true,
        changedFiles: [],
        dispose: async () => {},
      };
    },
    loadBotConfig: async () => config,
    createRuntime: () => runtime,
    setupBotRuntime: async () => {},
    openBotLog: () => ({ close: async () => {} }),
    buildPrStepContext: async () => ({
      ctx: {
        config,
        workflow: resolveWorkflowConfig(config),
        callCtx: makeMockCallContext({ runtime }),
        projectDir: "/checkout",
        runDir: "/artifacts",
        reportPath: "/report",
        feature: "bot",
        pr: { forge: "github", number: 7, base: "merge", head: input.info().headSha },
        packageDirs: [],
        dryRun: false,
      },
      dispose: async () => {},
    }),
    resolveBotChecks: async () => ({ source: "detected", gates: [], preRun: [] }),
    runPreRunSteps: async () => {},
    readCurrentUser: async () => ({ login: "bot" }),
    listReviewThreads: async () => input.threads?.() ?? [],
    listPrComments: async () => [],
    readLinkedIssues: async () => [],
    readHeadCi: async () => ({ outcome: "green", detail: "ok" }),
    writeJson: async () => {},
  };
}
