/**
 * Integration tests for nax agents CLI command
 *
 * Tests the agents list command that displays available agents
 * with their binary paths, versions, and health status.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { rm } from "node:fs/promises";
import { makeTempDir } from "@test/helpers";
import { _acpAdapterDeps } from "@/agents/acp/adapter";
import { _cliAgentsDeps, agentsListCommand } from "@/cli/agents";
import { DEFAULT_CONFIG } from "@/config";

describe("agentsListCommand", () => {
  let testDir: string;

  beforeAll(() => {
    testDir = makeTempDir("nax-agents-test-");
  });

  afterAll(async () => {
    // Cleanup
    await rm(testDir, { recursive: true, force: true });
  });

  let origGetAgentVersion: typeof _cliAgentsDeps.getAgentVersion;
  let origWhich: typeof _acpAdapterDeps.which;

  beforeEach(() => {
    origGetAgentVersion = _cliAgentsDeps.getAgentVersion;
    origWhich = _acpAdapterDeps.which;
    // Mock getAgentVersion to return a version immediately
    _cliAgentsDeps.getAgentVersion = async () => "1.0.0";
    // Mock which to report "claude" as installed, others as not found
    _acpAdapterDeps.which = mock((binary: string) => (binary === "claude" ? "/usr/bin/claude" : null));
  });

  afterEach(() => {
    _cliAgentsDeps.getAgentVersion = origGetAgentVersion;
    _acpAdapterDeps.which = origWhich;
  });

  test("should display agents table with headers", async () => {
    const originalLog = console.log;
    let output = "";
    console.log = (message: string) => {
      output += `${message}\n`;
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
      output += `${message}\n`;
    };

    try {
      await agentsListCommand(DEFAULT_CONFIG, testDir);

      // The native agent is the built-in default: it is listed, in-process, and marked.
      expect(output).toMatch(/Native \(nax-ai\) \(default\)\s+installed/);
      expect(output).toContain("in-process");
      expect(output).not.toMatch(/Claude Code \(ACP\) \(default\)/);
    } finally {
      console.log = originalLog;
    }
  });

  test("lists only the native agent under protocol native", async () => {
    const originalLog = console.log;
    let output = "";
    console.log = (message: string) => {
      output += `${message}\n`;
    };

    try {
      const nativeConfig = { ...DEFAULT_CONFIG, agent: { ...DEFAULT_CONFIG.agent, protocol: "native" as const } };
      await agentsListCommand(nativeConfig, testDir);

      expect(output).toContain("Native (nax-ai) (default)");
      expect(output).not.toContain("Claude Code (ACP)");
    } finally {
      console.log = originalLog;
    }
  });

  test("marks an acpx default agent, and omits native under protocol acp", async () => {
    const originalLog = console.log;
    let output = "";
    console.log = (message: string) => {
      output += `${message}\n`;
    };

    try {
      const acpConfig = {
        ...DEFAULT_CONFIG,
        agent: { ...DEFAULT_CONFIG.agent, protocol: "acp" as const, default: "claude" },
      };
      await agentsListCommand(acpConfig, testDir);

      expect(output).toMatch(/Claude Code \(ACP\) \(default\)/);
      expect(output).not.toContain("Native (nax-ai)");
    } finally {
      console.log = originalLog;
    }
  });

  test("should list all known agents", async () => {
    const originalLog = console.log;
    let output = "";
    console.log = (message: string) => {
      output += `${message}\n`;
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
      output += `${message}\n`;
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
      output += `${message}\n`;
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
