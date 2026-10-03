import { describe, expect, test } from "bun:test";
import * as internal from "@nathapp/nax-agent/internal";
import { _commandShadowDeps, _systemOneClientDeps } from "#src/command-safety/index";
import { byCodePoint } from "#src/internal/sort";

/** The 20 names S2-7 moves off `.`: 17 `…Deps` seams and 3 reset hooks. */
const SEAMS = [
  "_adapterDeps",
  "_approvalsTaintDeps",
  "_bashToolDeps",
  "_codingToolDeps",
  "_commandShadowDeps",
  "_editDeps",
  "_gitGuardDeps",
  "_globDeps",
  "_grepDeps",
  "_launcherDeps",
  "_policyInputDeps",
  "_probeDeps",
  "_resetBuiltinsForTest",
  "_resetRegistryForTest",
  "_resetSandboxRegistryForTests",
  "_sandboxRegistryDeps",
  "_sessionTmpDeps",
  "_spillDeps",
  "_srtBackendDeps",
  "_systemOneClientDeps",
] as const;

describe("/internal", () => {
  test("carries all 20 test seams and reset hooks", () => {
    const missing = SEAMS.filter((name) => !(name in internal));
    expect(missing.sort(byCodePoint)).toEqual([]);
    expect(SEAMS).toHaveLength(20);
  });

  test("the two command-safety seams are the very objects the modules read", () => {
    // A copy would make a test that patches the seam patch nothing.
    expect(internal._commandShadowDeps).toBe(_commandShadowDeps);
    expect(internal._systemOneClientDeps).toBe(_systemOneClientDeps);
  });
});
