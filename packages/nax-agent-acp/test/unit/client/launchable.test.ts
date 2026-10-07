import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { isAgentLaunchable, launchCandidateKind } from "#src/client/launchable";

let dir: string;

beforeEach(() => {
  dir = makeTempDir("acp-launchable-");
});

afterEach(() => cleanupTempDir(dir));

function binDir(...names: string[]): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of names) {
    const path = join(bin, name);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
  }
  return bin;
}

describe("launchCandidateKind / isAgentLaunchable (S4b spec §6.8, §8)", () => {
  test("the local launcher on PATH is local", () => {
    const env = { PATH: binDir("claude-agent-acp", "npx") };
    expect(launchCandidateKind("claude", env)).toBe("local");
    expect(isAgentLaunchable("claude", env)).toBe(true);
  });

  test("only npx on PATH is the npx fallback, still launchable", () => {
    const env = { PATH: binDir("npx") };
    expect(launchCandidateKind("claude", env)).toBe("npx");
    expect(isAgentLaunchable("claude", env)).toBe(true);
  });

  test("an agent with no npx candidate and no launcher is not launchable", () => {
    const env = { PATH: binDir("npx") };
    expect(launchCandidateKind("opencode", env)).toBeUndefined();
    expect(isAgentLaunchable("opencode", env)).toBe(false);
  });

  test("Review Focus 5: PATH unset or empty is not launchable and does not throw", () => {
    expect(isAgentLaunchable("claude", {})).toBe(false);
    expect(isAgentLaunchable("claude", { PATH: "" })).toBe(false);
    expect(launchCandidateKind("claude", {})).toBeUndefined();
  });
});
