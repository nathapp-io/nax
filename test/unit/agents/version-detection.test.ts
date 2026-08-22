/**
 * Unit tests for agent version detection
 *
 * Tests the getAgentVersion and getAgentVersions functions using
 * dependency injection to avoid spawning real processes (each real
 * Gatekeeper-checked spawn can take ~1.54s on macOS).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  _versionDetectionDeps,
  getAgentVersion,
  getAgentVersions,
} from "@/agents/shared/version-detection";
import type { AgentAdapter } from "@/agents/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockProc(stdout: string, exitCode: number) {
  const bytes = new TextEncoder().encode(stdout);
  const makeStream = (content?: Uint8Array) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        if (content) c.enqueue(content);
        c.close();
      },
    });
  return {
    exited: Promise.resolve(exitCode),
    stdout: makeStream(bytes),
    stderr: makeStream(),
    pid: 0,
    kill: () => {},
  };
}

// ---------------------------------------------------------------------------
// Save / restore deps
// ---------------------------------------------------------------------------

let origSpawn: typeof _versionDetectionDeps.spawn;
let origGetInstalledAgents: typeof _versionDetectionDeps.getInstalledAgents;
let origGetAllAgents: typeof _versionDetectionDeps.getAllAgents;

beforeEach(() => {
  origSpawn = _versionDetectionDeps.spawn;
  origGetInstalledAgents = _versionDetectionDeps.getInstalledAgents;
  origGetAllAgents = _versionDetectionDeps.getAllAgents;
});

afterEach(() => {
  _versionDetectionDeps.spawn = origSpawn;
  _versionDetectionDeps.getInstalledAgents = origGetInstalledAgents;
  _versionDetectionDeps.getAllAgents = origGetAllAgents;
});

// ---------------------------------------------------------------------------
// getAgentVersion
// ---------------------------------------------------------------------------

describe("getAgentVersion", () => {
  test("returns parsed version when exit code is 0", async () => {
    _versionDetectionDeps.spawn = mock(() => makeMockProc("git version 2.39.0\n", 0)) as typeof _versionDetectionDeps.spawn;

    const version = await getAgentVersion("git");
    expect(version).toBe("2.39.0");
  });

  test("returns null when exit code is non-zero", async () => {
    _versionDetectionDeps.spawn = mock(() => makeMockProc("", 1)) as typeof _versionDetectionDeps.spawn;

    const version = await getAgentVersion("some-agent");
    expect(version).toBeNull();
  });

  test("returns null when spawn throws ENOENT (binary not found)", async () => {
    _versionDetectionDeps.spawn = mock(() => {
      throw new Error("ENOENT");
    }) as typeof _versionDetectionDeps.spawn;

    const version = await getAgentVersion("nonexistent-binary");
    expect(version).toBeNull();
  });

  test("extracts v-prefixed version format (e.g. claude v1.2.3)", async () => {
    _versionDetectionDeps.spawn = mock(() => makeMockProc("claude v1.2.3\n", 0)) as typeof _versionDetectionDeps.spawn;

    const version = await getAgentVersion("claude");
    expect(version).toBe("v1.2.3");
  });

  // PERF-32: a hung wrapper script must not stall the multi-agent health
  // precheck. proc.exited that never resolves is bounded by
  // VERSION_DETECTION_TIMEOUT_MS — getAgentVersion returns null. The test
  // takes the full 5s because that's what the timeout guarantees, so the
  // runner's per-test timeout needs to be extended.
  test("PERF-32: returns null when proc.exited never resolves (hung binary)", { timeout: 30_000 }, async () => {
    const hungProc = {
      exited: new Promise<number>(() => {}),
      stdout: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      pid: 0,
      kill: () => {},
    };
    _versionDetectionDeps.spawn = mock(() => hungProc) as typeof _versionDetectionDeps.spawn;

    const start = Date.now();
    const v = await getAgentVersion("hung-binary");
    const elapsed = Date.now() - start;

    expect(v).toBeNull();
    // Version timeout is 5s; assert it returned rather than blocked.
    expect(elapsed).toBeLessThan(30_000);
  });
});

// ---------------------------------------------------------------------------
// getAgentVersions
// ---------------------------------------------------------------------------

describe("getAgentVersions", () => {
  test("returns an array", async () => {
    _versionDetectionDeps.getInstalledAgents = mock(async () => []);
    _versionDetectionDeps.spawn = mock(() => makeMockProc("", 1)) as typeof _versionDetectionDeps.spawn;

    const versions = await getAgentVersions();
    expect(Array.isArray(versions)).toBe(true);
  });

  test("each entry has name, displayName, version, and installed properties", async () => {
    _versionDetectionDeps.getInstalledAgents = mock(async () => []);
    _versionDetectionDeps.spawn = mock(() => makeMockProc("", 1)) as typeof _versionDetectionDeps.spawn;

    const versions = await getAgentVersions();
    for (const entry of versions) {
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.displayName).toBe("string");
      expect(entry.version === null || typeof entry.version === "string").toBe(true);
      expect(typeof entry.installed).toBe("boolean");
    }
  });

  test("marks agent as installed and returns version when getInstalledAgents includes it", async () => {
    const mockAgent = {
      name: "claude",
      displayName: "Claude Code",
      binary: "claude",
    } as AgentAdapter;

    _versionDetectionDeps.getInstalledAgents = mock(async () => [mockAgent]);
    _versionDetectionDeps.spawn = mock(() => makeMockProc("claude v9.9.9\n", 0)) as typeof _versionDetectionDeps.spawn;

    const versions = await getAgentVersions();
    const entry = versions.find((v) => v.name === "claude");

    expect(entry).toBeDefined();
    expect(entry?.installed).toBe(true);
    expect(entry?.version).toBe("v9.9.9");
  });

  // BUG-19: getInstalledAgents() was called twice for no reason.
  test("calls getInstalledAgents exactly once per getAgentVersions() call", async () => {
    let calls = 0;
    _versionDetectionDeps.getInstalledAgents = mock(async () => {
      calls++;
      return [];
    });
    _versionDetectionDeps.spawn = mock(() => makeMockProc("", 1)) as typeof _versionDetectionDeps.spawn;

    await getAgentVersions();
    expect(calls).toBe(1);
  });

  test("marks agent as not installed and version null when not in installed list", async () => {
    // No agents installed — every known agent from getAllAgents() should
    // still be reported, each with installed: false and version: null.
    _versionDetectionDeps.getInstalledAgents = mock(async () => []);
    _versionDetectionDeps.spawn = mock(() => makeMockProc("", 1)) as typeof _versionDetectionDeps.spawn;

    const versions = await getAgentVersions();
    expect(versions.length).toBeGreaterThan(0);
    for (const entry of versions) {
      expect(entry.installed).toBe(false);
      expect(entry.version).toBeNull();
    }
  });

  // BUG-19 (regression, caught in code review): a version of the BUG-19 fix
  // collapsed "all known agents" and "installed agents" into the same
  // source array, making `installed` always true and silently dropping the
  // "available but not installed" report (multi-agent-health precheck's
  // second section). getAllAgents() (the full candidate set) must be kept
  // distinct from getInstalledAgents() (the installed subset).
  test("known-but-not-installed agents are still reported alongside installed ones", async () => {
    const installedAgent = { name: "claude", displayName: "Claude Code", binary: "claude" } as AgentAdapter;
    const notInstalledAgent = { name: "codex", displayName: "Codex", binary: "codex" } as AgentAdapter;

    _versionDetectionDeps.getAllAgents = mock(() => [installedAgent, notInstalledAgent]);
    _versionDetectionDeps.getInstalledAgents = mock(async () => [installedAgent]);
    _versionDetectionDeps.spawn = mock(() => makeMockProc("claude v1.0.0\n", 0)) as typeof _versionDetectionDeps.spawn;

    const versions = await getAgentVersions();
    expect(versions).toHaveLength(2);

    const claude = versions.find((v) => v.name === "claude");
    const codex = versions.find((v) => v.name === "codex");
    expect(claude?.installed).toBe(true);
    expect(claude?.version).toBe("v1.0.0");
    expect(codex?.installed).toBe(false);
    expect(codex?.version).toBeNull();
  });
});
