import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resolveProviderTools } from "@nathapp/nax-agent";
import { assertDefined, makeBotFixEnv as environment } from "@test/helpers";
import * as bot from "@/bot";
import type { ConfiguredModel } from "@/config";
import { _forgeToolsDeps } from "@/forge-tools";

const forgeOriginal = { ..._forgeToolsDeps };
afterEach(() => Object.assign(_forgeToolsDeps, forgeOriginal));
const original = { ...bot._fixStepsDeps };
beforeEach(() => {
  bot._fixStepsDeps.readHead = async () => "fix-head";
  bot._fixStepsDeps.runGit = async () => ({ exitCode: 0, stdout: "", stderr: "" });
});
afterEach(() => Object.assign(bot._fixStepsDeps, original));

const items: bot.AgreedItem[] = [
  { kind: "finding", key: "f-1", severity: "minor", issue: "Leak", file: "a.ts" },
  {
    kind: "thread",
    key: "t-1",
    issue: "Rename",
    reason: "Clearer",
    threadId: "T1",
    replyTo: "1",
    file: "b.ts",
    line: 2,
  },
];
const state = (): bot.BotFixState => ({ step: "fix", timings: {} });

function fakeFix(failure?: string) {
  const run = mock(async () => ({ autoCommitted: false, dirty: false, ...(failure !== undefined ? { failure } : {}) }));
  bot._fixStepsDeps.runBranchFix = run;
  return run;
}

describe("fixStep", () => {
  test("US-012 AC-6/7 attached pr tool reads the bot ref with bot forge deps", async () => {
    const run = mock<typeof bot._fixStepsDeps.runBranchFix>(async () => ({ autoCommitted: false, dirty: false }));
    bot._fixStepsDeps.runBranchFix = run;
    const env = environment(items);
    const read = mock(async () => env.info);
    _forgeToolsDeps.readPrInfo = read;
    await bot.fixStep(env, state());
    const providers = run.mock.calls[0]?.[1].toolProviders;
    expect(providers).toHaveLength(1);
    expect(providers?.[0]?.id).toBe("nax-forge");
    const resolved = await resolveProviderTools(providers ?? [], "run", "/unrelated");
    const pr = resolved.tools.find((tool) => tool.name === "nax-forge__pr");
    assertDefined(pr);
    expect(
      (await pr.run({}, { root: "/unrelated", resolvedPaths: [], maxBytes: 2000, maxFileBytes: 2000 })).isError,
    ).not.toBe(true);
    expect(read).toHaveBeenCalledWith(env.ref, env.forge, env.repoRoot);
  });
  test("AC-1 forwards both agreed items through toFixFindings", async () => {
    const run = fakeFix();
    const env = environment(items);
    await bot.fixStep(env, state());
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(env.ctx, {
      findings: bot.toFixFindings(items),
      model: bot.botModel(env.config, "fix"),
      toolProviders: [expect.objectContaining({ id: "nax-forge" })],
      prompt: expect.stringContaining("PR #42"),
    });
  });
  test.each([undefined, "fast"] satisfies (ConfiguredModel | undefined)[])(
    "AC-2 resolves fix model with override %s",
    async (model) => {
      const run = fakeFix();
      const env = { ...environment(items), model };
      env.config.bot = { models: { fix: "powerful" } };
      await bot.fixStep(env, state());
      expect(run).toHaveBeenCalledWith(env.ctx, {
        findings: bot.toFixFindings(items),
        model: bot.botModel(env.config, "fix", model),
        toolProviders: [expect.objectContaining({ id: "nax-forge" })],
        prompt: expect.stringContaining("PR #42"),
      });
    },
  );
  test("AC-3/4/5 skips an empty review with nothing outcome and exit", async () => {
    const run = fakeFix();
    const result = await bot.fixStep(environment(), state());
    expect(run).not.toHaveBeenCalled();
    expect(result).toEqual({ exit: "nothing", patch: { outcome: "nothing", agreedCount: 0 } });
  });
  test("AC-6/8 returns ran and agreedCount without engine fields", async () => {
    fakeFix();
    expect(await bot.fixStep(environment(items), state())).toEqual({
      exit: "ran",
      patch: { agreedCount: 2, fixSha: "fix-head" },
    });
  });
  test("AC-7 records session failure but leaves grading to check and gates", async () => {
    fakeFix("interrupted");
    expect(await bot.fixStep(environment(items), state())).toEqual({
      exit: "ran",
      patch: { agreedCount: 2, fixFailure: "interrupted", fixSha: "fix-head" },
    });
  });
});

