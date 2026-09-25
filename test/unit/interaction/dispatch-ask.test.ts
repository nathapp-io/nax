/**
 * The shared ask wiring every Bash-dispatching CallContext carries (#2201):
 * the P2 ask resolver (approvals cache -> human link, audited) and the P5
 * command shadow, plus the dispose that tears both down.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assertDefined, cleanupTempDir, makeNaxConfig, makeTempDir } from "@test/helpers";
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
import type { AskControl, AskRequest, PrepareApprovalsStoreOptions } from "@/permissions";

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
    projectRoot: "/repo",
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
    const wiring = await buildDispatchAskWiring(opts(), deps());
    expect(wiring.askResolver.humanReachable).toBe(false);
    const verdict = await wiring.askResolver.resolve(REQ);
    expect(verdict).toMatchObject({ decision: "deny", decidedBy: "unavailable" });
    await wiring.dispose();
  });

  test("an interaction chain makes it reachable and a human allow is honoured", async () => {
    const wiring = await buildDispatchAskWiring(opts({ interaction: chainReplying("allow") }), deps());
    expect(wiring.askResolver.humanReachable).toBe(true);
    expect(await wiring.askResolver.resolve(REQ)).toMatchObject({ decision: "allow", decidedBy: "human" });
    await wiring.dispose();
  });

  test("the cli plugin without a TTY stdin is unreachable", async () => {
    const config = makeNaxConfig({ interaction: { plugin: "cli" } });
    const wiring = await buildDispatchAskWiring(
      opts({ config, interaction: chainReplying("allow") }),
      deps({ stdinIsTTY: () => false }),
    );
    expect(wiring.askResolver.humanReachable).toBe(false);
  });

  test("every resolved ask appends an approval-audit row under the run output dir", async () => {
    const dir = outputDir();
    const wiring = await buildDispatchAskWiring(opts({ outputDir: dir }), deps());
    await wiring.askResolver.resolve(REQ);
    const rows = (await Bun.file(join(dir, APPROVAL_AUDIT_DIR, "run-1.jsonl")).text()).trim().split("\n");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0] ?? "{}")).toMatchObject({ decision: "deny", decidedBy: "unavailable", request: REQ });
  });

  test("allow-remember persists an approval the cache link then answers without a human", async () => {
    const dir = outputDir();
    const first = await buildDispatchAskWiring(
      opts({ outputDir: dir, interaction: chainReplying("allow-remember") }),
      deps(),
    );
    expect(await first.askResolver.resolve(REQ)).toMatchObject({ decision: "allow", decidedBy: "human" });
    await first.dispose();
    const second = await buildDispatchAskWiring(opts({ outputDir: dir }), deps());
    expect(await second.askResolver.resolve(REQ)).toMatchObject({ decision: "allow", decidedBy: "cache" });
  });
});

describe("buildDispatchAskWiring — shadow and lifetime", () => {
  test("no commandSafety config: no shadow is built", async () => {
    expect((await buildDispatchAskWiring(opts(), deps())).commandShadow).toBeUndefined();
  });

  test("the built shadow is exposed with the run and story ids, and drained by dispose", async () => {
    const spy = spyShadow();
    const seen: unknown[] = [];
    const wiring = await buildDispatchAskWiring(
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
    const wiring = await buildDispatchAskWiring(
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

describe("buildDispatchAskWiring — approvals provenance (#2199)", () => {
  function recordPrepares(): { calls: PrepareApprovalsStoreOptions[]; deps: DispatchAskDeps } {
    const calls: PrepareApprovalsStoreOptions[] = [];
    return { calls, deps: deps({ prepareApprovalsStore: async (o) => void calls.push(o) }) };
  }

  test("a forge-capable scope taints before building and re-taints on dispose", async () => {
    const spy = recordPrepares();
    const config = makeNaxConfig({ execution: { sandbox: { enabled: false } } });
    const wiring = await buildDispatchAskWiring(opts({ config, stageModes: ["raw"], storyId: "US-1" }), spy.deps);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]).toMatchObject({ runId: "run-1", storyId: "US-1", forgeCapable: true });
    await wiring.dispose();
    expect(spy.calls.map((c) => c.forgeCapable)).toEqual([true, true]);
  });

  test("a trusted scope prepares (clears) once and does not re-taint on dispose", async () => {
    const spy = recordPrepares();
    const wiring = await buildDispatchAskWiring(opts({ stageModes: ["escalate"] }), spy.deps);
    await wiring.dispose();
    expect(spy.calls.map((c) => c.forgeCapable)).toEqual([false]);
  });

  test("the sandbox makes a raw stage trusted", async () => {
    const spy = recordPrepares();
    const config = makeNaxConfig({ execution: { sandbox: { enabled: true } } });
    await (await buildDispatchAskWiring(opts({ config, stageModes: ["raw"] }), spy.deps)).dispose();
    expect(spy.calls.map((c) => c.forgeCapable)).toEqual([false]);
  });
});

describe("approval-prompt stage forwarding (US-005)", () => {
  /** The exact options object handed to `createHumanAskLink` by the wiring. */
  type HumanLinkOptions = Parameters<DispatchAskDeps["createHumanAskLink"]>[0];

  /** Records every call to `createHumanAskLink` while still building a real link. */
  function recordingHumanLink(): { seen: HumanLinkOptions[]; deps: DispatchAskDeps } {
    const seen: HumanLinkOptions[] = [];
    return {
      seen,
      deps: deps({
        createHumanAskLink: (o) => {
          seen.push(o);
          return _dispatchAskDeps.createHumanAskLink(o);
        },
      }),
    };
  }

  test("US-005 AC3: a supplied stage reaches createHumanAskLink", async () => {
    const recorder = recordingHumanLink();
    const wiring = await buildDispatchAskWiring(opts({ stage: "merge" }), recorder.deps);

    expect(recorder.seen).toHaveLength(1);
    assertDefined(recorder.seen[0], "createHumanAskLink options");
    expect(recorder.seen[0].stage).toBe("merge");
    await wiring.dispose();
  });

  test("US-005 AC4: without a stage, the options carry no stage key at all", async () => {
    const recorder = recordingHumanLink();
    const wiring = await buildDispatchAskWiring(opts(), recorder.deps);

    expect(recorder.seen).toHaveLength(1);
    const captured = recorder.seen[0];
    assertDefined(captured, "createHumanAskLink options");
    expect("stage" in captured).toBe(false);
    await wiring.dispose();
  });

  test("US-005 AC5: buildRunDispatchAskWiring forwards a stage to createHumanAskLink", async () => {
    const recorder = recordingHumanLink();
    const wiring = await buildRunDispatchAskWiring(
      {
        ...opts(),
        projectDir: "/repo",
        rootConfig: makeNaxConfig(),
        packageDirs: [],
        stage: "review",
      },
      recorder.deps,
    );

    expect(recorder.seen).toHaveLength(1);
    assertDefined(recorder.seen[0], "createHumanAskLink options");
    expect(recorder.seen[0].stage).toBe("review");
    await wiring.dispose();
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
    const remember = await buildDispatchAskWiring(
      opts({ outputDir: dir, interaction: chainReplying("allow-remember") }),
      deps(),
    );
    await remember.askResolver.resolve(REQ);
    await remember.dispose();

    const wiring = await buildRunDispatchAskWiring(
      {
        // The sandbox is now on by default, which would make a raw stage
        // trusted (see "the sandbox makes a raw stage trusted" above) — pin
        // it off so this stays a test of the raw-package stage-mode path.
        ...opts({ outputDir: dir, config: makeNaxConfig({ execution: { sandbox: { enabled: false } } }) }),
        projectDir: "/repo",
        rootConfig: makeNaxConfig(),
        packageDirs: ["packages/raw"],
      },
      deps({
        loadConfigForPackage: async () =>
          makeNaxConfig({ execution: { bashApproval: "raw", sandbox: { enabled: false } } }),
      }),
    );
    expect(await wiring.askResolver.resolve(REQ)).toMatchObject({ decision: "deny", decidedBy: "unavailable" });
    await wiring.dispose();
  });
});

