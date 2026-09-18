/**
 * nax#2067: every PRD nax plan writes is workdir-canonicalized.
 *
 * Asserts on the JSON handed to writeFile, which is the artifact the rest of
 * the system reads.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeNaxConfig, makePRD, makeStory } from "@test/helpers";
import type { AgentRoutingConfig, ModelsConfig } from "@/config";
import { getLogger } from "@/logger";
import { _persistPrdDeps, finalizeAndWritePrd } from "@/plan/strategies";
import type { PRD } from "@/prd/types";

let origExistsSync: typeof _persistPrdDeps.existsSync;
let origDiscover: typeof _persistPrdDeps.discoverWorkspacePackages;

beforeEach(() => {
  origExistsSync = _persistPrdDeps.existsSync;
  origDiscover = _persistPrdDeps.discoverWorkspacePackages;
});

afterEach(() => {
  _persistPrdDeps.existsSync = origExistsSync;
  _persistPrdDeps.discoverWorkspacePackages = origDiscover;
});

// Shared factories, not hand-rolled literals: the double-cast escape hatch is
// ratcheted at ZERO in test/ and would fail check:test-as-unknown-as.
function makePrd(): PRD {
  return makePRD({ userStories: [makeStory({ contextFiles: ["src/a.ts"] })] });
}

/**
 * A real ModelsConfig. Do NOT reach for the bottom-type cast here: that shape is
 * banned repo-wide by biome-plugins/no-as-never.grit, registered at biome.json's
 * ROOT `plugins` key so it covers test/ too. There are zero occurrences in the repo.
 */
const MODELS: ModelsConfig = makeNaxConfig().models;

/**
 * A spec that declares the story's package-relative context file verbatim —
 * the shape `warnOnDroppedContextFiles` compares against the story.
 */
const CONTEXT_FILES_SPEC = ["### Context Files", "", "**US-001**", "- `src/a.ts` — read this"].join("\n");

/**
 * Capture what the plan logger was told.
 *
 * Types match Logger.warn exactly (src/logger/types.ts:59) so no cast is
 * needed -- and none is allowed: the bottom-type cast is plugin-banned and
 * the double cast is ratcheted at zero.
 */
function captureWarnings() {
  const calls: Array<{ message: string; data?: Record<string, unknown> }> = [];
  const logger = getLogger();
  const original = logger.warn.bind(logger);
  logger.warn = (stage: string, message: string, data?: Record<string, unknown>): void => {
    if (stage === "plan") calls.push({ message, data });
    original(stage, message, data);
  };
  return {
    calls,
    restore: () => {
      logger.warn = original;
    },
  };
}

