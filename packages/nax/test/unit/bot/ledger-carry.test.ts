import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeBotFixEnv, makeLogger } from "@test/helpers";
import { ledgerPath } from "@/advisor";
import type { BotFixState } from "@/bot";
import { _ledgerCarryDeps, ledgerStep } from "@/bot/ledger-carry";
import { PROJECT_FEATURES_DIR } from "@/config";

const original = { ..._ledgerCarryDeps };
const rel = `${PROJECT_FEATURES_DIR}/f/decisions.jsonl`;
const prd = `${PROJECT_FEATURES_DIR}/f/prd.json`;
const state: BotFixState = { step: "push", timings: {} };
let env = makeBotFixEnv();
let logger = makeLogger();
let files = new Map<string, string>();
let head = "h2";
const calls: { args: string[]; cwd: string }[] = [];
let failure = "";

beforeEach(() => {
  env = makeBotFixEnv();
  env = { ...env, checkout: { ...env.checkout, changedFiles: [prd] } };
  logger = makeLogger();
  head = "h2";
  failure = "";
  calls.length = 0;
  files = new Map([
    [ledgerPath(env.repoRoot, "f"), "old\nnew\n"],
    [ledgerPath(env.checkout.worktree, "f"), "old\n"],
  ]);
  Object.assign(_ledgerCarryDeps, {
    readText: mock(async (path: string) => files.get(path) ?? null),
    writeText: mock(async (path: string, text: string) => {
      files.set(path, text);
      if (failure === "write" && text === "old\nnew\n") throw new Error("partial write");
    }),
    removeFile: mock(async (path: string) => {
      files.delete(path);
    }),
    readHead: mock(async () => head),
    getLogger: () => logger,
    runGit: mock(async (args: string[], cwd: string) => {
      calls.push({ args, cwd });
      return { exitCode: args[0] === failure ? 1 : 0, stdout: "", stderr: "failed" };
    }),
  });
});
afterEach(() => Object.assign(_ledgerCarryDeps, original));

function warned(message: string): void {
  expect(logger.calls).toContainEqual(expect.objectContaining({ level: "warn", message }));
}

describe("ledgerStep", () => {
  test("AC-1–4: copies the extension and commits only the ledger hook-free before routing by HEAD", async () => {
    const result = await ledgerStep(env, state);
    expect(files.get(ledgerPath(env.checkout.worktree, "f"))).toBe("old\nnew\n");
    expect(_ledgerCarryDeps.writeText).toHaveBeenCalledWith(ledgerPath(env.checkout.worktree, "f"), "old\nnew\n");
    expect(calls).toEqual([
      { args: ["add", "-f", "--", rel], cwd: env.checkout.worktree },
      { args: ["commit", "--no-verify", "-m", "chore(f): advisor decisions", "--", rel], cwd: env.checkout.worktree },
    ]);
    expect(result.patch).toHaveProperty("ledgerCarried", true);
    expect(result.exit).toBe("push");
  });

  test.each(["equal", "missing", "divergent", "shorter"])("AC-5–8: %s main ledger is not carried", async (kind) => {
    head = env.info.headSha;
    const main = ledgerPath(env.repoRoot, "f");
    if (kind === "missing") files.delete(main);
    else files.set(main, kind === "equal" ? "old\n" : kind === "shorter" ? "ol" : "other\nnew\n");
    expect(await ledgerStep(env, state)).toEqual({ patch: {}, exit: "skip" });
    expect(_ledgerCarryDeps.writeText).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(_ledgerCarryDeps.readHead).toHaveBeenCalledWith(env.checkout.worktree);
    if (kind === "divergent" || kind === "shorter")
      warned("Main checkout ledger does not extend the PR's; not carried");
  });

  test.each([
    { paths: [] },
    { paths: [prd, `${PROJECT_FEATURES_DIR}/g/prd.json`] },
    { paths: [`${PROJECT_FEATURES_DIR}/f/nested/prd.json`] },
    { paths: ["elsewhere/f/prd.json"] },
  ])("AC-9–10: invalid or ambiguous feature list %j reads no ledger", async ({ paths }) => {
    env = { ...env, checkout: { ...env.checkout, changedFiles: [...paths] } };
    await ledgerStep(env, state);
    expect(_ledgerCarryDeps.readText).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  const failures = ["write", "add", "commit"].flatMap((stage) =>
    [false, true].flatMap((absent) => [false, true].map((changed) => ({ stage, absent, changed }))),
  );
  test.each(failures)(
    "AC-11–14,19–20: failure %j resets, restores, warns, and routes by HEAD",
    async ({ stage, absent, changed }) => {
      failure = stage;
      head = changed ? "h2" : env.info.headSha;
      const path = ledgerPath(env.checkout.worktree, "f");
      if (absent) files.delete(path);
      else files.set(path, "old\n");
      const result = await ledgerStep(env, state);
      expect(calls.at(-1)).toEqual({ args: ["reset", "-q", "HEAD", "--", rel], cwd: env.checkout.worktree });
      expect(files.get(path)).toBe(absent ? undefined : "old\n");
      if (absent) expect(_ledgerCarryDeps.removeFile).toHaveBeenCalledWith(path);
      else expect(_ledgerCarryDeps.writeText).toHaveBeenCalledWith(path, "old\n");
      warned("Advisor ledger not carried");
      expect(result).toEqual({ patch: {}, exit: changed ? "push" : "skip" });
    },
  );

  test.each([true, false])("F1: unreadable HEAD warns; successful carry=%s still reaches push", async (carried) => {
    if (!carried) files.set(ledgerPath(env.repoRoot, "f"), "old\n");
    _ledgerCarryDeps.readHead = async () => {
      throw new Error("HEAD unreadable");
    };
    const result = await ledgerStep(env, state);
    expect(result).toEqual({ patch: carried ? { ledgerCarried: true } : {}, exit: carried ? "push" : "skip" });
    expect(calls.filter(({ args }) => args[0] === "commit")).toHaveLength(carried ? 1 : 0);
    expect(files.get(ledgerPath(env.checkout.worktree, "f"))).toBe(carried ? "old\nnew\n" : "old\n");
    warned("Advisor ledger step could not read HEAD");
  });

  test.each([true, false])("AC-17–18: in-place mode never copies; changed HEAD=%s", async (changed) => {
    env = { ...env, checkout: { ...env.checkout, inPlace: true } };
    head = changed ? "h2" : env.info.headSha;
    expect(await ledgerStep(env, state)).toEqual({ patch: {}, exit: changed ? "push" : "skip" });
    expect(_ledgerCarryDeps.readText).not.toHaveBeenCalled();
    expect(_ledgerCarryDeps.writeText).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});
