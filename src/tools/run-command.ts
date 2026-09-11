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
import { statSync } from "node:fs";
import type { QualityCommandSpec } from "../quality/command-spec";
import { runQualityCommand } from "../quality/runner";
import { shellQuoteArg } from "../verification/shell-quote";
import { pathListElements } from "./path-list";
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";
import { runExecBranch } from "./run-command-exec";

const PLACEHOLDER = /\{\{([a-zA-Z]+)\}\}/g;

/**
 * Context for RunCommand's allowlisted, model-authored argv branch (`Exec`).
 *
 * Populated only when the operation declared the `Exec` marker
 * (`buildCodingToolSupport` in `src/agents/coding-tool-support.ts`).
 */
export interface RunCommandExecOptions {
  readonly repoRoot: string;
  readonly packageWorkdir: string;
  /** Manifest name, required by yarn/cargo's package-scoping form; absent when unresolvable. */
  readonly packageName?: string;
  readonly allowScripts: boolean;
  /**
   * The containment carve-out's write side (Task 10). When present, a
   * successful install-shaped Exec call appends the manifest/lockfile it
   * wrote to this array — see `recordExecTouchedPaths` in
   * `src/tools/exec-touched-paths.ts`. The SAME array reference must be
   * given to `compileToolPolicy`'s `execTouchedPaths` option so a later
   * GitCommit call in this dispatch hop can see the update; omitted
   * entirely means no carve-out is offered for this session.
   */
  readonly touchedPaths?: string[];
  /**
   * The Exec tool's compiled grant patterns, as `resolvePermissions` produced
   * them for THIS project/stage -- not `BUILT_IN_EXEC_PATTERNS` imported
   * directly, because a project's own `Exec(...)` expression REPLACES that
   * built-in list rather than extending it (see the comment on
   * `BUILT_IN_EXEC_PATTERNS` in src/config/permissions.ts). Read only to
   * render the tool description (#1937): the policy check itself still runs
   * against the runtime's own compiled grant in policy.ts, so this field
   * being stale or absent could make the description wrong but can never
   * widen what actually executes.
   */
  readonly patterns: readonly string[];
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

// A bare "no" is what produced the defect this exists to fix (#1924): denied
// with no legal alternative named, the model repeated the identical rejected
// call 18 times in one session because it was never told the placeholder
// set. Matches git.ts's "valid for: ..." phrasing convention. A command with
// no placeholders reads naturally rather than printing "(declared: )".
function declaredPlaceholdersSuffix(declared: ReadonlySet<string>): string {
  if (declared.size === 0) return "this command declares no placeholders";
  return `declared: ${[...declared].join(", ")}`;
}

/**
 * An ARRAY value is quoted per element and joined; a string value is quoted
 * whole. The distinction carries the element boundaries through substitution,
 * which a pre-joined string cannot: the join would be re-split and a path
 * under `/tmp/my dir/` would become two arguments (nax#1998).
 */
export function substituteCommand(
  template: string,
  values: Record<string, string | readonly string[]>,
): string | { error: string } {
  const declared = new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1] as string));
  for (const key of Object.keys(values)) {
    if (!declared.has(key)) {
      return { error: `value "${key}" is not a placeholder in this command (${declaredPlaceholdersSuffix(declared)})` };
    }
  }
  for (const key of declared) {
    if (values[key] === undefined) {
      return { error: `placeholder {{${key}}} has no value (${declaredPlaceholdersSuffix(declared)})` };
    }
  }
  const contextError = placeholderContextError(template);
  if (contextError !== undefined) return { error: contextError };
  return template.replaceAll(PLACEHOLDER, (_m, key: string) => {
    const value = values[key] as string | readonly string[];
    return Array.isArray(value) ? value.map(shellQuoteArg).join(" ") : shellQuoteArg(value as string);
  });
}

/**
 * Apply placeholder substitution across a spec. A list substitutes into every
 * entry and fails as a whole if any entry fails, so a partially-substituted
 * list can never reach the shell.
 *
 * Each entry only receives the subset of `values` it actually declares
 * placeholders for -- list entries commonly have different placeholder needs
 * (e.g. `["tsc --noEmit", "bun test {{files}}"]`), and `substituteCommand`
 * rejects a value that isn't a placeholder in the template it's checking, by
 * design (it's what stops a value silently going nowhere). Passing the full
 * shared `values` object to every entry would make every entry without
 * {{files}} fail that check.
 *
 * But per-entry filtering alone would let a value that no entry in the whole
 * spec declares vanish silently (every entry's filtered set would just be
 * empty, and every entry would substitute cleanly) -- so before filtering
 * per entry, every key in `values` is checked against the UNION of
 * placeholders declared across the whole spec, and rejected with the same
 * "unrecognized value" contract `substituteCommand` gives the single-string
 * case if it isn't declared anywhere.
 */
