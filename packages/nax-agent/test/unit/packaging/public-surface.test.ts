import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as pub from "@nathapp/nax-agent";
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

describe(".", () => {
  test("exports no `_` name: the seams and reset hooks are /internal's", () => {
    expect(
      Object.keys(pub)
        .filter((key) => key.startsWith("_"))
        .sort(byCodePoint),
    ).toEqual([]);
  });

  test("keeps the runtime slot, the logger slot and the credentials slot", () => {
    expect(pub.setAgentRuntime).toBeFunction();
    expect(pub.getAgentRuntime).toBeFunction();
    expect(pub.setAgentLogger).toBeFunction();
    expect(pub.configureCredentials).toBeFunction();
    expect(pub.nodeRuntime.spawn).toBeFunction();
  });
});

/** The snapshot's non-`type` names per section: the names a JS consumer can actually read. */
function snapshotValueNames(): { main: string[]; internal: string[] } {
  const text = readFileSync(join(import.meta.dir, "../../../api/nax-agent.api.txt"), "utf8");
  const sections: Record<string, string[]> = {};
  let current = "";
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      current = line.slice(1, -1);
      sections[current] = [];
    } else if (!line.startsWith("type ")) sections[current]?.push(line);
  }
  return { main: sections["."] ?? [], internal: sections["./internal"] ?? [] };
}

describe("runtime exports versus the API snapshot", () => {
  // The snapshot is read from the declarations; these keys are what the JS actually exposes.
  // A value exported through `export type`, or a type exported without `type`, makes them differ.
  test(". exposes exactly the snapshot's non-type names", () => {
    expect(Object.keys(pub).sort(byCodePoint)).toEqual(snapshotValueNames().main);
  });

  test("/internal exposes exactly the snapshot's non-type names", () => {
    expect(Object.keys(internal).sort(byCodePoint)).toEqual(snapshotValueNames().internal);
  });
});