describe("finalizeAndWritePrd — workdir canonicalization (nax#2067)", () => {
  test("writes a derived workdir and repo-framed contextFiles", async () => {
    _persistPrdDeps.discoverWorkspacePackages = async () => ["packages/app"];
    _persistPrdDeps.existsSync = (p: string) => p === "/repo/packages/app/src/a.ts";

    let written = "";
    await finalizeAndWritePrd({
      prd: makePrd(),
      specContent: "",
      featureName: "f",
      projectName: "p",
      agentRouting: undefined,
      profileName: undefined,
      models: MODELS,
      defaultAgent: "claude",
      outputPath: "/repo/.nax/features/f/prd.json",
      repoRoot: "/repo",
      writeFile: async (_path, content) => {
        written = content;
      },
    });

    const parsed: PRD = JSON.parse(written);
    expect(parsed.userStories[0]?.workdir).toBe("packages/app");
    expect(parsed.userStories[0]?.workdirSource).toBe("derived");
    expect(parsed.userStories[0]?.contextFiles).toEqual(["packages/app/src/a.ts"]);
  });

  test("a single-package repo is unaffected apart from the provenance stamp", async () => {
    _persistPrdDeps.discoverWorkspacePackages = async () => [];
    _persistPrdDeps.existsSync = (p: string) => p === "/repo/src/a.ts";

    let written = "";
    await finalizeAndWritePrd({
      prd: makePrd(),
      specContent: "",
      featureName: "f",
      projectName: "p",
      agentRouting: undefined,
      profileName: undefined,
      models: MODELS,
      defaultAgent: "claude",
      outputPath: "/repo/.nax/features/f/prd.json",
      repoRoot: "/repo",
      writeFile: async (_path, content) => {
        written = content;
      },
    });

    const parsed: PRD = JSON.parse(written);
    expect(parsed.userStories[0]?.workdir).toBeUndefined();
    expect(parsed.userStories[0]?.workdirSource).toBe("defaulted");
    expect(parsed.userStories[0]?.contextFiles).toEqual(["src/a.ts"]);
  });

  test("a failing package discovery degrades to no canonicalization, not a throw", async () => {
    _persistPrdDeps.discoverWorkspacePackages = async () => {
      throw new Error("glob blew up");
    };
    _persistPrdDeps.existsSync = () => true;

    let written = "";
    await expect(
      finalizeAndWritePrd({
        prd: makePrd(),
        specContent: "",
        featureName: "f",
        projectName: "p",
        agentRouting: undefined,
        profileName: undefined,
        models: MODELS,
        defaultAgent: "claude",
        outputPath: "/repo/.nax/features/f/prd.json",
        repoRoot: "/repo",
        writeFile: async (_path, content) => {
          written = content;
        },
      }),
    ).resolves.toBeDefined();

    const parsed: PRD = JSON.parse(written);
    expect(parsed.userStories[0]?.contextFiles).toEqual(["src/a.ts"]);
  });

  test("does not report a spurious dropped-context warning when fidelity runs before canonicalization", async () => {
    _persistPrdDeps.discoverWorkspacePackages = async () => ["packages/app"];
    _persistPrdDeps.existsSync = (p: string) => p === "/repo/packages/app/src/a.ts";

    let written = "";
    const cap = captureWarnings();
    try {
      await finalizeAndWritePrd({
        prd: makePrd(),
        specContent: CONTEXT_FILES_SPEC,
        featureName: "f",
        projectName: "p",
        agentRouting: undefined,
        profileName: undefined,
        models: MODELS,
        defaultAgent: "claude",
        outputPath: "/repo/.nax/features/f/prd.json",
        repoRoot: "/repo",
        writeFile: async (_path, content) => {
          written = content;
        },
      });
    } finally {
      cap.restore();
    }

    // Fidelity sees the spec's package-relative declaration against the
    // pre-canonicalization story, so the drop detector must stay silent.
    expect(cap.calls.some((c) => c.message.includes("absent from the resulting story"))).toBe(false);
    // Canonicalization still runs on the fidelity-repaired PRD.
    const parsed: PRD = JSON.parse(written);
    expect(parsed.userStories[0]?.workdir).toBe("packages/app");
    expect(parsed.userStories[0]?.contextFiles).toEqual(["packages/app/src/a.ts"]);
  });
});