export function substituteCommandSpec(
  spec: QualityCommandSpec,
  values: Record<string, string | readonly string[]>,
): QualityCommandSpec | { error: string } {
  if (typeof spec === "string") return substituteCommand(spec, values);
  const allDeclared = new Set<string>();
  for (const entry of spec) {
    for (const match of entry.matchAll(PLACEHOLDER)) allDeclared.add(match[1] as string);
  }
  for (const key of Object.keys(values)) {
    if (!allDeclared.has(key)) {
      return {
        error: `value "${key}" is not a placeholder in this command (${declaredPlaceholdersSuffix(allDeclared)})`,
      };
    }
  }
  const out: string[] = [];
  for (const entry of spec) {
    const declaredKeys = new Set([...entry.matchAll(PLACEHOLDER)].map((m) => m[1] as string));
    const entryValues: Record<string, string | readonly string[]> = {};
    for (const [key, value] of Object.entries(values)) {
      if (declaredKeys.has(key)) entryValues[key] = value;
    }
    const substituted = substituteCommand(entry, entryValues);
    if (typeof substituted !== "string") return substituted;
    out.push(substituted);
  }
  return out;
}

// #1924, second half: the description-only fix, which is what prevents the
// repeated-call loop rather than merely explaining it after the first
// failure. Renders each declared command with the placeholders its OWN
// template actually contains, so the model can pick values before it
// guesses -- e.g. "test (no placeholders), testScoped ({{files}})".
function describeDeclaredCommand(name: string, spec: QualityCommandSpec): string {
  const templates = typeof spec === "string" ? [spec] : spec;
  const placeholders = [
    ...new Set(templates.flatMap((template) => [...template.matchAll(PLACEHOLDER)].map((m) => m[1] as string))),
  ];
  if (placeholders.length === 0) return `${name} (no placeholders)`;
  return `${name} (${placeholders.map((p) => `{{${p}}}`).join(", ")})`;
}

function describeDeclaredCommands(declared: ReadonlyMap<string, QualityCommandSpec>): string {
  return [...declared.entries()].map(([name, template]) => describeDeclaredCommand(name, template)).join(", ");
}

// #1937, first half: name the permitted argv forms instead of the bare "only
// some commands and forms are permitted", which the model guessed against 32
// times, denied every time, across three runs. `patterns` is the ACTUAL
// compiled Exec grant for this project/stage (see RunCommandExecOptions),
// never the built-in constant, so an overridden grant is described honestly.
function describeExecAllowlist(patterns: readonly string[]): string {
  if (patterns.includes("*")) return "any command is permitted";
  if (patterns.length === 0) return "no forms are currently granted";
  return `permitted forms: ${patterns.join(", ")}`;
}

