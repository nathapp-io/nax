/**
 * A4 finish end to end over a real git repository.
 *
 * Real: `runFinishMachine`, `commitFixes`, `commitAndPush`, the PR context
 * loader and body renderer, the audit files, and the forge-facing ops
 * (`createFinishOps`). Stubbed: the review lenses and the fixer (scripted
 * outputs), the acceptance and quality runners, and the forge CLI
 * (`ForgeDeps.run`). `origin` is a local bare remote, so the pushes are real.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertDefined, cleanupTempDir, makeFinishContext, makeMockCallContext, makeTempDir } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import type { FinishMachineDeps, FinishOps, FinishReviewOutput, FinishState } from "@/finish";
import {
  _acceptanceGateDeps,
  _qualityGateDeps,
  createFinishOps,
  createFinishState,
  resultPath,
  runFinishMachine,
} from "@/finish";
import type { ForgeDeps } from "@/forge";

const FEATURE = "demo";
const BRANCH = "feat/demo";
const PR_URL = "https://example.test/acme/demo/pull/7";

let root: string;
let repo: string;
let auditDir: string;

async function git(args: string[], cwd = repo): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  return (await new Response(proc.stdout).text()).trim();
}

function write(relPath: string, contents: string): void {
  const abs = join(repo, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, contents);
}

/** Two commits on a feature branch cut from `main`, with `origin/main` held by a local bare remote. */
async function initRepo(): Promise<void> {
  const remote = join(root, "remote.git");
  mkdirSync(remote, { recursive: true });
  await git(["init", "--bare", "-b", "main"], remote);
  mkdirSync(repo, { recursive: true });
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test User"]);
  await git(["config", "commit.gpgsign", "false"]);
  write("README.md", "# fixture\n");
  await git(["add", "."]);
  await git(["commit", "-m", "initial"]);
  await git(["remote", "add", "origin", remote]);
  await git(["push", "-u", "origin", "main"]);
  await git(["checkout", "-b", BRANCH]);
  write("src/one.ts", "export const one = 1;\n");
  await git(["add", "."]);
  await git(["commit", "-m", "feat: one"]);
  write("src/two.ts", "export const two = 2;\n");
  await git(["add", "."]);
  await git(["commit", "-m", "feat: two"]);
}

interface ForgeLog {
  calls: string[][];
  deps: ForgeDeps;
}

/** A forge whose branch already has a draft PR: `view` reports it, everything else succeeds. */
function makeForge(): ForgeLog {
  const calls: string[][] = [];
  const deps: ForgeDeps = {
    run: async (cmd) => {
      calls.push(cmd);
      if (cmd[1] === "pr" && cmd[2] === "view") {
        return { exitCode: 0, stdout: JSON.stringify({ isDraft: true, url: PR_URL }), stderr: "" };
      }
      if (cmd[1] === "pr" && cmd[2] === "list") return { exitCode: 0, stdout: "[]", stderr: "" };
      return { exitCode: 0, stdout: `${PR_URL}\n`, stderr: "" };
    },
    readText: async () => null,
  };
  return { calls, deps };
}

interface Scripted {
  trail: string[];
  quality: FinishReviewOutput[];
}

/** Real forge ops, with the review lenses and the fixer replaced by scripted stubs. */
function makeOps(forge: ForgeLog, script: Scripted): FinishOps {
  const real = createFinishOps({
    callCtx: makeMockCallContext(),
    forge: forge.deps,
    forgeKind: "github",
    audit: { auditDir, runId: "run-1" },
  });
  const clean: FinishReviewOutput = { findings: [], covered: ["src/one.ts", "src/two.ts"] };
  return {
    ...real,
    reviewSpec: async () => {
      script.trail.push("review:spec");
      return clean;
    },
    reviewBranch: async () => {
      script.trail.push("review:quality");
      return script.quality.shift() ?? clean;
    },
    fix: async (phase) => {
      script.trail.push(`fix:${phase}`);
      // Only the review fix edits the tree; the acceptance fixer cannot make the contract pass.
      if (phase === "review") write("src/two.ts", "export const two = 2; // fixed\n");
      return {};
    },
    promotePr: async (s) => {
      script.trail.push("promotePr");
      return real.promotePr(s);
    },
    finalizeDraftPr: async (s) => {
      script.trail.push("finalizeDraftPr");
      return real.finalizeDraftPr(s);
    },
  };
}

function installGateStubs(acceptanceExit: number): void {
  _acceptanceGateDeps.run = async () => ({
    commandName: "acceptance",
    command: "bun test",
    success: acceptanceExit === 0,
    exitCode: acceptanceExit,
    output: "acceptance output",
    durationMs: 1,
    timedOut: false,
  });
  _qualityGateDeps.loadConfig = async () => ({
    ...DEFAULT_CONFIG,
    quality: { ...DEFAULT_CONFIG.quality, commands: { test: "true" } },
  });
  _qualityGateDeps.loadPackageOverride = async () => null;
  _qualityGateDeps.run = async (o) => ({
    commandName: o.commandName,
    command: String(o.command),
    success: true,
    exitCode: 0,
    output: "ok",
    durationMs: 1,
    timedOut: false,
  });
}

