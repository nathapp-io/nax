/**
 * Unit tests for agent version detection
 *
 * Tests the getAgentVersion and getAgentVersions functions
 * that extract version info from agent binaries.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getAgentVersion, getAgentVersions } from "../../../src/agents/shared/version-detection";

describe("getAgentVersion", () => {
  test("should return version for installed agent", async () => {
    // Most systems have git available, use it as a mock
    const version = await getAgentVersion("git");
    expect(version).toBeTruthy();
    expect(typeof version).toBe("string");
    expect(version.length).toBeGreaterThan(0);
  });

  test("should return null for non-existent agent", async () => {
    const version = await getAgentVersion("nonexistent-agent-xyz-123");
    expect(version).toBeNull();
  });

  test("should handle agent not found gracefully", async () => {
    const version = await getAgentVersion("fake-binary-that-does-not-exist");
    expect(version).toBeNull();
  });
});

describe("getAgentVersions", () => {
  test("should return version info for all agents", async () => {
    const versions = await getAgentVersions();
    expect(Array.isArray(versions)).toBe(true);
    expect(versions.length).toBeGreaterThan(0);
  });

  test("should include agent name, displayName, and version", async () => {
    const versions = await getAgentVersions();
    for (const agentInfo of versions) {
      expect(agentInfo).toHaveProperty("name");
      expect(agentInfo).toHaveProperty("displayName");
      expect(agentInfo).toHaveProperty("version");
      expect(typeof agentInfo.name).toBe("string");
      expect(typeof agentInfo.displayName).toBe("string");
      // version can be null if not installed
      expect(agentInfo.version === null || typeof agentInfo.version === "string").toBe(true);
    }
  });

  test("should include installed status for each agent", async () => {
    const versions = await getAgentVersions();
    for (const agentInfo of versions) {
      expect(agentInfo).toHaveProperty("installed");
      expect(typeof agentInfo.installed).toBe("boolean");
    }
  });
});
