/**
 * Agent hooks config loader (US-002).
 *
 * Covers reading the `agent` section of the global and project hooks.json
 * files: defaults, ordering, `skipGlobal`, and the tolerant skip-with-warning
 * behaviour for malformed files and entries.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, withWarnSpy } from "@test/helpers";
import { AGENT_HOOK_EVENTS, type AgentHooksConfig, loadAgentHooksConfig } from "@/hooks";

/** Every event with an empty array — the shape the loader always returns. */
const EMPTY_AGENT_HOOKS: AgentHooksConfig = {
  PreToolUse: [],
  PostToolUse: [],
  UserPromptSubmit: [],
  SessionStart: [],
  Stop: [],
};

/** One captured `logger.warn` call: `[stage, message, data]`. */
type WarnCall = [string, string, (Record<string, unknown> | undefined)?];

/** The agent-hooks warnings among a `withWarnSpy` spy's calls. */
function agentHookWarnings(spy: { mock: { calls: WarnCall[] } }): WarnCall[] {
  return spy.mock.calls.filter((call) => call[0] === "agent-hooks");
}

let root = "";
let projectDir = "";
let globalDir = "";

beforeEach(() => {
  root = makeTempDir();
  projectDir = join(root, "project", ".nax");
  globalDir = join(root, "global", ".nax");
});

afterEach(() => cleanupTempDir(root));

/** Write a hooks.json into `dir`, serializing objects and passing strings through verbatim. */
function writeHooks(dir: string, content: unknown): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "hooks.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

describe("AGENT_HOOK_EVENTS", () => {
  test("AC-1: is the five hook events in order", () => {
    expect(AGENT_HOOK_EVENTS).toEqual(["PreToolUse", "PostToolUse", "UserPromptSubmit", "SessionStart", "Stop"]);
  });
});

describe("loadAgentHooksConfig — reading the files", () => {
  test("AC-2: no hooks.json in either directory yields empty arrays and no warning", async () => {
    await withWarnSpy(async (spy) => {
      const config = await loadAgentHooksConfig(projectDir, globalDir);
      expect(config).toEqual(EMPTY_AGENT_HOOKS);
      expect(spy.mock.calls).toHaveLength(0);
      expect(agentHookWarnings(spy)).toHaveLength(0);
    });
  });

  test("AC-3: a file with a hooks key and no agent key yields empty arrays", async () => {
    writeHooks(projectDir, { hooks: {} });
    const config = await loadAgentHooksConfig(projectDir, globalDir);
    expect(config).toEqual(EMPTY_AGENT_HOOKS);
  });

  test("AC-4: a minimal entry takes the defaults and has no matcher", async () => {
    writeHooks(projectDir, { agent: { PreToolUse: [{ command: "guard.sh" }] } });
    const config = await loadAgentHooksConfig(projectDir, globalDir);
    expect(config.PreToolUse).toHaveLength(1);
    const entry = config.PreToolUse[0];
    expect(entry).toEqual({ command: "guard.sh", scope: ["chat", "run"], timeoutMs: 30000, origin: "project" });
    expect("matcher" in entry).toBe(false);
  });

  test("AC-5: matcher, scope and timeout are read from the entry", async () => {
    writeHooks(projectDir, {
      agent: { PostToolUse: [{ command: "a.sh", matcher: "Bash", scope: ["run"], timeout: 1500 }] },
    });
    const config = await loadAgentHooksConfig(projectDir, globalDir);
    expect(config.PostToolUse).toHaveLength(1);
    expect(config.PostToolUse[0]).toEqual({
      command: "a.sh",
      matcher: "Bash",
      scope: ["run"],
      timeoutMs: 1500,
      origin: "project",
    });
  });

  test('AC-6: a "*" matcher loads as given', async () => {
    writeHooks(projectDir, { agent: { PreToolUse: [{ command: "all.sh", matcher: "*" }] } });
    const config = await loadAgentHooksConfig(projectDir, globalDir);
    expect(config.PreToolUse).toHaveLength(1);
    expect(config.PreToolUse[0].matcher).toBe("*");
  });

  test('AC-7: an entry with "enabled": false is dropped', async () => {
    writeHooks(projectDir, {
      agent: { Stop: [{ command: "off.sh", enabled: false }, { command: "on.sh" }] },
    });
    const config = await loadAgentHooksConfig(projectDir, globalDir);
    expect(config.Stop.map((entry) => entry.command)).toEqual(["on.sh"]);
  });

  test("AC-8: global entries come before project entries", async () => {
    writeHooks(globalDir, { agent: { Stop: [{ command: "g.sh" }] } });
    writeHooks(projectDir, { agent: { Stop: [{ command: "p.sh" }] } });
    const config = await loadAgentHooksConfig(projectDir, globalDir);
    expect(config.Stop.map((entry) => `${entry.command}:${entry.origin}`)).toEqual(["g.sh:global", "p.sh:project"]);
  });

  test("AC-9: skipGlobal in the project file drops the global agent entries", async () => {
    writeHooks(globalDir, { agent: { Stop: [{ command: "g.sh" }] } });
    writeHooks(projectDir, { skipGlobal: true, agent: { Stop: [{ command: "p.sh" }] } });
    const config = await loadAgentHooksConfig(projectDir, globalDir);
    expect(config.Stop.map((entry) => `${entry.command}:${entry.origin}`)).toEqual(["p.sh:project"]);
  });

  test("AC-10: a file with only an agent key loads its entries", async () => {
    writeHooks(projectDir, { agent: { UserPromptSubmit: [{ command: "only-agent.sh" }] } });
    const config = await loadAgentHooksConfig(projectDir, globalDir);
    expect(config.UserPromptSubmit.map((entry) => entry.command)).toEqual(["only-agent.sh"]);
    expect(config.PreToolUse).toEqual([]);
  });
});