const originalAcceptance = _acceptanceGateDeps.run;
const originalQuality = { ..._qualityGateDeps };

beforeEach(async () => {
  root = makeTempDir("finish-a4-");
  repo = join(root, "repo");
  auditDir = join(root, "audit");
  mkdirSync(auditDir, { recursive: true });
  await initRepo();
});

afterEach(() => {
  _acceptanceGateDeps.run = originalAcceptance;
  Object.assign(_qualityGateDeps, originalQuality);
  cleanupTempDir(root);
});

function freshState(): FinishState {
  return createFinishState({
    feature: FEATURE,
    workdir: repo,
    branch: BRANCH,
    runId: "run-1",
    base: "origin/main",
    specPath: ".nax/features/demo/spec.md",
  });
}

function machineDeps(ops: FinishOps): FinishMachineDeps {
  let tick = 0;
  return {
    context: makeFinishContext({
      groups: [{ packageDir: "", testPath: "test/acceptance/demo.test.ts", exists: true, cwd: "" }],
    }),
    ops,
    audit: { auditDir, runId: "run-1" },
    now: () => {
      tick += 1;
      return `2026-10-11T00:00:${String(tick).padStart(2, "0")}.000Z`;
    },
  };
}

async function readResult(): Promise<Record<string, unknown>> {
  const path = resultPath({ auditDir, runId: "run-1" });
  expect(existsSync(path)).toBe(true);
  return JSON.parse(await Bun.file(path).text());
}

describe("finish A4 over a real git repo", () => {
  test("clean review promotes the draft PR to ready", async () => {
    installGateStubs(0);
    const forge = makeForge();
    const script: Scripted = { trail: [], quality: [] };
    const state = freshState();
    const ops = makeOps(forge, script);

    const result = await runFinishMachine(state, machineDeps(ops));

    expect(result.status).toBe("promoted");
    expect(result.outcome).toBe("ready");
    expect(script.trail).toEqual(["review:spec", "review:quality", "promotePr"]);
    expect(forge.calls.some((c) => c[1] === "pr" && c[2] === "ready")).toBe(true);
    // The draft is opened once after acceptance first passes, then promoted; no second PR is created.
    expect(forge.calls.filter((c) => c[2] === "create")).toHaveLength(1);

    const onDisk = await readResult();
    expect(onDisk.outcome).toBe("ready");
    expect(onDisk.status).toBe("promoted");
    // The real branch was pushed to the bare remote.
    expect(await git(["ls-remote", "--heads", "origin", BRANCH])).toContain(`refs/heads/${BRANCH}`);
  });

  test("a fixed quality finding with acceptance still red leaves a draft PR that says why", async () => {
    installGateStubs(1);
    const forge = makeForge();
    const finding = {
      severity: "HIGH" as const,
      title: "two is wrong",
      problem: "two.ts exports an unfinished value",
      fix: "finish it",
      file: "src/two.ts",
    };
    const script: Scripted = {
      trail: [],
      quality: [{ findings: [finding], covered: ["src/one.ts", "src/two.ts"] }],
    };
    const state = freshState();
    const ops = makeOps(forge, script);
    const headBefore = await git(["rev-parse", "HEAD"]);

    const result = await runFinishMachine(state, machineDeps(ops));

    expect(result.status).toBe("draft");
    expect(result.outcome).toBe("draft");
    expect(result.reason).toContain("acceptance red");
    // The review fix was really committed, and a second round then saw the tree clean.
    expect(await git(["rev-parse", "HEAD"])).not.toBe(headBefore);
    expect(script.trail.filter((t) => t === "fix:review")).toHaveLength(1);
    expect(script.trail.filter((t) => t === "review:quality")).toHaveLength(2);
    expect(script.trail).not.toContain("promotePr");
    expect(script.trail).toContain("finalizeDraftPr");

    // The PR was finalized as a draft, never promoted.
    expect(forge.calls.some((c) => c[1] === "pr" && c[2] === "ready")).toBe(false);
    const edit = forge.calls.find((c) => c[1] === "pr" && c[2] === "edit");
    assertDefined(edit, "gh pr edit call");
    const body = edit[edit.indexOf("--body") + 1];
    assertDefined(body, "PR body");
    expect(body).toContain("## Unresolved");
    expect(body).toContain("acceptance red");

    const onDisk = await readResult();
    expect(onDisk.outcome).toBe("draft");
    expect(onDisk.status).toBe("draft");
  });
});
