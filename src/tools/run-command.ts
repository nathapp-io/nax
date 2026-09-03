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

export function substituteCommand(template: string, values: Record<string, string>): string | { error: string } {
  const declared = new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1] as string));
  for (const key of Object.keys(values)) {
    if (!declared.has(key)) return { error: `value "${key}" is not a placeholder in this command` };
  }
  for (const key of declared) {
    if (values[key] === undefined) return { error: `placeholder {{${key}}} has no value` };
  }
  return template.replaceAll(PLACEHOLDER, (_m, key: string) => shellQuoteArg(values[key] as string));
}

export function createRunCommandTool(declared: ReadonlyMap<string, string>): CodingTool {
  const keys = [...declared.keys()];
  return {
    name: "RunCommand",
    description: `Run one of this project's declared commands: ${keys.join(", ")}. Supply values for its placeholders; you cannot write a command of your own.`,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", enum: keys, description: "Which declared command to run" },
        values: { type: "object", description: 'Values for the command\'s placeholders, e.g. { files: "a.test.ts" }' },
      },
      required: ["command"],
    },
    scope: { pathFields: [], verbField: "command", allowedVerbs: keys },

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
        stripEnvVars: [],
      });
      const body = `exit ${result.exitCode}\n${result.output}`;
      return { content: body.slice(0, ctx.maxBytes), isError: !result.success };
    },
  };
}