describe("loadAgentHooksConfig — an invalid entry is skipped, the rest still load", () => {
  test("AC-11: a missing command skips that entry and warns with event, index and origin", async () => {
    writeHooks(projectDir, { agent: { PreToolUse: [{ matcher: "Bash" }, { command: "ok.sh" }] } });

    await withWarnSpy(async (spy) => {
      const config = await loadAgentHooksConfig(projectDir, globalDir);
      expect(config.PreToolUse.map((entry) => entry.command)).toEqual(["ok.sh"]);

      const warnings = agentHookWarnings(spy);
      expect(warnings).toHaveLength(1);
      const [stage, message, data] = warnings[0];
      expect(stage).toBe("agent-hooks");
      expect(message).toContain("PreToolUse");
      expect(message).toContain("0");
      expect(message).toContain("project");
      expect(data).toMatchObject({ event: "PreToolUse", index: 0, origin: "project" });
    });
  });

  test("AC-12: a timeout above 600000 is skipped, 600000 itself loads", async () => {
    writeHooks(projectDir, {
      agent: {
        PostToolUse: [
          { command: "too-long.sh", timeout: 600001 },
          { command: "at-max.sh", timeout: 600000 },
        ],
      },
    });

    await withWarnSpy(async (spy) => {
      const config = await loadAgentHooksConfig(projectDir, globalDir);
      expect(config.PostToolUse.map((entry) => entry.command)).toEqual(["at-max.sh"]);
      expect(config.PostToolUse[0].timeoutMs).toBe(600000);
      expect(agentHookWarnings(spy)).toHaveLength(1);
    });
  });

  test("AC-13: an empty scope and an unknown scope value are each skipped with a warning", async () => {
    writeHooks(projectDir, {
      agent: {
        Stop: [
          { command: "empty-scope.sh", scope: [] },
          { command: "unknown-scope.sh", scope: ["chat", "bogus"] },
        ],
      },
    });

    await withWarnSpy(async (spy) => {
      const config = await loadAgentHooksConfig(projectDir, globalDir);
      expect(config.Stop).toEqual([]);
      expect(agentHookWarnings(spy)).toHaveLength(2);
    });
  });

  test("AC-14: a matcher that does not compile when wrapped is skipped with a warning", async () => {
    writeHooks(projectDir, { agent: { PreToolUse: [{ command: "bad.sh", matcher: "(" }] } });

    await withWarnSpy(async (spy) => {
      const config = await loadAgentHooksConfig(projectDir, globalDir);
      expect(config.PreToolUse).toEqual([]);
      expect(agentHookWarnings(spy)).toHaveLength(1);
    });
  });

  test("AC-15: a matcher whose raw form does not compile is skipped with a warning", async () => {
    writeHooks(projectDir, { agent: { PreToolUse: [{ command: "bad.sh", matcher: "a)|(b" }] } });

    await withWarnSpy(async (spy) => {
      const config = await loadAgentHooksConfig(projectDir, globalDir);
      expect(config.PreToolUse).toEqual([]);
      expect(agentHookWarnings(spy)).toHaveLength(1);
    });
  });
});

