/**
 * Runs a command the PROJECT declared, never one the model wrote.
 *
 * This reaches a shell, deliberately: src/quality/runner.ts executes every
 * configured command through one to preserve their quoting semantics, and a
 * declared command like "CI=1 bun test {{files}}" has no argv form -- CI=1 is a
 * shell assignment, not a binary. Building a second execution path would mean
 * the same command behaved differently depending on who invoked it.
 *
 * So the property here is narrower than the Git tool's, and is stated rather
 * than implied: the model does not author the command string. It names a
 * declared key and supplies placeholder values, and those values are the entire
 * injection surface. They are quoted with shellQuoteArg -- the same helper
 * command-resolver.ts already applies to {{package}}.
 */
import { runQualityCommand } from "../quality/runner";
import { shellQuoteArg } from "../verification/shell-quote";
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";

const PLACEHOLDER = /\{\{([a-zA-Z]+)\}\}/g;

/**
 * Context for RunCommand's allowlisted, model-authored argv branch (`Exec`).
 *
 * Populated only when the operation declared the `Exec` marker
 * (`buildCodingToolSupport` in `src/agents/coding-tool-support.ts`). This
 * type carries the plumbing Task 6's argv branch needs; `run()` below does
 * not read it yet — Task 6 adds the branch that does.
 */
export interface RunCommandExecOptions {
  readonly repoRoot: string;
  readonly packageWorkdir: string;
  /** Manifest name, required by yarn/cargo's package-scoping form; absent when unresolvable. */
  readonly packageName?: string;
  readonly allowScripts: boolean;
}

export interface RunCommandToolOptions {
  /** Secret environment variables excluded from agent-triggered commands. */
  readonly stripEnvVars?: readonly string[];
  /** See `RunCommandExecOptions`. */
  readonly exec?: RunCommandExecOptions;
}

function quoteAt(template: string, end: number): "single" | "double" | undefined {
  let quote: "single" | "double" | undefined;
  let escaped = false;
  for (let i = 0; i < end; i += 1) {
    const char = template[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "single") {
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== "double") quote = quote === "single" ? undefined : "single";
    if (char === '"' && quote !== "single") quote = quote === "double" ? undefined : "double";
  }
  return quote;
}

function placeholderContextError(template: string): string | undefined {
  for (const match of template.matchAll(PLACEHOLDER)) {
    const start = match.index ?? 0;
    const key = match[1] as string;
    if (quoteAt(template, start) !== undefined) {
      return `placeholder {{${key}}} may not appear inside shell quotes`;
    }
    const tokenStart = Math.max(template.lastIndexOf(" ", start), template.lastIndexOf("\t", start)) + 1;
    const tokenEndMatch = /[ \t\r\n]/.exec(template.slice(start));
    const tokenEnd = tokenEndMatch === null ? template.length : start + tokenEndMatch.index;
    const token = template.slice(tokenStart, tokenEnd);
    if (/[$`()]/.test(token)) {
      return `placeholder {{${key}}} may not appear in a shell expansion`;
    }
  }
  return undefined;
}

export function substituteCommand(template: string, values: Record<string, string>): string | { error: string } {
  const declared = new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1] as string));
  for (const key of Object.keys(values)) {
    if (!declared.has(key)) return { error: `value "${key}" is not a placeholder in this command` };
  }
  for (const key of declared) {
    if (values[key] === undefined) return { error: `placeholder {{${key}}} has no value` };
  }
  const contextError = placeholderContextError(template);
  if (contextError !== undefined) return { error: contextError };
  return template.replaceAll(PLACEHOLDER, (_m, key: string) => shellQuoteArg(values[key] as string));
}

export function createRunCommandTool(
  declared: ReadonlyMap<string, string>,
  opts: RunCommandToolOptions = {},
): CodingTool {
  const keys = [...declared.keys()];
  return {
    name: "RunCommand",
    // A non-zero exit here is the agent's red/green loop, not a fault.
    routineErrors: true,
    description: `Run one of this project's declared commands: ${keys.join(", ")}. Supply values for its placeholders; you cannot write a command of your own.`,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", enum: keys, description: "Which declared command to run" },
        values: { type: "object", description: 'Values for the command\'s placeholders, e.g. { files: "a.test.ts" }' },
      },
      required: ["command"],
    },
    // `{{files}}` is the declared scoped-test path parameter. Keeping it in
    // the policy's containment seam prevents a quoted-but-otherwise harmless
    // absolute filename from making the configured command act outside root.
    scope: { pathFields: ["values.files"], verbField: "command", allowedVerbs: keys },

    async run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
      const key = typeof input.command === "string" ? input.command : "";
      const template = declared.get(key);
      if (template === undefined) return { content: `unknown command "${key}"`, isError: true };

      const raw = (input.values ?? {}) as Record<string, unknown>;
      const values: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) values[k] = String(v);

      const command = substituteCommand(template, values);
      if (typeof command !== "string") return { content: command.error, isError: true };

      const result = await runQualityCommand({
        commandName: key,
        command,
        workdir: ctx.root,
        stripEnvVars: [...(opts.stripEnvVars ?? [])],
        // The agent's own iteration loop, not a harness gate: kept in the JSONL
        // at debug, off the console. Its outcome reaches the agent through the
        // returned content, and the harness reports its own gates separately.
        origin: "agent-tool",
      });
      const body = `exit ${result.exitCode}\n${result.output}`;
      return { content: body.slice(0, ctx.maxBytes), isError: !result.success };
    },
  };
}
