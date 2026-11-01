/**
 * US-006 — the non-throwing handler loader.
 *
 * `loadAgentHookHandlers` is the one seam chat and (US-007) a run reach the
 * agent-hooks factory through: it reads the config, builds the surface's set,
 * and — the load-bearing part — never rejects. A broken `hooks.json` must not
 * be able to stop a chat session or a run, so an unexpected throw becomes an
 * empty set plus one `agent-hooks` warning.
 *
 * AC-1..AC-4 stub `_loadAgentHookDeps`; AC-5 drives the real config loader
 * against a temp repository, which is what proves the wiring (project `.nax`
 * dir plus global dir) reads the file the user actually wrote.
 *
 * The AC id is the test-name prefix.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir, withWarnSpy } from "@test/helpers";
import {
  _loadAgentHookDeps,
  AGENT_HOOKS_PLUGIN,
  type AgentHookEntry,
  type AgentHookEvent,
  type AgentHooksConfig,
  loadAgentHookHandlers,
} from "@/hooks";

const REPO_ROOT = "/repo";
const GLOBAL_DIR = "/global/.nax";

/** One configured hook entry, defaulted to a both-surfaces project entry. */
function hook(overrides: Partial<AgentHookEntry> & { command: string }): AgentHookEntry {
  return { scope: ["chat", "run"], timeoutMs: 30_000, origin: "project", ...overrides };
}

/** A config with every event present and empty except the ones given. */
function configWith(input: Partial<Record<AgentHookEvent, readonly AgentHookEntry[]>> = {}): AgentHooksConfig {
  return {
    PreToolUse: input.PreToolUse ?? [],
    PostToolUse: input.PostToolUse ?? [],
    UserPromptSubmit: input.UserPromptSubmit ?? [],
    SessionStart: input.SessionStart ?? [],
    Stop: input.Stop ?? [],
  };
}

/** Every event with an empty array — the shape the loader always returns. */
function emptyConfig(): AgentHooksConfig {
  return configWith();
}

// ─────────────────────────────────────────────────────────────────────────────
// Injecting the config loader
// ─────────────────────────────────────────────────────────────────────────────

/** One call the loader made into `loadAgentHooksConfig`. */
interface CapturedLoad {
  readonly projectNaxDir: string;
  readonly globalDir: string | undefined;
}

const realDeps = { ..._loadAgentHookDeps };
let loads: CapturedLoad[] = [];
let config: AgentHooksConfig = emptyConfig();
let failure: Error | undefined;

beforeEach(() => {
  loads = [];
  config = emptyConfig();
  failure = undefined;
  _loadAgentHookDeps.loadAgentHooksConfig = async (projectNaxDir, globalDir) => {
    loads.push({ projectNaxDir, globalDir });
    if (failure !== undefined) throw failure;
    return config;
  };
  _loadAgentHookDeps.globalDir = () => GLOBAL_DIR;
});

afterEach(() => {
  Object.assign(_loadAgentHookDeps, realDeps);
});

// ─────────────────────────────────────────────────────────────────────────────
// Reading the config
// ─────────────────────────────────────────────────────────────────────────────

describe("loadAgentHookHandlers — reading the config", () => {
  test("AC-1: reads <repoRoot>/.nax and the global config dir", async () => {
    await loadAgentHookHandlers({ surface: "run", repoRoot: REPO_ROOT });

    expect(loads).toEqual([{ projectNaxDir: join(REPO_ROOT, ".nax"), globalDir: GLOBAL_DIR }]);
  });

  test("AC-2: a run-scoped PreToolUse entry is a before_tool entry on run and no entry on chat", async () => {
    config = configWith({ PreToolUse: [hook({ command: "guard.sh", scope: ["run"] })] });

    const run = await loadAgentHookHandlers({ surface: "run", repoRoot: REPO_ROOT });
    const chat = await loadAgentHookHandlers({ surface: "chat", repoRoot: REPO_ROOT });

    expect(run).toHaveLength(1);
    expect(run[0]).toMatchObject({ plugin: AGENT_HOOKS_PLUGIN, event: "before_tool" });
    expect(chat).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Never throwing
// ─────────────────────────────────────────────────────────────────────────────

describe("loadAgentHookHandlers — a failing loader", () => {
  test("AC-3: a rejected config load resolves to an empty set", async () => {
    failure = new Error("hooks.json exploded");

    await expect(loadAgentHookHandlers({ surface: "run", repoRoot: REPO_ROOT })).resolves.toEqual([]);
  });

  test("AC-4: a rejected config load logs exactly one agent-hooks warning", async () => {
    failure = new Error("hooks.json exploded");

    await withWarnSpy(async (spy) => {
      await loadAgentHookHandlers({ surface: "chat", repoRoot: REPO_ROOT });
      const warnings = spy.mock.calls.filter((call) => call[0] === "agent-hooks");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.[1]).toContain("hooks.json exploded");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The real loader against a real repository
// ─────────────────────────────────────────────────────────────────────────────

describe("loadAgentHookHandlers — a real project hooks.json", () => {
  test("AC-5: a project Stop entry becomes one before_turn_end entry from the agent-hooks plugin", async () => {
    await withTempDir(async (dir) => {
      const repoRoot = join(dir, "repo");
      const globalDir = join(dir, "global");
      await Bun.write(
        join(repoRoot, ".nax", "hooks.json"),
        JSON.stringify({ agent: { Stop: [{ command: "notify.sh", scope: ["run"] }] } }),
      );
      // An empty global directory: the global file contributes nothing.
      await Bun.write(join(globalDir, "keep"), "");
      _loadAgentHookDeps.loadAgentHooksConfig = realDeps.loadAgentHooksConfig;
      _loadAgentHookDeps.globalDir = () => globalDir;

      const set = await loadAgentHookHandlers({ surface: "run", repoRoot });

      expect(set).toHaveLength(1);
      expect(set[0]).toMatchObject({ plugin: AGENT_HOOKS_PLUGIN, event: "before_turn_end" });
    });
  });
});
