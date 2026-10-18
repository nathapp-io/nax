/**
 * ACP shell commands, adjudicated by the operator's own Bash rules
 * (SPEC-cursor-pi-acp-read-only US-003). Under `review` an agent process runs
 * unsandboxed, so a shell command it asks about would otherwise be denied
 * outright. Here nax reads the RAW command — never the secret-masked display
 * text a person would see, and never the agent's own reading of it — and checks
 * it against the same `execution.permissions.<stage>.allow / deny / ask` rules a
 * native session uses.
 *
 * Fail closed, four ways (the native lexer's guarantee, reused whole):
 * a command the lexer refuses, one with no segment, one with any redirect, and
 * one with any opaque token (a `$`-expansion, whose runtime value nax cannot
 * know) are all denied, whatever the rules say. A redirect is denied even when
 * an allow rule names the command: the agents that translate Bash rules match
 * command TEXT and know nothing of redirects, which is why the decision belongs
 * here rather than in an agent's own config.
 *
 * `ask` counts as a deny: nobody answers an ACP read-only session.
 */
import { type BashSegment, compileArgvPattern, lexBashCommand, matchesArgvPattern } from "@nathapp/nax-agent";
import type { AcpPermissionRules } from "#src/client/rule-policy";
import { isRecord } from "#src/client/text";

export const SHELL_RULE_REASON = "an operator Bash rule allows this command";
export const PI_SHELL_GATE_TITLE = "nax: run shell command";

/** The only tool whose rules can allow a command: `Exec` and `RunCommand` are not applied to ACP agents. */
const BASH_TOOL = "Bash";
/** The reason the gate extension blocks a bash call with, both when nobody can answer and when they said no. */
export const PI_SHELL_GATE_REJECTED = "nax: shell command rejected";

/**
 * The pi extension that gives pi a permission system (SPEC US-003): pi-acp hands
 * the confirm prompt to nax as an ACP permission request, and nax answers it with
 * the operator's Bash rules. `pi` has neither a read-only mode nor permission
 * config, so this is its only enforcement path under `review`.
 * US-004 writes this to disk; it is a plain module so pi can load it directly.
 */
export const PI_SHELL_GATE_SOURCE = `/**
 * nax's pi shell gate. pi has no permission system of its own, so this extension
 * turns every bash call into a confirm prompt: pi-acp hands that prompt to nax as
 * an ACP permission request, and nax answers it with the operator's Bash rules.
 * Written by nax; do not edit in place.
 */
export default function naxShellGate(pi) {
  const blocked = { block: true, reason: ${JSON.stringify(PI_SHELL_GATE_REJECTED)} };

  pi.on("tool_call", async (event, ctx) => {
    if (!event || event.toolName !== "bash") return undefined;
    const command = event.input && typeof event.input.command === "string" ? event.input.command : "";
    const ui = ctx && ctx.hasUI === true ? ctx.ui : undefined;
    // Fail closed: nothing readable to ask about, and nobody able to answer.
    if (command === "" || !ui || typeof ui.confirm !== "function") return blocked;
    return (await ui.confirm(${JSON.stringify(PI_SHELL_GATE_TITLE)}, command)) === true ? undefined : blocked;
  });
}
`;

type Call = Readonly<Record<string, unknown>>;

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** pi speaks through its own extension prompt: a confirm method, the gate's title and the command as the message. */
function piGateCommand(call: Call, kind: unknown): string | undefined {
  if (kind !== "other" || !isRecord(call.rawInput)) return undefined;
  const raw = call.rawInput;
  if (raw.method !== "confirm" || raw.title !== PI_SHELL_GATE_TITLE) return undefined;
  return nonEmpty(raw.message);
}

/** Cursor carries the command in the title, in backticks (its own hooks rewrite it first). */
function cursorCommand(call: Call, kind: unknown): string | undefined {
  if (kind !== "execute") return undefined;
  const title = nonEmpty(call.title);
  if (title === undefined) return undefined;
  const enclosed = title.length >= 2 && title.startsWith("`") && title.endsWith("`");
  return enclosed ? title.slice(1, -1) : title;
}

/** Every other agent carries it in rawInput.command. */
function rawCommand(call: Call, kind: unknown): string | undefined {
  if (kind !== "execute" || !isRecord(call.rawInput)) return undefined;
  return nonEmpty(call.rawInput.command);
}

/**
 * The shell command this tool call asks about, from the raw agent fields only
 * (never the masked display text), or undefined when the call is not one.
 */
export function shellCommandOf(agentName: string, toolCall: unknown): string | undefined {
  if (!isRecord(toolCall)) return undefined;
  if (agentName === "pi") return piGateCommand(toolCall, toolCall.kind);
  if (agentName === "cursor") return cursorCommand(toolCall, toolCall.kind);
  return rawCommand(toolCall, toolCall.kind);
}

/** nax's native matcher, plus the rule that the pattern `*` alone is unconditional. */
function patternMatches(pattern: string, argv: readonly string[]): boolean {
  return pattern === "*" || matchesArgvPattern(compileArgvPattern(pattern), argv);
}

function anyPatternMatches(
  rules: readonly { tool: string; patterns: readonly string[] }[],
  argv: readonly string[],
): boolean {
  return rules.some(
    (rule) => rule.tool === BASH_TOOL && rule.patterns.some((pattern) => patternMatches(pattern, argv)),
  );
}

/**
 * One command between control operators: allowed only when an allow rule matches
 * its argv and no deny or ask rule does. The payload checks a native session runs
 * (denied flags, path containment) have no equivalent here: an ACP command has no
 * resolved paths, and the rules are the whole decision.
 */
function segmentAllowed(segment: BashSegment, rules: AcpPermissionRules): boolean {
  if (segment.redirects.length > 0) return false;
  if (segment.tokens.some((token) => token.opaque)) return false;
  const argv = segment.tokens.map((token) => token.text);
  if (!anyPatternMatches(rules.allow, argv)) return false;
  return !anyPatternMatches(rules.deny, argv) && !anyPatternMatches(rules.ask, argv);
}

/** Explicit deny/ask rules still bind inside the sandbox; lexer refusals remain sandboxed. */
export function shellRuleBlocks(command: string, rules: AcpPermissionRules): boolean {
  const lexed = lexBashCommand(command);
  if (lexed.kind !== "ok") return false;
  return lexed.segments.some((segment) => {
    const argv = segment.tokens.map((token) => token.text);
    return anyPatternMatches(rules.deny, argv) || anyPatternMatches(rules.ask, argv);
  });
}

/** "allow" only when the lexer read the whole command and every segment is allowed. */
export function shellRuleVerdict(command: string, rules: AcpPermissionRules): "allow" | "deny" {
  const lexed = lexBashCommand(command);
  if (lexed.kind !== "ok" || lexed.segments.length === 0) return "deny";
  return lexed.segments.every((segment) => segmentAllowed(segment, rules)) ? "allow" : "deny";
}
