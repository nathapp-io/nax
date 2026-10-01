/**
 * US-002 — the refusal survives a draft that cannot be moved aside.
 *
 * `enforceSpecStructure` renames the rejected draft away before throwing, so
 * that nothing on disk looks like a recoverable plan. A rename is a filesystem
 * call and it can fail — a read-only feature directory, a `prd.rejected.json`
 * the process may not replace, a directory in its place. When it does, the
 * refusal must still arrive: the caller's only defence against writing a
 * divergent PRD is the coded rejection, and a raw `EACCES` escaping in its place
 * names neither the divergence nor the story that was folded away.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assertNaxError, makeNaxConfig, makePRD, makeStory } from "@test/helpers";
import type { ModelsConfig } from "@/config";
import { _persistPrdDeps, finalizeAndWritePrd } from "@/plan/strategies";

const OUTPUT_PATH = "/tmp/workdir/.nax/features/feat-x/prd.json";
const REJECTED_PATH = "/tmp/workdir/.nax/features/feat-x/prd.rejected.json";

const MODELS: ModelsConfig = makeNaxConfig().models;

/** US-001 to US-004; the planner folds US-004 into US-003, which is the divergence. */
const SPEC_FOUR_STORIES = `# SPEC: fixture

## Stories

### US-001 — Core

### US-002 — API

### US-003 — Lib

### US-004 — API layer

## Acceptance Criteria

1. \`[unit]\` the behaviour holds.
`;

/** The folded PRD: US-004's work appears on US-003, and US-004 is gone. */
const FOLDED_PRD = makePRD({
  userStories: [makeStory({ id: "US-001" }), makeStory({ id: "US-002" }), makeStory({ id: "US-003" })],
});

let origExistsSync: typeof _persistPrdDeps.existsSync;
let origRenameSync: typeof _persistPrdDeps.renameSync;
let origDiscover: typeof _persistPrdDeps.discoverWorkspacePackages;

beforeEach(() => {
  origExistsSync = _persistPrdDeps.existsSync;
  origRenameSync = _persistPrdDeps.renameSync;
  origDiscover = _persistPrdDeps.discoverWorkspacePackages;
});

afterEach(() => {
  _persistPrdDeps.existsSync = origExistsSync;
  _persistPrdDeps.renameSync = origRenameSync;
  _persistPrdDeps.discoverWorkspacePackages = origDiscover;
});

/** Point the plan-time probes at one in-memory filesystem whose rename always fails. */
function installFailingRename(): { files: Map<string, string>; writes: string[] } {
  const files = new Map([[OUTPUT_PATH, JSON.stringify(FOLDED_PRD)]]);
  const writes: string[] = [];
  _persistPrdDeps.existsSync = (path: string): boolean => files.has(path);
  _persistPrdDeps.renameSync = (): void => {
    throw new Error(`EACCES: permission denied, rename '${OUTPUT_PATH}' -> '${REJECTED_PATH}'`);
  };
  _persistPrdDeps.discoverWorkspacePackages = async () => [];
  return { files, writes };
}

function persist(writes: string[]): Promise<string> {
  return finalizeAndWritePrd({
    prd: FOLDED_PRD,
    specContent: SPEC_FOUR_STORIES,
    featureName: "feat-x",
    projectName: "fixture",
    agentRouting: undefined,
    profileName: undefined,
    models: MODELS,
    defaultAgent: "claude",
    outputPath: OUTPUT_PATH,
    repoRoot: "/tmp/workdir",
    writeFile: async (path: string) => {
      writes.push(path);
    },
  });
}

describe("spec structure refusal — an unmovable draft (US-002)", () => {
  test("US-002: still rejects with PLAN_SPEC_STRUCTURE_VIOLATION, naming the violation", async () => {
    const { writes } = installFailingRename();

    const err: unknown = await persist(writes).then(
      () => null,
      (e: unknown) => e,
    );

    assertNaxError(err, "spec structure refusal");
    expect(err.code).toBe("PLAN_SPEC_STRUCTURE_VIOLATION");
    expect(err.message).toContain("US-004: missing");
    expect(err.message).toContain(REJECTED_PATH);
    // The failure that stopped the move is reported, not swallowed: an operator
    // reading the refusal has to know the draft is still sitting on disk.
    expect(err.message).toContain("EACCES");
  });

  test("US-002: writes no PRD when the draft cannot be moved aside", async () => {
    const { writes } = installFailingRename();

    await persist(writes).catch(() => {});

    expect(writes).toEqual([]);
  });
});
