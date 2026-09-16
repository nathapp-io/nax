/**
 * nax#2067: every PRD nax plan writes is workdir-canonicalized.
 *
 * Asserts on the JSON handed to writeFile, which is the artifact the rest of
 * the system reads.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeNaxConfig, makePRD, makeStory } from "@test/helpers";
import type { ModelsConfig } from "@/config";
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
});