describe("loadAgentHooksConfig — malformed files", () => {
  test("AC-16: an unknown event key is ignored with one warning and the known events still load", async () => {
    writeHooks(projectDir, { agent: { PreTool: [{ command: "typo.sh" }], Stop: [{ command: "ok.sh" }] } });

    await withWarnSpy(async (spy) => {
      const config = await loadAgentHooksConfig(projectDir, globalDir);
      expect(config.Stop.map((entry) => entry.command)).toEqual(["ok.sh"]);

      const warnings = agentHookWarnings(spy);
      expect(warnings).toHaveLength(1);
      expect(warnings[0][1]).toContain("PreTool");
      expect(warnings[0][2]).toMatchObject({ event: "PreTool" });
    });
  });

  test("AC-17: invalid JSON warns once with the path and the global entries still load", async () => {
    const projectPath = writeHooks(projectDir, "{ not json");
    writeHooks(globalDir, { agent: { Stop: [{ command: "g.sh" }] } });

    await withWarnSpy(async (spy) => {
      const config = await loadAgentHooksConfig(projectDir, globalDir);
      expect(config.Stop.map((entry) => `${entry.command}:${entry.origin}`)).toEqual(["g.sh:global"]);
      expect(config.PreToolUse).toEqual([]);

      const warnings = agentHookWarnings(spy);
      expect(warnings).toHaveLength(1);
      expect(warnings[0][1]).toContain(projectPath);
      expect(warnings[0][2]).toMatchObject({ path: projectPath });
    });
  });

  test("AC-18: a top-level array warns once with the path and contributes nothing", async () => {
    const projectPath = writeHooks(projectDir, []);

    await withWarnSpy(async (spy) => {
      const config = await loadAgentHooksConfig(projectDir, globalDir);
      expect(config).toEqual(EMPTY_AGENT_HOOKS);

      const warnings = agentHookWarnings(spy);
      expect(warnings).toHaveLength(1);
      expect(warnings[0][1]).toContain(projectPath);
      expect(warnings[0][2]).toMatchObject({ path: projectPath });
    });
  });

  test("AC-19: an agent section that is an array warns once with the path and contributes nothing", async () => {
    const projectPath = writeHooks(projectDir, { agent: [] });

    await withWarnSpy(async (spy) => {
      const config = await loadAgentHooksConfig(projectDir, globalDir);
      expect(config).toEqual(EMPTY_AGENT_HOOKS);

      const warnings = agentHookWarnings(spy);
      expect(warnings).toHaveLength(1);
      expect(warnings[0][1]).toContain(projectPath);
      expect(warnings[0][2]).toMatchObject({ path: projectPath });
    });
  });

  test("an event whose value is not an array warns once and contributes nothing", async () => {
    writeHooks(projectDir, { agent: { PostToolUse: { command: "not-a-list.sh" }, Stop: [{ command: "ok.sh" }] } });

    await withWarnSpy(async (spy) => {
      const config = await loadAgentHooksConfig(projectDir, globalDir);
      expect(config.PostToolUse).toEqual([]);
      expect(config.Stop.map((entry) => entry.command)).toEqual(["ok.sh"]);

      const warnings = agentHookWarnings(spy);
      expect(warnings).toHaveLength(1);
      expect(warnings[0][2]).toMatchObject({ event: "PostToolUse", origin: "project" });
    });
  });
});
