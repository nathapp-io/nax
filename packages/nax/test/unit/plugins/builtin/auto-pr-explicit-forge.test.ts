/**
 * Auto-PR with an explicit forge kind (US-001).
 *
 * Auto-PR resolves its forge from the remote URL alone, so a self-hosted forge
 * on a neutral host decided nothing and the plugin skipped itself. The run's own
 * config already knew the answer; these cases pin the precedence the plugin now
 * applies — captured env kind, then the run's `forge.kind`, then URL detection —
 * and that the remote is still read first, because `execute` pushes to it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assertDefined } from "@test/helpers";
import type { ForgeKind } from "@/forge";
import { _autoPrDeps, autoPrPlugin, configuredForgeKind } from "@/plugins/builtin/auto-pr";
import type { AutoPrDeps } from "@/plugins/builtin/auto-pr/types";
import type { PostRunContext } from "@/plugins/types";

/** A host that names neither forge. */
const NEUTRAL_REMOTE = "https://git.corp.example/group/app.git";

let saved: {
  run: AutoPrDeps["run"];
  readText: AutoPrDeps["readText"];
  getRemoteUrl: typeof _autoPrDeps.getRemoteUrl;
  detectForge: typeof _autoPrDeps.detectForge;
  hasOpenPr: typeof _autoPrDeps.hasOpenPr;
  openDraft: typeof _autoPrDeps.openDraft;
  findPrTemplate: typeof _autoPrDeps.findPrTemplate;
  readDefaultBranch: typeof _autoPrDeps.readDefaultBranch;
  capturedForgeKind: typeof _autoPrDeps.capturedForgeKind;
};

function makeContext(overrides: Partial<PostRunContext> = {}): PostRunContext {
  return {
    runId: "run-1",
    feature: "auto-pr-explicit-forge",
    workdir: "/tmp/workdir",
    prdPath: "/tmp/workdir/prd.json",
    branch: "feat/x",
    totalDurationMs: 60_000,
    totalCost: 0.1,
    storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
    stories: [],
    version: "0.1.0",
    pluginConfig: {},
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    config: { autoPr: { enabled: true, draft: true } },
    ...overrides,
  };
}

function postAction() {
  const action = autoPrPlugin.extensions.postRunAction;
  assertDefined(action, "extensions.postRunAction");
  return action;
}

function okRun(): AutoPrDeps["run"] {
  return async () => ({ exitCode: 0, stdout: "", stderr: "" });
}

beforeEach(() => {
  saved = {
    run: _autoPrDeps.run,
    readText: _autoPrDeps.readText,
    getRemoteUrl: _autoPrDeps.getRemoteUrl,
    detectForge: _autoPrDeps.detectForge,
    hasOpenPr: _autoPrDeps.hasOpenPr,
    openDraft: _autoPrDeps.openDraft,
    findPrTemplate: _autoPrDeps.findPrTemplate,
    readDefaultBranch: _autoPrDeps.readDefaultBranch,
    capturedForgeKind: _autoPrDeps.capturedForgeKind,
  };
  _autoPrDeps.run = okRun();
  _autoPrDeps.readText = async () => null;
  _autoPrDeps.getRemoteUrl = async () => NEUTRAL_REMOTE;
  // The real classifier: a neutral host decides nothing, which is the whole point.
  _autoPrDeps.detectForge = () => null;
  _autoPrDeps.hasOpenPr = async () => false;
  _autoPrDeps.openDraft = async () => ({ success: true, message: "ok" });
  _autoPrDeps.findPrTemplate = async () => null;
  _autoPrDeps.readDefaultBranch = async () => "main";
  _autoPrDeps.capturedForgeKind = () => undefined;
});

afterEach(() => {
  _autoPrDeps.run = saved.run;
  _autoPrDeps.readText = saved.readText;
  _autoPrDeps.getRemoteUrl = saved.getRemoteUrl;
  _autoPrDeps.detectForge = saved.detectForge;
  _autoPrDeps.hasOpenPr = saved.hasOpenPr;
  _autoPrDeps.openDraft = saved.openDraft;
  _autoPrDeps.findPrTemplate = saved.findPrTemplate;
  _autoPrDeps.readDefaultBranch = saved.readDefaultBranch;
  _autoPrDeps.capturedForgeKind = saved.capturedForgeKind;
});

describe("autoPrPlugin.shouldRun — explicit forge kind", () => {
  test("AC-16: a captured NAX_FORGE_KIND decides the forge handed to hasOpenPr", async () => {
    const forged: (ForgeKind | null)[] = [];
    _autoPrDeps.capturedForgeKind = () => "gitlab";
    _autoPrDeps.hasOpenPr = async (forge) => {
      forged.push(forge);
      return false;
    };

    expect(await postAction().shouldRun(makeContext())).toBe(true);
    expect(forged).toEqual(["gitlab"]);
  });

  test("AC-17: forge.kind in the run's config decides when nothing was captured", async () => {
    const forged: (ForgeKind | null)[] = [];
    _autoPrDeps.hasOpenPr = async (forge) => {
      forged.push(forge);
      return false;
    };
    const ctx = makeContext({ config: { autoPr: { enabled: true, draft: true }, forge: { kind: "gitlab" } } });

    expect(await postAction().shouldRun(ctx)).toBe(true);
    expect(forged).toEqual(["gitlab"]);
  });

  test("AC-19: a neutral host with nothing declared still skips, as today", async () => {
    expect(await postAction().shouldRun(makeContext())).toBe(false);
  });
});

describe("autoPrPlugin.execute — explicit forge kind", () => {
  test("AC-18: a captured NAX_FORGE_KIND opens the draft on that forge", async () => {
    const forged: (ForgeKind | null)[] = [];
    _autoPrDeps.capturedForgeKind = () => "gitlab";
    _autoPrDeps.openDraft = async (forge) => {
      forged.push(forge);
      return { success: true, message: "opened" };
    };

    const result = await postAction().execute(makeContext());

    expect(forged).toEqual(["gitlab"]);
    expect(result.message).not.toBe("Remote host is not GitHub or GitLab");
  });
});

describe("configuredForgeKind", () => {
  test("AC-22: returns undefined for an unrecognised forge.kind", () => {
    const ctx = makeContext({ config: { forge: { kind: "bitbucket" } } });

    expect(configuredForgeKind(ctx)).toBeUndefined();
  });

  test("AC-22: returns undefined when the context carries no config", () => {
    expect(configuredForgeKind(makeContext({ config: undefined }))).toBeUndefined();
  });

  test("reads forge.kind when it names a forge", () => {
    expect(configuredForgeKind(makeContext({ config: { forge: { kind: "github" } } }))).toBe("github");
  });
});
