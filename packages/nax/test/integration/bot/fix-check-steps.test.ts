import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resolveProviderTools } from "@nathapp/nax-agent";
import { assertDefined, makeBotFixEnv as environment, makePRD, makeStory } from "@test/helpers";
import * as bot from "@/bot";
import { _outsideGrowthDeps } from "@/bot/fix-facts";
import { withPushLedger } from "@/bot/push-ledger";
import type { ConfiguredModel } from "@/config";
import { _forgeToolsDeps } from "@/forge-tools";

const forgeOriginal = { ..._forgeToolsDeps };
afterEach(() => Object.assign(_forgeToolsDeps, forgeOriginal));
const original = { ...bot._fixStepsDeps };
const factsOriginal = { ..._outsideGrowthDeps };
beforeEach(() => {
  bot._fixStepsDeps.readHead = async () => "fix-head";
  bot._fixStepsDeps.runGit = async () => ({ exitCode: 0, stdout: "", stderr: "" });
});
afterEach(() => Object.assign(bot._fixStepsDeps, original));
afterEach(() => Object.assign(_outsideGrowthDeps, factsOriginal));

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

/** US-006: the fix session is told the round's facts. {@link factsSection} is what the prompt holds under that heading. */
function factsSection(prompt: string): string {
  return prompt.split("## Facts about these findings\n")[1]?.split("\n\n## The bar")[0] ?? "";
}

/** A fix session whose prompt this suite reads, typed like the real boundary. */
function fakePromptFix() {
  const run = mock<typeof bot._fixStepsDeps.runBranchFix>(async () => ({ autoCommitted: false, dirty: false }));
  bot._fixStepsDeps.runBranchFix = run;
  return run;
}

function promptOf(run: ReturnType<typeof fakePromptFix>): string {
  return run.mock.calls[0]?.[1].prompt ?? "";
}

/** A checkout whose PR touches one feature's `prd.json`, so the fix step has declared files to compare against. */
function envWithFeaturePRD(): bot.BotFixEnv {
  const base = environment(items);
  return { ...base, checkout: { ...base.checkout, changedFiles: [".nax/features/f/prd.json"] } };
}

/** A PR whose own `fix-summary` carries one recorded bot push. */
function envWithLedger(): bot.BotFixEnv {
  const base = envWithFeaturePRD();
  const body = withPushLedger("", [
    { base: "base-0", sha: "0123456789abcdef0123456789abcdef01234567", at: "2026-01-01T00:00:00Z", items: [] },
  ]);
  return {
    ...base,
    own: [{ key: "fix-summary", comment: { id: "1", kind: "comment", author: "bot", body, createdAt: "" } }],
  };
}

const declaredA = makePRD({ userStories: [makeStory({ contextFiles: ["src/a.ts"] })] });

describe("fixStep facts (US-006)", () => {
  test("AC-19: an agreed finding's trigger class reaches the fix prompt", async () => {
    const run = fakePromptFix();
    const agreed: bot.AgreedItem[] = [
      {
        kind: "finding",
        key: "f-1",
        severity: "important",
        issue: "Claim race",
        file: "a.ts",
        line: 3,
        trigger: "own-concurrency",
      },
    ];
    await bot.fixStep(environment(agreed), state());
    const facts = factsSection(promptOf(run));
    expect(facts).toContain("- f-1:");
    expect(facts).toContain("Trigger: own-concurrency");
  });

  test("AC-19: a minor agreed finding carries its readiness fact", async () => {
    const run = fakePromptFix();
    await bot.fixStep(environment(items), state());
    expect(factsSection(promptOf(run))).toContain("Not blocking readiness (minor or trigger outside the blocking set)");
  });

  test("AC-20: earlier bot growth outside the declared files reaches the fix prompt", async () => {
    const run = fakePromptFix();
    _outsideGrowthDeps.loadPRD = async () => declaredA;
    _outsideGrowthDeps.runGit = async () => ({ exitCode: 0, stdout: "30\t0\tsrc/c.ts", stderr: "" });
    await bot.fixStep(envWithLedger(), state());
    expect(factsSection(promptOf(run))).toContain("`src/c.ts` +30");
  });

  test.each([
    {
      label: "the feature PRD is missing",
      seed: () => {},
    },
    {
      label: "the feature PRD is unreadable",
      seed: () => {
        _outsideGrowthDeps.loadPRD = async () => {
          throw new Error("PRD file is corrupt");
        };
      },
    },
    {
      label: "the numstat diff fails",
      seed: () => {
        _outsideGrowthDeps.loadPRD = async () => declaredA;
        _outsideGrowthDeps.runGit = async () => ({ exitCode: 128, stdout: "", stderr: "bad revision" });
      },
    },
  ])("AC-21: $label and the fix still runs without a growth fact", async ({ seed }) => {
    const run = fakePromptFix();
    seed();
    const result = await bot.fixStep(envWithLedger(), state());
    expect(result.exit).toBe("ran");
    expect(run).toHaveBeenCalledTimes(1);
    expect(promptOf(run)).not.toContain("outside the feature's declared files");
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
  // nax#2681: another process deleted the fix checkout mid-session.
  test("a fix checkout that no longer exists is reported as missing, not just dirty", async () => {
    bot._fixStepsDeps.runGit = async () => {
      throw new Error("posix_spawn 'git' ENOENT");
    };
    bot._fixStepsDeps.worktreeExists = async () => false;
    expect(await bot.checkStep(environment(items), state())).toMatchObject({
      exit: "dirty",
      patch: { outcome: "dirty", recoveryPath: "/worktree", checkoutMissing: true },
    });
  });
  test("an existing dirty checkout is not marked missing", async () => {
    bot._fixStepsDeps.runGit = async () => ({ exitCode: 0, stdout: " M src/a.ts\0", stderr: "" });
    bot._fixStepsDeps.worktreeExists = async () => true;
    const result = await bot.checkStep(environment(items), state());
    expect(result.patch).toEqual({ outcome: "dirty", recoveryPath: "/worktree" });
  });
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
