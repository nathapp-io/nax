import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanupTempDir,
  makeBotFixEnv,
  makeMockCallContext,
  makeNaxConfig,
  makeTempDir,
  makeTestRuntime,
} from "@test/helpers";
import { _advisorServiceDeps, buildMenu, ledgerPath } from "@/advisor";
import type { AgreedItem, BotFixEnv } from "@/bot";
import { _chainAdviseDeps, withChainRulings } from "@/bot/chain-advise";
import { parseChainRuling } from "@/bot/chain-rulings";
import { withNaxBotMarker } from "@/forge";
import type { AdviseOpOutput } from "@/operations";

const originalService = { ..._advisorServiceDeps };
const originalChain = { ..._chainAdviseDeps };
const dirs: string[] = [];
const runtimes: ReturnType<typeof makeTestRuntime>[] = [];
afterEach(async () => {
  Object.assign(_advisorServiceDeps, originalService);
  Object.assign(_chainAdviseDeps, originalChain);
  await Promise.allSettled(runtimes.splice(0).map((r) => r.close()));
  await Promise.all(dirs.splice(0).map(cleanupTempDir));
});

function routedEnv(severity: "critical" | "important"): BotFixEnv {
  const root = makeTempDir("chain-service-root-");
  const out = makeTempDir("chain-service-out-");
  dirs.push(root, out);
  const item: AgreedItem = {
    kind: "finding",
    key: "f-1",
    severity,
    issue: "Leak",
    trigger: "normal",
    lineage: { generation: 2, parents: ["p-1"], pushSha: "abcdef1" },
  };
  const base = makeBotFixEnv([item]);
  const config = makeNaxConfig({ outputDir: out, advisor: { enabled: true, callers: { botFixChain: true } } });
  const runtime = makeTestRuntime({ config });
  runtimes.push(runtime);
  return {
    ...base,
    config,
    repoRoot: root,
    ctx: { ...base.ctx, config, callCtx: makeMockCallContext({ runtime, config }) },
    threads: [
      {
        id: "t1",
        replyTo: "1",
        resolved: false,
        outdated: false,
        comments: [{ id: "c1", kind: "thread", author: "bot", body: withNaxBotMarker("body", "f-1"), createdAt: "" }],
      },
    ],
    checkout: { ...base.checkout, changedFiles: [".nax/features/alpha/prd.json", ".nax/features/alpha/spec.md"] },
  };
}

function stub(posted: string[]): void {
  const waiveId = buildMenu({ kind: "bot-fix-chain" }).find((o) => o.type === "waive")?.id;
  const out: AdviseOpOutput = {
    ok: true,
    reply: {
      optionId: waiveId ?? "B",
      reason: "base behaviour",
      rationale: "settled earlier",
      confidence: "high",
      reversible: true,
      needsHumanConfirm: false,
    },
  };
  _advisorServiceDeps.callOp = (async () => out) as typeof _advisorServiceDeps.callOp;
  _advisorServiceDeps.captureWorktreePatch = async () => ({ sha: "sha1", patch: "", patchTruncated: false });
  _advisorServiceDeps.readPrdText = async () => "{}";
  _advisorServiceDeps.costTotal = () => 0;
  Object.assign(_chainAdviseDeps, {
    readFindingDispositions: async () => ({ confirmed: new Set<string>(), writerSettled: new Set<string>() }),
    buildChainQuestion: async (_env: BotFixEnv, _f: unknown, feature: string) => ({
      kind: "bot-fix-chain" as const,
      feature,
      summary: "s",
      evidence: [],
      options: buildMenu({ kind: "bot-fix-chain" }),
    }),
    replyToThread: async (...a: unknown[]) => {
      posted.push(String(a[2]));
      return { id: "9" };
    },
    resolveThread: async () => {},
  });
}

describe("withChainRulings with the real advisor service", () => {
  test.each(["", "different history\n"])("rejects a divergent ledger snapshot (%j)", async (replacement) => {
    stub([]);
    const env = routedEnv("important");
    const path = ledgerPath(env.repoRoot, "alpha");
    await Bun.write(path, "prior decision\n");
    _chainAdviseDeps.resolveThread = async () => {
      await Bun.write(path, replacement);
    };
    await expect(withChainRulings(env)).rejects.toThrow(/ledger/i);
    expect(await Bun.file(path).text()).toBe(replacement);
  });

  test("an unreadable snapshot is not an absent ledger", async () => {
    const posted: string[] = [];
    stub(posted);
    const env = routedEnv("important");
    // A non-directory path component produces ENOTDIR even with elevated permissions.
    await Bun.write(`${env.repoRoot}/.nax`, "not a directory");
    await expect(withChainRulings(env)).rejects.toThrow();
    expect(posted).toEqual([]);
  });

  test("AC-22 a critical waive is held with the waive proposed", async () => {
    const posted: string[] = [];
    stub(posted);
    await withChainRulings(routedEnv("critical"));
    const ruling = parseChainRuling(posted[0] ?? "");
    expect(ruling?.outcome).toBe("held");
    expect(ruling?.proposed?.outcome).toBe("waived");
  });

  test("AC-23 an important waive is applied", async () => {
    const posted: string[] = [];
    stub(posted);
    await withChainRulings(routedEnv("important"));
    expect(parseChainRuling(posted[0] ?? "")?.outcome).toBe("waived");
  });
});
