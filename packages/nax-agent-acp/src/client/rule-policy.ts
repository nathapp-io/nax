/**
 * nax's permission rules, translated into an ACP agent's own configuration
 * (SPEC-cursor-pi-acp-read-only). A rule is one `Tool(...)` grant of the grammar
 * native sessions use: `tool` names the tool, `patterns` are its patterns, and a
 * rule is unconditional when one of its patterns is `*` (nax's own test, which
 * treats `["*", "src/**"]` as unconditional too).
 *
 * Only an unconditional deny of a read tool (`Read`, `Glob`, `Grep`) is
 * translated here, and only for profiles `read` and `review`: a read-only
 * profile already runs with the agent's write tools removed, so no rule can
 * widen it. Bash rules are applied by nax itself (shell-rules.ts, US-003), and
 * a path-scoped or non-deny rule is left to the native matcher.
 */
import { relative } from "node:path";
import type { AgentSessionProfile } from "@nathapp/nax-agent";
import { isReadOnlyProfile, launchEnvFor, reviewDecidesShell } from "#src/client/capabilities";
import { opencodeSandboxEnv } from "#src/client/opencode-sandbox";
import type { ResolvedAcpOptions } from "#src/client/options";
import { piSandboxGateSource } from "#src/client/pi-sandbox";
import { writeCursorPolicy, writePiFile, writeStateFile } from "#src/client/policy-files";
import { OPENCODE_NONE_CONFIG, OPENCODE_READ_CONFIG, OPENCODE_REVIEW_CONFIG } from "#src/client/registry";
import { PI_SHELL_GATE_SOURCE } from "#src/client/shell-rules";
import { shellQuote } from "#src/client/shell-sandbox";

export interface AcpRule {
  readonly tool: string;
  readonly patterns: readonly string[];
}

export interface AcpPermissionRules {
  readonly allow: readonly AcpRule[];
  readonly deny: readonly AcpRule[];
  readonly ask: readonly AcpRule[];
}

const NONE: readonly AcpRule[] = Object.freeze([]);

/** The rules of a caller that has none: every list empty. */
export const NO_RULES: AcpPermissionRules = Object.freeze({ allow: NONE, deny: NONE, ask: NONE });

/** The read tools a read-only profile can lose. */
type ReadTool = "Read" | "Glob" | "Grep";

/** A rule denies this tool outright: nax's own "unconditional" test, a pattern holding `*`. */
function denied(rules: AcpPermissionRules, tool: ReadTool): boolean {
  return rules.deny.some((rule) => rule.tool === tool && rule.patterns.includes("*"));
}

/**
 * opencode's `permission` entries and the read tool each one serves, in the order
 * the registry's own configs list them: the catch-all deny first, then each
 * allowance, because opencode's rules are last-match-wins. `list` belongs to
 * `Read`: without the read tool opencode has no reason to list directories either.
 */
const OPENCODE_ENTRIES: readonly (readonly [string, ReadTool])[] = Object.freeze([
  Object.freeze(["read", "Read"] as const),
  Object.freeze(["glob", "Glob"] as const),
  Object.freeze(["grep", "Grep"] as const),
  Object.freeze(["list", "Read"] as const),
]);

/**
 * opencode's permission config for a read-only profile (SPEC US-002). An
 * unconditional deny of a read tool removes its entries, so opencode drops the
 * tool from the model's catalog; with no such rule the result is byte-identical
 * to the registry's OPENCODE_*_CONFIG. `none` ignores the rules: every tool is
 * denied there and no rule can widen it. Bash rules are never translated (an
 * agent matching command text knows nothing of redirects), and `read` keeps no
 * shell tool while `review` asks nax about every command.
 */
export function opencodePermissionConfig(profile: "none" | "read" | "review", rules: AcpPermissionRules): string {
  if (profile === "none") return OPENCODE_NONE_CONFIG;
  const kept = OPENCODE_ENTRIES.filter(([, tool]) => !denied(rules, tool));
  // No read tool is denied: the operator default, byte for byte.
  if (kept.length === OPENCODE_ENTRIES.length) {
    return profile === "review" ? OPENCODE_REVIEW_CONFIG : OPENCODE_READ_CONFIG;
  }
  const permission: Record<string, string> = { "*": "deny" };
  for (const [key] of kept) permission[key] = "allow";
  if (profile === "review") permission.bash = "ask";
  return JSON.stringify({ permission });
}

/** Cursor's write and web tools, denied in every read-only profile and in this order. */
const CURSOR_DENIES: readonly string[] = Object.freeze(["Write(**)", "Delete(**)", "Mcp(*:*)", "WebFetch(*)"]);

/**
 * Cursor's isolated permission config (SPEC US-004). Cursor's own modes enforce
 * nothing, so this file is the whole enforcement: `Read(**)` is allowed unless an
 * unconditional Read deny removes it (and then joins the deny list), writes, MCP
 * and the web are denied, and shell is denied under `read` and absent under
 * `review`, where Cursor asks the client about every command and nax decides it
 * (shell-rules.ts). `none` ignores the rules: everything is denied there, and no
 * rule can widen it.
 */
export function cursorCliConfig(profile: "none" | "read" | "review", rules: AcpPermissionRules): string {
  const readDenied = profile === "none" || denied(rules, "Read");
  /** review leaves shell unlisted: every command is asked of the client, and nax answers (US-003). */
  const deny = [...CURSOR_DENIES, ...(profile === "review" ? [] : ["Shell(*)"]), ...(readDenied ? ["Read(**)"] : [])];
  return JSON.stringify({
    version: 1,
    permissions: { allow: readDenied ? [] : ["Read(**)"], deny },
    approvalMode: "allowlist",
  });
}