describe("US-003 — control through the dispatch resolver", () => {
  test("AC3: the resolver forwards the same control to the human link, and audits the bare request", async () => {
    const dir = outputDir();
    let seenControl: AskControl | undefined;
    const wiring = await buildDispatchAskWiring(
      opts({ outputDir: dir, interaction: chainReplying("allow") }),
      deps({
        createHumanAskLink: (o) => {
          const link = _dispatchAskDeps.createHumanAskLink(o);
          return {
            ...link,
            resolve: (req: AskRequest, control?: AskControl) => {
              seenControl = control;
              return link.resolve(req, control);
            },
          };
        },
      }),
    );
    const control: AskControl = { signal: new AbortController().signal, onWaiting: () => {} };
    await wiring.askResolver.resolve(REQ, control);
    await wiring.dispose();

    expect(seenControl).toBe(control);
    const rows = (await Bun.file(join(dir, APPROVAL_AUDIT_DIR, "run-1.jsonl")).text()).trim().split("\n");
    const row = JSON.parse(rows[0] ?? "{}") as { request?: AskRequest };
    expect(row.request).toEqual(REQ);
    expect(Object.keys(row.request ?? {})).not.toContain("signal");
    expect(Object.keys(row.request ?? {})).not.toContain("onWaiting");
  });

  test("AC13: a cancelled ask resolves through the resolver and is audited as decidedBy cancelled", async () => {
    const dir = outputDir();
    const controller = new AbortController();
    controller.abort("turn ended");
    const wiring = await buildDispatchAskWiring(opts({ outputDir: dir, interaction: chainReplying("allow") }), deps());
    await wiring.askResolver.resolve(REQ, { signal: controller.signal });
    await wiring.dispose();

    const rows = (await Bun.file(join(dir, APPROVAL_AUDIT_DIR, "run-1.jsonl")).text()).trim().split("\n");
    expect(JSON.parse(rows[0] ?? "{}")).toMatchObject({ decision: "deny", decidedBy: "cancelled" });
  });
});
