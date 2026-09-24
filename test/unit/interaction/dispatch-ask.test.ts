/**
 * The shared ask wiring every Bash-dispatching CallContext carries (#2201):
 * the P2 ask resolver (approvals cache -> human link, audited) and the P5
 * command shadow, plus the dispose that tears both down.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeNaxConfig, makeTempDir } from "@test/helpers";
import type { CommandShadow } from "@/command-safety";
import type { NaxConfig } from "@/config";
import type { AskChannel, AskChannelResponse, DispatchAskDeps, DispatchAskOptions } from "@/interaction";
import {
  _dispatchAskDeps,
  APPROVAL_AUDIT_DIR,
  buildDispatchAskWiring,
  buildRunDispatchAskWiring,
  collectEffectiveRunStageModes,
} from "@/interaction";
import type { AskRequest } from "@/permissions";

const REQ: AskRequest = {
  tool: "Bash",
  stage: "rectification",
  rule: "Bash",
  summary: "Bash command=bun run test",
  command: "bun run test",
  root: "/repo",
};

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
});

function outputDir(): string {
  const dir = makeTempDir("dispatch-ask-");
  tempDirs.push(dir);
  return dir;
}

function chainReplying(action: string): AskChannel {
  return {
    prompt: (request): Promise<AskChannelResponse> =>
      Promise.resolve({ requestId: request.id, action, respondedAt: Date.now() }),
    cancel: () => Promise.resolve(),
  };
}

function opts(overrides: Partial<DispatchAskOptions> = {}): DispatchAskOptions {
  return {
    config: makeNaxConfig(),
    interaction: undefined,
    outputDir: overrides.outputDir ?? outputDir(),
    runId: "run-1",
    repoRoot: "/repo",
    featureName: "feat",
    stageModes: ["gated"],
    ...overrides,
  };
}

function spyShadow(): { shadow: CommandShadow; drained: () => number } {
  let drained = 0;
  return {
    shadow: { observe: () => {}, settle: () => {}, drain: async () => void drained++ },
    drained: () => drained,
  };
}

function deps(overrides: Partial<DispatchAskDeps> = {}): DispatchAskDeps {
  return { ..._dispatchAskDeps, stdinIsTTY: () => true, ...overrides };
}

describe("buildDispatchAskWiring — resolver", () => {
  test("no interaction chain: the resolver is present, unreachable, and denies as unavailable", async () => {
    const wiring = buildDispatchAskWiring(opts(), deps());
    expect(wiring.askResolver.humanReachable).toBe(false);
    const verdict = await wiring.askResolver.resolve(REQ);
    expect(verdict).toMatchObject({ decision: "deny", decidedBy: "unavailable" });
    await wiring.dispose();
  });

  test("an interaction chain makes it reachable and a human allow is honoured", async () => {
    const wiring = buildDispatchAskWiring(opts({ interaction: chainReplying("allow") }), deps());
    expect(wiring.askResolver.humanReachable).toBe(true);
    expect(await wiring.askResolver.resolve(REQ)).toMatchObject({ decision: "allow", decidedBy: "human" });
    await wiring.dispose();
  });

  test("the cli plugin without a TTY stdin is unreachable", () => {
    const config = makeNaxConfig({ interaction: { plugin: "cli" } });
    const wiring = buildDispatchAskWiring(
      opts({ config, interaction: chainReplying("allow") }),
      deps({ stdinIsTTY: () => false }),
    );
    expect(wiring.askResolver.humanReachable).toBe(false);
  });

  test("every resolved ask appends an approval-audit row under the run output dir", async () => {
    const dir = outputDir();
    const wiring = buildDispatchAskWiring(opts({ outputDir: dir }), deps());
    await wiring.askResolver.resolve(REQ);
    const rows = (await Bun.file(join(dir, APPROVAL_AUDIT_DIR, "run-1.jsonl")).text()).trim().split("\n");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0] ?? "{}")).toMatchObject({ decision: "deny", decidedBy: "unavailable", request: REQ });
  });

  test("allow-remember persists an approval the cache link then answers without a human", async () => {
    const dir = outputDir();
    const first = buildDispatchAskWiring(
      opts({ outputDir: dir, interaction: chainReplying("allow-remember") }),
      deps(),
    );
    expect(await first.askResolver.resolve(REQ)).toMatchObject({ decision: "allow", decidedBy: "human" });
    await first.dispose();
    const second = buildDispatchAskWiring(opts({ outputDir: dir }), deps());
    expect(await second.askResolver.resolve(REQ)).toMatchObject({ decision: "allow", decidedBy: "cache" });
  });
});

describe("buildDispatchAskWiring — shadow and lifetime", () => {
  test("no commandSafety config: no shadow is built", () => {
    expect(buildDispatchAskWiring(opts(), deps()).commandShadow).toBeUndefined();
  });

  test("the built shadow is exposed with the run and story ids, and drained by dispose", async () => {
    const spy = spyShadow();
    const seen: unknown[] = [];
    const wiring = buildDispatchAskWiring(
      opts({ storyId: "US-1" }),
      deps({
        buildCommandShadow: (o) => {
          seen.push(o);
          return spy.shadow;
        },
      }),
    );
    expect(wiring.commandShadow).toBe(spy.shadow);
    expect(seen[0]).toMatchObject({ runId: "run-1", storyId: "US-1" });
    await wiring.dispose();
    expect(spy.drained()).toBe(1);
  });

  test("dispose cancels and disposes the human link", async () => {
    const calls: string[] = [];
    const wiring = buildDispatchAskWiring(
      opts(),
      deps({
        createHumanAskLink: (o) => {
          const link = _dispatchAskDeps.createHumanAskLink(o);
          return {
            ...link,
            cancel: async () => void calls.push("cancel"),
            dispose: () => void calls.push("dispose"),
          };
        },
      }),
    );
    await wiring.dispose();
    expect(calls).toEqual(["cancel", "dispose"]);
  });
});

describe("collectEffectiveRunStageModes", () => {
  test("an unloadable package config fails closed to raw", async () => {
    const modes = await collectEffectiveRunStageModes(
      { projectDir: "/repo", rootConfig: makeNaxConfig(), packageDirs: ["packages/a"] },
      { loadConfigForPackage: () => Promise.reject(new Error("bad config")) },
    );
    expect(modes).toEqual(["raw"]);
  });

  test("package configs are loaded once per distinct dir, from the root config", async () => {
    const root = makeNaxConfig();
    const loads: Array<{ packageDir: string | undefined; from: NaxConfig }> = [];
    const modes = await collectEffectiveRunStageModes(
      { projectDir: "/repo", rootConfig: root, packageDirs: ["packages/a", "packages/a", undefined] },
      {
        loadConfigForPackage: async (_projectDir, packageDir, from) => {
          loads.push({ packageDir, from });
          return makeNaxConfig({ execution: { bashApproval: "escalate" } });
        },
      },
    );
    expect(loads.map((l) => l.packageDir)).toEqual(["packages/a", undefined]);
    expect(loads.every((l) => l.from === root)).toBe(true);
    expect(modes).toContain("escalate");
  });
});

describe("buildRunDispatchAskWiring", () => {
  test("resolves stage modes before building: a raw package disables the approvals cache", async () => {
    const dir = outputDir();
    const remember = buildDispatchAskWiring(
      opts({ outputDir: dir, interaction: chainReplying("allow-remember") }),
      deps(),
    );
    await remember.askResolver.resolve(REQ);
    await remember.dispose();

    const wiring = await buildRunDispatchAskWiring(
      {
        ...opts({ outputDir: dir }),
        projectDir: "/repo",
        rootConfig: makeNaxConfig(),
        packageDirs: ["packages/raw"],
      },
      deps({ loadConfigForPackage: async () => makeNaxConfig({ execution: { bashApproval: "raw" } }) }),
    );
    expect(await wiring.askResolver.resolve(REQ)).toMatchObject({ decision: "deny", decidedBy: "unavailable" });
    await wiring.dispose();
  });
});
