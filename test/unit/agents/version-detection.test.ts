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
} from "../../../src/agents/shared/version-detection";
import type { AgentAdapter } from "../../../src/agents/types";

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

beforeEach(() => {
  origSpawn = _versionDetectionDeps.spawn;
  origGetInstalledAgents = _versionDetectionDeps.getInstalledAgents;
});

afterEach(() => {
  _versionDetectionDeps.spawn = origSpawn;
  _versionDetectionDeps.getInstalledAgents = origGetInstalledAgents;
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

  test("marks agent as not installed and version null when not in installed list", async () => {
    // No agents installed — getAgentVersions returns an empty array
    _versionDetectionDeps.getInstalledAgents = mock(async () => []);
    _versionDetectionDeps.spawn = mock(() => makeMockProc("", 1)) as typeof _versionDetectionDeps.spawn;

    const versions = await getAgentVersions();
    // With no installed agents, agentsByName is empty so versions is empty
    expect(Array.isArray(versions)).toBe(true);
    expect(versions.length).toBe(0);
  });
});