export function createRunCommandTool(
  declared: ReadonlyMap<string, QualityCommandSpec>,
  opts: RunCommandToolOptions = {},
): CodingTool {
  const keys = [...declared.keys()];
  const exec = opts.exec;
  const hasExec = exec !== undefined;
  const commandDescriptions = describeDeclaredCommands(declared);
  return {
    name: "RunCommand",
    // A non-zero exit here is the agent's red/green loop, not a fault.
    routineErrors: true,
    description:
      exec !== undefined
        ? `Two ways to run something. (1) Run one of this project's declared commands: ${commandDescriptions} — supply "command" and, optionally, "values" for its placeholders. (2) Run an allowlisted external command via "argv" (an array, e.g. ["bun","add","left-pad"]) — no shell, so no quoting and no shell metacharacters; ${describeExecAllowlist(exec.patterns)}. Supply exactly one of "command" or "argv".`
        : `Run one of this project's declared commands: ${commandDescriptions}. Supply values for its placeholders; you cannot write a command of your own.`,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", enum: keys, description: "Which declared command to run" },
        values: {
          type: "object",
          description:
            'Values for the command\'s placeholders, e.g. { files: "a.test.ts" }. A path placeholder takes several paths separated by spaces, e.g. { files: "a.test.ts b.test.ts" } -- one call, not one per file.',
        },
        ...(hasExec
          ? {
              argv: {
                type: "array",
                items: { type: "string" },
                description:
                  'Argv for an allowlisted external command, e.g. ["bun","add","left-pad"]. No shell: each element is one literal argument. Supply exactly one of "command" or "argv".',
              },
              target: {
                type: "string",
                enum: ["repoRoot", "package"],
                description: 'Working directory for "argv": this package (default) or the repo root.',
              },
            }
          : {}),
      },
      // With exec available, neither field is unconditionally required —
      // run() enforces "exactly one of command or argv" at call time, which
      // a static JSON Schema `required` list cannot express as an either/or.
      ...(hasExec ? {} : { required: ["command"] }),
    },
    // `{{files}}` is the declared scoped-test path parameter. Keeping it in
    // the policy's containment seam prevents a quoted-but-otherwise harmless
    // absolute filename from making the configured command act outside root.
    // `argvField` is set only when exec is available: it is what lets the
    // policy recognize an argv call and check it under the `Exec` identity
    // (see src/tools/runtime.ts and src/tools/policy.ts) rather than under
    // RunCommand's own grant.
    scope: {
      pathFields: [],
      listPathFields: ["values.files"],
      verbField: "command",
      allowedVerbs: keys,
      ...(hasExec ? { argvField: "argv" } : {}),
    },

    async run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
      const hasCommand = typeof input.command === "string" && input.command.length > 0;
      const hasArgv = input.argv !== undefined;
      if (hasCommand && hasArgv) {
        return { content: "supply exactly one of command or argv, not both", isError: true };
      }
      if (hasArgv) return runExecBranch(input, ctx, opts);

      const key = typeof input.command === "string" ? input.command : "";
      const template = declared.get(key);
      if (template === undefined) return { content: `unknown command "${key}"`, isError: true };

      const raw = (input.values ?? {}) as Record<string, unknown>;
      const values: Record<string, string | readonly string[]> = {};
      for (const [k, v] of Object.entries(raw)) values[k] = String(v);

      // `scope.listPathFields: ["values.files"]` means the policy split this
      // value on whitespace and resolved EACH element into ctx.resolvedPaths --
      // absolute, and approved against the grant. Substituting those instead of
      // the raw string is what read.ts, write.ts, edit.ts and grep.ts already
      // do, and it fixes a real defect: `bun test .nax/features/x/foo.test.ts`
      // treats a bare dot-prefixed relative path as a test FILTER, not a path,
      // and reports a confident false "no tests matched" (#1936). The absolute
      // form runs.
      //
      // But a path field is a POLICY declaration, not a claim about what the
      // agent actually passed. `{{files}}` is equally a test-NAME filter
      // (`bun test run-command`), and resolveWithin accepts one happily,
      // turning it into a nonexistent absolute path. So the resolved form is
      // taken only for an element that is an existing FILE; everything else
      // keeps the raw token it arrived as. "" splits to nothing, so it cannot
      // absolutise to the root and run the entire suite.
      //
      // The result is an ARRAY, so each element survives substitution as its
      // own argument -- which is what makes a multi-file scoped run possible
      // at all, and what makes this path agree with scoped-selection.ts
      // (nax#1998). One stat per element against a process spawn is free.
      const rawFiles = raw.files;
      if (typeof rawFiles === "string") {
        const elements = pathListElements(rawFiles, ctx.root);
        // The pairing is positional, and sound because `values.files` is this
        // tool's only path field, so the policy appended exactly these
        // elements in exactly this order (pinned by a test on `scope`).
        //
        // A length mismatch means the two layers disagreed -- a different root
        // spelling, or a file created between the two stats. Falling back to
        // the raw value is the fail-safe direction in BOTH directions: the
        // shell then gets one argument, and one argument is always a subset of
        // what the policy approved, however it split.
        values.files =
          ctx.resolvedPaths.length === elements.length
            ? elements.map((element, i) => {
                const resolved = ctx.resolvedPaths[i];
                const isFile =
                  resolved !== undefined && statSync(resolved, { throwIfNoEntry: false })?.isFile() === true;
                return isFile ? resolved : element;
              })
            : rawFiles;
      }

      const command = substituteCommandSpec(template, values);
      if (typeof command !== "string" && !Array.isArray(command)) return { content: command.error, isError: true };

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
