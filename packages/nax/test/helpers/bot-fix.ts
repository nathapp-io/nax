import type { AgreedItem, BotFixEnv } from "@/bot";
import { resolveWorkflowConfig } from "@/config";
import { makeMockCallContext } from "./call-context";
import { makeNaxConfig } from "./mock-nax-config";

export function makeBotFixEnv(agreed: readonly AgreedItem[] = []): BotFixEnv {
  const config = makeNaxConfig();
  const ref = { forge: "github" as const, host: "github.com", repo: "o/r", number: 42 };
  return {
    config,
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