describe("finalizeAndWritePrd — defaulted-workdir warning (nax#2067)", () => {
  async function persist(overrides: Partial<Parameters<typeof finalizeAndWritePrd>[0]> = {}) {
    return finalizeAndWritePrd({
      prd: makePrd(),
      specContent: "",
      featureName: "f",
      projectName: "p",
      agentRouting: undefined,
      profileName: undefined,
      models: MODELS,
      defaultAgent: "claude",
      outputPath: "/repo/.nax/features/f/prd.json",
      repoRoot: "/repo",
      writeFile: async () => {},
      ...overrides,
    });
  }

  test("warns, naming both consequences, when a story defaults in a .nax/mono repo", async () => {
    _persistPrdDeps.discoverWorkspacePackages = async () => ["packages/app", "packages/lib"];
    // Spans two packages -> defaulted. And .nax/mono exists.
    _persistPrdDeps.existsSync = (p: string) =>
      p === "/repo/packages/app/src/a.ts" || p === "/repo/packages/lib/src/b.ts" || p === "/repo/.nax/mono";

    const cap = captureWarnings();
    try {
      await persist({ prd: makePRD({ userStories: [makeStory({ contextFiles: ["src/a.ts", "src/b.ts"] })] }) });
    } finally {
      cap.restore();
    }

    const warning = cap.calls.find((c) => c.message.includes("no resolved workdir"));
    expect(warning).toBeDefined();
    expect(warning?.message).toMatch(/WHOLE rule corpus/);
    expect(warning?.message).toMatch(/ROOT quality\.commands/);
    expect(warning?.data).toMatchObject({ storyIds: ["US-001"] });
  });

  test("is silent in a repo with no per-package overlays", async () => {
    _persistPrdDeps.discoverWorkspacePackages = async () => [];
    _persistPrdDeps.existsSync = (p: string) => p === "/repo/src/a.ts"; // no /repo/.nax/mono

    const cap = captureWarnings();
    try {
      await persist();
    } finally {
      cap.restore();
    }

    expect(cap.calls.find((c) => c.message.includes("no resolved workdir"))).toBeUndefined();
  });

  test("is silent when every story resolved to a package", async () => {
    _persistPrdDeps.discoverWorkspacePackages = async () => ["packages/app"];
    _persistPrdDeps.existsSync = (p: string) => p === "/repo/packages/app/src/a.ts" || p === "/repo/.nax/mono";

    const cap = captureWarnings();
    try {
      await persist();
    } finally {
      cap.restore();
    }

    expect(cap.calls.find((c) => c.message.includes("no resolved workdir"))).toBeUndefined();
  });
});

