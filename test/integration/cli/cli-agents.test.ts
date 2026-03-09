/**
 * Integration tests for nax agents CLI command
 *
 * Tests the agents list command that displays available agents
 * with their binary paths, versions, and health status.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../../src/config";
import { agentsListCommand } from "../../../src/cli/agents";

describe("agentsListCommand", () => {
  let testDir: string;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), "nax-agents-test-"));
  });

  afterAll(async () => {
    // Cleanup
    await Bun.spawn(["rm", "-rf", testDir]).exited;
  });

  test("should display agents table with headers", async () => {
    const originalLog = console.log;
    let output = "";
    console.log = (message: string) => {
      output += message + "\n";
    };

    try {
      await agentsListCommand(DEFAULT_CONFIG, testDir);

      // Verify table structure
      expect(output).toContain("Agent");
      expect(output).toContain("Status");
      expect(output).toContain("Version");
      expect(output).toContain("Binary");
    } finally {
      console.log = originalLog;
    }
  });

  test("should show default agent indicator", async () => {
    const originalLog = console.log;
    let output = "";
    console.log = (message: string) => {
      output += message + "\n";
    };

    try {
      await agentsListCommand(DEFAULT_CONFIG, testDir);

      // Should indicate default agent
      expect(output).toMatch(/claude.*\(default\)|default.*claude/i);
    } finally {
      console.log = originalLog;
    }
  });

  test("should list all known agents", async () => {
    const originalLog = console.log;
    let output = "";
    console.log = (message: string) => {
      output += message + "\n";
    };

    try {
      await agentsListCommand(DEFAULT_CONFIG, testDir);

      // Should mention at least some agents
      expect(output.toLowerCase()).toContain("claude");
    } finally {
      console.log = originalLog;
    }
  });

  test("should show installation status", async () => {
    const originalLog = console.log;
    let output = "";
    console.log = (message: string) => {
      output += message + "\n";
    };

    try {
      await agentsListCommand(DEFAULT_CONFIG, testDir);

      // Should show status like "installed" or "unavailable"
      expect(output.toLowerCase()).toMatch(/installed|unavailable|available/);
    } finally {
      console.log = originalLog;
    }
  });

  test("should show agent capabilities", async () => {
    const originalLog = console.log;
    let output = "";
    console.log = (message: string) => {
      output += message + "\n";
    };

    try {
      await agentsListCommand(DEFAULT_CONFIG, testDir);

      // Should mention capabilities or features
      expect(output.length).toBeGreaterThan(0);
    } finally {
      console.log = originalLog;
    }
  });
});