describe("checkStep", () => {
  test("US-002 AC-8: rejects pinned instruction edits before gates", async () => {
    bot._fixStepsDeps.changedPaths = async () => ["AGENTS.md", "src/a.ts"];
    expect(await bot.checkStep(environment(items), state())).toEqual({
      exit: "protected",
      patch: { changed: ["AGENTS.md", "src/a.ts"], protectedFiles: ["AGENTS.md"], outcome: "protected" },
    });
  });
  test.each(["dirty", "unreadable", "throwing"])(
    "fails closed on %s status and retains recovery checkout",
    async (mode) => {
      const retain = mock(() => {});
      const env = environment(items);
      bot._fixStepsDeps.runGit = async () => {
        if (mode === "throwing") throw new Error("unreadable status");
        return { exitCode: mode === "unreadable" ? 1 : 0, stdout: mode === "dirty" ? " M src/a.ts\0" : "", stderr: "" };
      };
      const changed = mock(async () => ["src/a.ts"]);
      bot._fixStepsDeps.changedPaths = changed;
      expect(await bot.checkStep({ ...env, checkout: { ...env.checkout, retain } }, state())).toMatchObject({
        exit: "dirty",
        patch: { outcome: "dirty", recoveryPath: "/worktree" },
      });
      expect(retain).toHaveBeenCalledTimes(1);
      expect(changed).not.toHaveBeenCalled();
    },
  );
  test("AC-9 compares committed worktree HEAD against the original PR head", async () => {
    const changedPaths = mock(async () => []);
    bot._fixStepsDeps.changedPaths = changedPaths;
    const env = environment(items);
    await bot.checkStep(env, state());
    expect(changedPaths).toHaveBeenCalledTimes(1);
    expect(changedPaths).toHaveBeenCalledWith("/worktree", "h1");
  });
  test.each([
    { label: "AC-10/11 no committed change", changed: [], exit: "no-change", extra: { outcome: "no-change" } },
    {
      label: "AC-12/13/14 protected workflow",
      changed: [".github/workflows/ci.yml", "src/a.ts"],
      exit: "protected",
      extra: { outcome: "protected", protectedFiles: [".github/workflows/ci.yml"] },
    },
    {
      label: "AC-15 rename out of protected directory",
      changed: [".nax/rules/a.md", "docs/a.md"],
      exit: "protected",
      extra: { outcome: "protected", protectedFiles: [".nax/rules/a.md"] },
    },
    { label: "AC-16/17 ordinary committed edit", changed: ["src/a.ts"], exit: "changed", extra: {} },
    {
      label: "preserves sensitive path input order",
      changed: ["nested/.env.local", "src/a.ts", "secrets/id_rsa.pub", ".gitlab-ci.yml"],
      exit: "protected",
      extra: { outcome: "protected", protectedFiles: ["nested/.env.local", "secrets/id_rsa.pub", ".gitlab-ci.yml"] },
    },
  ])("$label", async ({ changed, exit, extra }) => {
    bot._fixStepsDeps.changedPaths = async () => [...changed];
    expect(await bot.checkStep(environment(items), state())).toEqual({ exit, patch: { changed, ...extra } });
  });
  test("propagates diff read failures rather than declaring no-change", async () => {
    bot._fixStepsDeps.changedPaths = async () => {
      throw new Error("git failed");
    };
    await expect(bot.checkStep(environment(items), state())).rejects.toThrow("git failed");
  });
});
