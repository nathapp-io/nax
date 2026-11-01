/**
 * Agent hook types
 *
 * Shell commands attached to the native agent's loop events, configured under
 * the `agent` key of `hooks.json` (global `~/.nax/hooks.json` and project
 * `<repoRoot>/.nax/hooks.json`). The lifecycle `hooks` map is unchanged — these
 * entries are a separate section with a different shape.
 */

/**
 * Every agent hook event, in config order. Runtime array, used for validation
 * and to build the always-complete {@link AgentHooksConfig}.
 */
export const AGENT_HOOK_EVENTS = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "SessionStart", "Stop"] as const;

/** One agent hook event. */
export type AgentHookEvent = (typeof AGENT_HOOK_EVENTS)[number];

/** Surface an entry runs on. */
export type AgentHookSurface = "chat" | "run";

/** One configured hook command. */
export interface AgentHookEntry {
  /** Command line, spawned as argv (no shell). */
  readonly command: string;
  /**
   * Tool-name matcher: `"*"` or absent means every tool, anything else is a
   * regular expression matched against the whole tool name. Read for
   * `PreToolUse` and `PostToolUse` only.
   */
  readonly matcher?: string;
  /** Surfaces the entry runs on (default both). */
  readonly scope: readonly AgentHookSurface[];
  /** Per-hook deadline in milliseconds. */
  readonly timeoutMs: number;
  /** Which hooks.json the entry came from. */
  readonly origin: "global" | "project";
}

/** Every event's entries, global before project. */
export type AgentHooksConfig = { readonly [E in AgentHookEvent]: readonly AgentHookEntry[] };

/** Outcome of one hook execution. */
export type AgentHookRun =
  | { readonly kind: "ok"; readonly stdout: string; readonly json?: Readonly<Record<string, unknown>> }
  | { readonly kind: "block"; readonly reason: string }
  | { readonly kind: "error"; readonly reason: string };
