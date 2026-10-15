/**
 * nax#2500 integration: a reviewer turn that writes through Bash is reverted by the
 * run turn hooks, and ACP review opens carry the sandbox.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTranscriptStore, type OpenSessionOpts } from "@nathapp/nax-agent";
import { makeAgentAdapter } from "@test/helpers";
import { createAskPort } from "@/agents/acp/ask-port";
import { openContext } from "@/agents/acp/open-context";
import { createTurnSlot } from "@/agents/acp/turn-slot";
import type { TurnResult } from "@/agents/types";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { REVIEWER_VERIFY_TOOLS } from "@/operations/workflow-story-review";
import { createRunTurnHooks } from "@/runtime/run-turn-hooks";
import { SessionManager } from "@/session/manager";
import type { OpenSessionRequest, SessionRole } from "@/session/types";

const TURN: TurnResult = {
  output: "reviewed",
  tokenUsage: { inputTokens: 1, outputTokens: 1 },
  estimatedCostUsd: 0,
  internalRoundTrips: 1,
};

const dirs: string[] = [];
afterEach(async () => {
  resetLogger();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  const p = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  await p.exited;
}

async function seedRepo(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "nax-2500-int-"));
  dirs.push(d);
  await git(d, "init", "-q", "-b", "main");
  await writeFile(join(d, "tracked.txt"), "original\n");
  await git(d, "add", "-A");
  await git(d, "commit", "-q", "-m", "seed");
  return d;
}

function captureWarnings(): LogEntry[] {
  resetLogger();
  initLogger({ level: "silent", suppressConsole: true });
  const entries: LogEntry[] = [];
  addSink((e) => {
    if (e.level === "warn") entries.push(e);
  });
  return entries;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function request(workdir: string, role: SessionRole): OpenSessionRequest {
  return {
    agentName: "claude",
    workdir,
    pipelineStage: "review",
    role,
    storyId: "US-001",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
    timeoutSeconds: 30,
  };
}

describe("reviewer turn through SessionManager + run turn hooks", () => {
  async function runTurn(role: SessionRole, workdir: string): Promise<void> {
    const adapter = makeAgentAdapter({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      // Simulates a Bash write inside the reviewer turn.
      sendTurn: mock(async () => {
        await writeFile(join(workdir, "stray.txt"), "stray\n");
        await writeFile(join(workdir, "tracked.txt"), "tampered\n");
        return TURN;
      }),
    });
    const sm = new SessionManager({ getAdapter: () => adapter });
    sm.configureRuntime({ turnHooks: createRunTurnHooks({ repairRunState: async () => undefined }) });
    const handle = await sm.openSession(`nax-2500-${role}`, request(workdir, role));
    try {
      await sm.sendPrompt(handle, "review");
    } finally {
      await sm.closeSession(handle);
      sm.close();
    }
  }

  test("stray files are removed, tracked edits restored, one reverted record logged", async () => {
    const repo = await seedRepo();
    const logs = captureWarnings();
    await runTurn("wf-story-review", repo);
    expect(await exists(join(repo, "stray.txt"))).toBe(false);
    expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("original\n");
    const reverted = logs.filter((e) => e.message === "reviewer-tree-reverted");
    expect(reverted).toHaveLength(1);
    expect(reverted[0]?.data).toMatchObject({
      role: "wf-story-review",
      failures: [],
      paths: expect.arrayContaining(["stray.txt", "tracked.txt"]),
    });
  });

  test("a non-reviewer role is left alone", async () => {
    const repo = await seedRepo();
    const logs = captureWarnings();
    await runTurn("implementer", repo);
    expect(await exists(join(repo, "stray.txt"))).toBe(true);
    expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("tampered\n");
    expect(logs.filter((e) => e.message === "reviewer-tree-reverted")).toHaveLength(0);
  });
});

describe("ACP open for a reviewer-shaped op", () => {
  const sandbox = {
    kind: "policy",
    policy: { writeRoots: ["/repo"], denyWrite: [], denyRead: [], network: {} },
  } as const;
  const opts: OpenSessionOpts = {
    agentName: "claude",
    workdir: "/repo",
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    modelDef: { provider: "anthropic", model: "sonnet", env: {} },
    timeoutSeconds: 600,
    declaredTools: [...REVIEWER_VERIFY_TOOLS],
    sandbox,
  };

  function build(o: OpenSessionOpts) {
    const slot = createTurnSlot();
    return openContext({
      name: "s1",
      agent: "claude",
      opts: o,
      store: createMemoryTranscriptStore(),
      resume: undefined,
      asks: createAskPort(slot),
      slot,
      openSignal: new AbortController().signal,
    });
  }

  test("opens the review profile with the sandbox policy", () => {
    const ctx = build(opts);
    expect(ctx.profile).toBe("review");
    expect(ctx.sandbox).toEqual(sandbox);
  });

  test("without a sandbox the review profile carries none (the backend denies commands)", () => {
    const { sandbox: _omit, ...rest } = opts;
    const ctx = build(rest);
    expect(ctx.profile).toBe("review");
    expect(ctx.sandbox).toBeUndefined();
  });
});