/** pi's tools in the order `--tools` lists them, and the read tool each one serves. */
const PI_TOOLS: readonly (readonly [string, ReadTool])[] = Object.freeze([
  Object.freeze(["read", "Read"] as const),
  Object.freeze(["grep", "Grep"] as const),
  Object.freeze(["find", "Glob"] as const),
  Object.freeze(["ls", "Glob"] as const),
]);

const PI_GATE_ARG = "-e";

/**
 * pi's `--tools` arguments (SPEC US-004): `--no-tools` under `none`, else pi's
 * read tools in a fixed order minus the ones an unconditional deny removed.
 * `Glob` owns pi's `find` and `ls`. Under `review` with a Bash allow rule, `bash`
 * is appended after the read tools and the gate extension is loaded first, so
 * every command goes through the nax shell gate.
 */
export function piToolArgs(
  profile: "none" | "read" | "review",
  rules: AcpPermissionRules,
  gatePath: string,
  sandbox?: { extensions: "user" | "none" },
): readonly string[] {
  if (profile === "none") return ["--no-tools"];
  const readTools = PI_TOOLS.filter(([, tool]) => !denied(rules, tool)).map(([name]) => name);
  const sandboxed = profile === "review" && sandbox !== undefined;
  const gated = sandboxed || reviewDecidesShell(profile, rules);
  const tools = gated ? [...readTools, "bash"] : readTools;
  if (tools.length === 0) return ["--no-tools"];
  return [
    ...(sandboxed && sandbox.extensions === "none" ? ["--no-extensions"] : []),
    ...(gated ? [PI_GATE_ARG, gatePath] : []),
    "--tools",
    tools.join(","),
  ];
}

/** The gate extension is nax's own source, readable by the user alone; the wrapper has to be executable. */
const PI_GATE_MODE = 0o600;
const PI_WRAPPER_MODE = 0o700;
/** pi-acp's own default when the caller names no executable. */
const PI_DEFAULT_COMMAND = "pi";

/** The wrapper `PI_ACP_PI_COMMAND` names: exec pi with the profile's arguments, forwarding the caller's own. */
function piWrapper(command: string, args: readonly string[]): string {
  return `#!/bin/sh\nexec ${[command, ...args].map(shellQuote).join(" ")} "$@"\n`;
}

/**
 * pi's launch env: the gate extension when one is needed, then the wrapper that
 * runs pi with the profile's `--tools` (or `--no-tools`). The caller's own
 * `PI_ACP_PI_COMMAND` names the executable to wrap, so a caller can point nax at
 * a pi build without weakening the enforcement.
 */
async function piLaunchEnv(
  options: ResolvedAcpOptions,
  profile: "none" | "read" | "review",
): Promise<Readonly<Record<string, string>>> {
  const rules = options.rules;
  const plan = profile === "review" && options.shellSandboxPlan?.agent === "pi" ? options.shellSandboxPlan : undefined;
  const gate = plan
    ? await writePiFile(options.stateDir, "sandbox-gate", piSandboxGateSource(plan.prefix), PI_GATE_MODE)
    : reviewDecidesShell(profile, rules)
      ? await writePiFile(options.stateDir, "shell-gate", PI_SHELL_GATE_SOURCE, PI_GATE_MODE)
      : "";
  const command = options.env.PI_ACP_PI_COMMAND ?? PI_DEFAULT_COMMAND;
  const body = piWrapper(
    command,
    piToolArgs(profile, rules, gate, plan ? { extensions: plan.piExtensions } : undefined),
  );
  return Object.freeze({ PI_ACP_PI_COMMAND: await writePiFile(options.stateDir, "wrapper", body, PI_WRAPPER_MODE) });
}

/**
 * The environment the profile's rules add to the agent process (SPEC US-002,
 * extended by US-004), the one seam every launch goes through — a new session, a
 * resume and a reconnect. An agent whose entry names no policy keeps its
 * `launchEnv` untouched, so its env is exactly what it was before rules existed;
 * a custom agent has no entry and gets nothing. Cursor and pi read their policy
 * from files under the state directory, written here before anything is spawned:
 * a file that cannot be written refuses the open (policy-files.ts). The caller
 * spreads this over its own env, so neither the caller nor a model can weaken the
 * enforcement value.
 */
export async function policyLaunchEnv(
  profile: AgentSessionProfile,
  options: ResolvedAcpOptions,
): Promise<Readonly<Record<string, string>>> {
  const plan = options.shellSandboxPlan;
  if (plan !== undefined) {
    await writeStateFile(options.stateDir, relative(options.stateDir, plan.policyFile), plan.policyContent, 0o600);
  }
  const entry = options.entry;
  if (!isReadOnlyProfile(profile)) return launchEnvFor(profile, entry);
  switch (entry?.readOnly?.policy) {
    case "opencode":
      if (profile === "review" && plan?.agent === "opencode") {
        return opencodeSandboxEnv(plan, opencodePermissionConfig(profile, options.rules), options.env);
      }
      return Object.freeze({ OPENCODE_CONFIG_CONTENT: opencodePermissionConfig(profile, options.rules) });
    case "cursor":
      return Object.freeze({
        CURSOR_CONFIG_DIR: await writeCursorPolicy(options.stateDir, cursorCliConfig(profile, options.rules)),
      });
    case "pi":
      return piLaunchEnv(options, profile);
    default:
      return launchEnvFor(profile, entry);
  }
}