describe("finalizeAndWritePrd — scoped write (nax#2080)", () => {
  /** A PRD shaped like the one decompose hands the seam: one executed story, one fresh sub-story. */
  function makeMixedPrd(): PRD {
    return makePRD({
      userStories: [
        makeStory({
          id: "US-001",
          status: "decomposed",
          workdir: "packages/app",
          workdirSource: "stated",
          contextFiles: ["packages/app/src/a.ts"],
          routing: {
            complexity: "medium",
            testStrategy: "tdd-simple",
            reasoning: "r",
            agent: "opencode",
            initialAgent: "claude",
          },
        }),
        makeStory({
          id: "US-001-A",
          parentStoryId: "US-001",
          workdir: "packages/app",
          contextFiles: ["src/b.ts"],
        }),
      ],
    });
  }

  /**
   * An ENABLED routing config with a real profile. Required, not decoration:
   * `resolveAgentAssignment` returns null the moment `enabled !== true` or
   * `profiles` is empty (src/agents/shared/agent-profile-resolver.ts:23-26), so
   * with routing off the "executed story keeps its agent" assertion below would
   * pass even without the `only` guard -- a test that cannot fail.
   */
  const ROUTING: AgentRoutingConfig = {
    enabled: true,
    strategy: "off",
    default: "claude-default",
    profiles: [{ id: "claude-default", target: { agent: "claude", model: "balanced" }, strengths: ["design"] }],
  };

  async function persistScoped(prd: PRD, scope: ReadonlySet<string>): Promise<PRD> {
    let written = "";
    await finalizeAndWritePrd({
      prd,
      specContent: "",
      featureName: "f",
      projectName: "p",
      agentRouting: ROUTING,
      profileName: undefined,
      models: MODELS,
      defaultAgent: "claude",
      outputPath: "/repo/.nax/features/f/prd.json",
      repoRoot: "/repo",
      scope,
      writeFile: async (_path, content) => {
        written = content;
      },
    });
    return JSON.parse(written) as PRD;
  }

  test("canonicalizes the scoped sub-story and leaves the executed story alone", async () => {
    _persistPrdDeps.discoverWorkspacePackages = async () => ["packages/app"];
    _persistPrdDeps.existsSync = (p: string) => p === "/repo/packages/app/src/b.ts";

    const parsed = await persistScoped(makeMixedPrd(), new Set(["US-001-A"]));

    const sub = parsed.userStories.find((s) => s.id === "US-001-A");
    expect(sub?.workdirSource).toBe("stated");
    expect(sub?.contextFiles).toEqual(["packages/app/src/b.ts"]);

    const parent = parsed.userStories.find((s) => s.id === "US-001");
    expect(parent?.status).toBe("decomposed");
    expect(parent?.contextFiles).toEqual(["packages/app/src/a.ts"]);
    // The executed story's recorded agent survives: re-resolution would reset it
    // to ROUTING's "claude". initialAgent is sticky either way, so `agent` is the
    // only field that proves the guard fired.
    expect(parent?.routing?.agent).toBe("opencode");
    expect(parent?.routing?.initialAgent).toBe("claude");
    // Positive control: the SCOPED story IS resolved, so the assertion above is
    // about the scope, not about routing being inert.
    expect(sub?.routing?.agent).toBe("claude");
  });

  test("does not re-derive a workdir for a story the repo has since grown a file for", async () => {
    // The probe says every path resolves under packages/app -- exactly the state a
    // partially-executed repo reaches. With derive off, the sub-story still defaults.
    _persistPrdDeps.discoverWorkspacePackages = async () => ["packages/app"];
    _persistPrdDeps.existsSync = () => true;

    const prd = makePRD({
      userStories: [makeStory({ id: "US-001-A", contextFiles: ["src/b.ts"] })],
    });
    const parsed = await persistScoped(prd, new Set(["US-001-A"]));

    expect(parsed.userStories[0]?.workdir).toBeUndefined();
    expect(parsed.userStories[0]?.workdirSource).toBe("defaulted");
    expect(parsed.userStories[0]?.contextFiles).toEqual(["src/b.ts"]);
  });

  test("skips fidelity entirely on a scoped write", async () => {
    _persistPrdDeps.discoverWorkspacePackages = async () => [];
    _persistPrdDeps.existsSync = () => false;

    // A spec whose out-of-scope statement the PRD does not carry. An unscoped write
    // backfills it and warns; a scoped write must not touch feature-level fields.
    const spec = ["## Out of scope", "", "- Rewriting the scheduler"].join("\n");
    let written = "";
    const cap = captureWarnings();
    try {
      await finalizeAndWritePrd({
        prd: makePRD({ userStories: [makeStory({ id: "US-001-A" })] }),
        specContent: spec,
        featureName: "f",
        projectName: "p",
        agentRouting: undefined,
        profileName: undefined,
        models: MODELS,
        defaultAgent: "claude",
        outputPath: "/repo/.nax/features/f/prd.json",
        repoRoot: "/repo",
        scope: new Set(["US-001-A"]),
        writeFile: async (_path, content) => {
          written = content;
        },
      });
    } finally {
      cap.restore();
    }

    const parsed: PRD = JSON.parse(written);
    expect(parsed.outOfScope ?? []).toEqual([]);
    expect(cap.calls.some((c) => c.message.includes("backfilled verbatim"))).toBe(false);
  });

  test("still stamps project and routingProfile on a scoped write", async () => {
    _persistPrdDeps.discoverWorkspacePackages = async () => [];
    _persistPrdDeps.existsSync = () => false;

    let written = "";
    await finalizeAndWritePrd({
      prd: makePRD({ userStories: [makeStory({ id: "US-001-A" })] }),
      specContent: "",
      featureName: "f",
      projectName: "decompose-project",
      agentRouting: undefined,
      profileName: "cross-agent",
      models: MODELS,
      defaultAgent: "claude",
      outputPath: "/repo/.nax/features/f/prd.json",
      repoRoot: "/repo",
      scope: new Set(["US-001-A"]),
      writeFile: async (_path, content) => {
        written = content;
      },
    });

    const parsed: PRD = JSON.parse(written);
    expect(parsed.project).toBe("decompose-project");
    expect(parsed.routingProfile).toBe("cross-agent");
  });
});
