/**
 * Runs a command the PROJECT declared, never one the model wrote.
 *
 * This reaches a shell, deliberately: nax's quality runner
 * (`src/quality/runner.ts`, supplied as `runDeclaredCommand`) executes every
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
import type { QualityCommandSpec } from "#src/internal/command-spec/index";
import { describeValuesType } from "#src/internal/describe-value-type";
import { shellQuoteArg } from "#src/internal/shell-quote";
import type { CommandLauncher } from "../sandbox/index.ts";
import { pathListElements } from "./path-list.ts";
import type { CodingTool, ToolResult, ToolRunContext } from "./registry.ts";
import { runExecBranch } from "./run-command-exec.ts";
import { runCommandDescription, runCommandInputSchema } from "./run-command-surface.ts";
import { cutToByteCap, READ_CEILING } from "./truncate.ts";

// Re-exported so the seam keeps its `#src/tools/run-command` specifier (tests)
// and its `./internal` API-snapshot name after US-008 moved it next to the
// description it feeds. Same object instance either way: one import graph.
export { _runCommandToolDeps } from "./run-command-surface.ts";

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
  /** P4: how the argv runs. Absent = direct runArgv (unit tests). */
  readonly launcher?: CommandLauncher;
  /**
   * US-008: whether this session offers the per-call `unsandboxed` argument on
   * the argv branch (`NativeBackendOptions.allowUnsandboxedCommands`, threaded
   * down through `buildDeclaredCommandTools`). It shapes the ADVERTISEMENT only
   * -- the two schema fields and one description sentence.
   *
   * `runExecBranch` never reads it: an `argv` call carrying `unsandboxed: true`
   * runs unwrapped whenever the RUNTIME let the call through, which is where
   * "is this permitted" is decided (US-005/US-006, `resolveUnsandboxedCall` in
   * `src/tools/runtime-calltool.ts`). Making the option a second gate here
   * would put the same decision in two places, and a session that simply did
   * not advertise the field could then be steered into running unwrapped by a
   * stray input key.
   */
  readonly unsandboxedCommands?: boolean;
}

/** What RunCommand hands the runner for one declared command. */
export interface DeclaredCommandRequest {
  readonly commandName: string;
  readonly command: QualityCommandSpec;
  readonly workdir: string;
  readonly stripEnvVars: string[];
  readonly origin: "agent-tool";
}

/** What RunCommand reads back. */
export interface DeclaredCommandResult {
  readonly success: boolean;
  readonly exitCode: number;
  readonly output: string;
}

/** Runs one declared command; nax supplies `runQualityCommand` (S1 spec port 7). */
export type DeclaredCommandRunner = (request: DeclaredCommandRequest) => Promise<DeclaredCommandResult>;

export interface RunCommandToolOptions {
  /** Secret environment variables excluded from agent-triggered commands. */
  readonly stripEnvVars?: readonly string[];
  /** See `RunCommandExecOptions`. */
  readonly exec?: RunCommandExecOptions;
  /**
   * Execution cwd for the DECLARED (non-Exec) branch below, independent of
   * `ctx.root` (tool containment). Falls back to `ctx.root` when absent —
   * post-PR2 (single-frame redesign) `ctx.root` is the story's repo-rooted
   * execution root, so an omitted `commandCwd` runs the declared command at
   * the repo root, NOT the package dir. Every production caller threads
   * `commandCwd` (see the `buildCodingToolSupport` producer below); the
   * fallback is effectively unreachable in production and only fires from
   * tests that bypass the support seam — see the use site for the exact
   * behavior.
   *
   * PRODUCER: src/agents/coding-tool-support.ts (`buildCodingToolSupport`'s
   * `commandCwd` arg).
   */
  readonly commandCwd?: string;
  /**
   * Runs a DECLARED (non-Exec) command (S1 spec section 4.2, port 7). nax
   * supplies `runQualityCommand` through `resolveCodingToolSupport`; absent,
   * the tool answers `exit 1` and spawns nothing.
   */
  readonly runDeclaredCommand?: DeclaredCommandRunner;
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
function placeholdersOf(spec: QualityCommandSpec): Set<string> {
  const templates = typeof spec === "string" ? [spec] : spec;
  return new Set(templates.flatMap((template) => [...template.matchAll(PLACEHOLDER)].map((m) => m[1] as string)));
}

function describeDeclaredCommand(name: string, spec: QualityCommandSpec): string {
  const placeholders = [...placeholdersOf(spec)];
  if (placeholders.length === 0) return `${name} (no placeholders)`;
  return `${name} (${placeholders.map((p) => `{{${p}}}`).join(", ")})`;
}

function describeDeclaredCommands(declared: ReadonlyMap<string, QualityCommandSpec>): string {
  return [...declared.entries()].map(([name, template]) => describeDeclaredCommand(name, template)).join(", ");
}

// The live-run defect this exists to fix (run-2026-09-14T08-21-43-607Z): the
// "values" input was cast straight to Record<string, unknown> with no shape
// check, so a model sending a STRING got its characters iterated as if they
// were object keys. An empty string produced no rejected keys at all, so the
// unrelated "has no value" branch fired instead; "\t" produced the key "0",
// so the response named a placeholder that was never in the input. 84 of 97
// RunCommand calls in that run hit one of these two shapes, in a loop the
// model could not escape because neither message ever said "values" itself
// was the wrong type. Checked before "raw" is derived, so a malformed shape
// can never reach Object.keys/Object.entries below.
function isPlainValuesObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// #1924, third half (run-2026-09-14T05-55-54-734Z audit, Shape A): the
// original error only ever named what the CHOSEN command declares, never
// which OTHER declared command accepts the rejected key -- an agent that
// wants scoped tests and picks "test" learns "no placeholders" and has to
// guess a second time. Naming the real alternative ends the loop on the
// first denial. Returns an empty array (no hint appended) when no other
// command declares the key either, so a genuinely unrecognized value stays
// exactly as informative as before -- never a false pointer.
function otherCommandsDeclaring(
  declared: ReadonlyMap<string, QualityCommandSpec>,
  key: string,
  currentCommand: string,
): string[] {
  const names: string[] = [];
  for (const [name, spec] of declared) {
    if (name !== currentCommand && placeholdersOf(spec).has(key)) names.push(name);
  }
  return names;
}

const MISSING_RUNNER_OUTPUT = "no declared-command runner is configured for this session";

/** The runner a tool built without one uses: refuses, spawns nothing. */
async function refuseWithoutRunner(): Promise<DeclaredCommandResult> {
  return { success: false, exitCode: 1, output: MISSING_RUNNER_OUTPUT };
}

/** One named default, so the refusal path lives in a single place. */
function declaredCommandRunner(opts: RunCommandToolOptions): DeclaredCommandRunner {
  return opts.runDeclaredCommand ?? refuseWithoutRunner;
}

/**
 * The refusal for a field that applies only to an `argv` call, or undefined when
 * the call carries none.
 *
 * Every refusal lives in ONE function because `run` sits at its
 * cognitive-complexity baseline (`scripts/baselines/complexity-baseline.json`:
 * the gate only ever lowers, and another `if` in `run` fails
 * `bun run check:complexity`), which is why the message strings moved out too.
 *
 * #2066 is the reason `target` is refused rather than ignored: 48 of 136
 * declared-command calls in one audited run carried a `target` that was silently
 * discarded, and the transcript shows the model reasoning about it while trying
 * to fix a failure. `unsandboxed` gets the same treatment for the same reason,
 * plus a harder one: silently dropping an escape request would run the command
 * SANDBOXED while the caller believes it escaped, which is a wrong answer rather
 * than a missing one. `unsandboxedReason` is refused for the #2066 reason alone:
 * on its own no escape was requested, so nothing unsafe happens -- but a silent
 * drop teaches the model nothing, and it re-sends the same call.
 */
function argvOnlyFieldRefusal(input: Record<string, unknown>): string | undefined {
  if (input.unsandboxed === true) return '"unsandboxed" applies only to "argv" calls';
  if (input.unsandboxedReason !== undefined) {
    return '"unsandboxedReason" applies only to "argv" calls, alongside "unsandboxed": true. Remove "unsandboxedReason".';
  }
  if (input.target === undefined) return undefined;
  const key = typeof input.command === "string" ? input.command : "";
  return `"target" applies only to "argv" calls; a declared command runs in the directory its configuration declares. Remove "target" and call "${key}" on its own.`;
}

export function createRunCommandTool(
  declared: ReadonlyMap<string, QualityCommandSpec>,
  opts: RunCommandToolOptions = {},
): CodingTool {
  const keys = [...declared.keys()];
  const exec = opts.exec;
  const hasExec = exec !== undefined;
  const commandDescriptions = describeDeclaredCommands(declared);
  const runDeclared = declaredCommandRunner(opts);
  return {
    name: "RunCommand",
    // A non-zero exit here is the agent's red/green loop, not a fault.
    routineErrors: true,
    description: runCommandDescription(commandDescriptions, exec),
    inputSchema: runCommandInputSchema(keys, exec),
    // `{{files}}` is the declared scoped-test path parameter. Keeping it in
    // the policy's containment seam prevents a quoted-but-otherwise harmless
    // absolute filename from making the configured command act outside root.
    // `argvField` is set only when exec is available: it is what lets the
    // policy recognize an argv call and check it under the `Exec` identity
    // (see src/tools/runtime.ts and src/tools/policy.ts) rather than under
    // RunCommand's own grant.
    //
    // US-008: `unsandboxedField` is likewise set whenever exec is available,
    // unconditionally -- the runtime reads the field to route an escaping argv
    // call (Bash's rule, US-003), while whether the argument is OFFERED is
    // `exec.unsandboxedCommands`' business. A declared-command call carries no
    // Exec identity, so the runtime leaves that flag to `run` below, which
    // refuses it by name.
    scope: {
      pathFields: [],
      listPathFields: ["values.files"],
      verbField: "command",
      allowedVerbs: keys,
      ...(hasExec ? { argvField: "argv", unsandboxedField: "unsandboxed" } : {}),
    },

    async run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
      const hasCommand = typeof input.command === "string" && input.command.length > 0;
      const hasArgv = input.argv !== undefined;
      if (hasCommand && hasArgv) {
        return { content: "supply exactly one of command or argv, not both", isError: true };
      }
      if (hasArgv) return runExecBranch(input, ctx, opts);

      const misplaced = argvOnlyFieldRefusal(input);
      if (misplaced !== undefined) return { content: misplaced, isError: true };

      const key = typeof input.command === "string" ? input.command : "";
      const template = declared.get(key);
      if (template === undefined) return { content: `unknown command "${key}"`, isError: true };

      if (input.values !== undefined && !isPlainValuesObject(input.values)) {
        return {
          content: `"values" must be an object mapping placeholder names to values, e.g. { files: "a.test.ts" } -- got ${describeValuesType(input.values)} instead`,
          isError: true,
        };
      }
      const raw = (input.values ?? {}) as Record<string, unknown>;

      // Shape A of the run-2026-09-14T05-55-54-734Z audit: check every
      // rejected key against every OTHER declared command before falling
      // through to substituteCommandSpec's generic error, so the response
      // can name the command that actually accepts it. Only the first
      // rejected key with a real alternative is reported -- consistent with
      // substituteCommandSpec, which also stops at the first offending key.
      const templateKeys = placeholdersOf(template);
      for (const rejectedKey of Object.keys(raw)) {
        if (templateKeys.has(rejectedKey)) continue;
        const alternates = otherCommandsDeclaring(declared, rejectedKey, key);
        if (alternates.length === 0) continue;
        return {
          content: `value "${rejectedKey}" is not a placeholder in this command (${declaredPlaceholdersSuffix(templateKeys)}) -- "${rejectedKey}" is a placeholder in: ${alternates.join(", ")}`,
          isError: true,
        };
      }

      const values: Record<string, string | readonly string[]> = {};
      for (const [k, v] of Object.entries(raw)) {
        values[k] = Array.isArray(v) && v.every((element) => typeof element === "string") ? v : String(v);
      }

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
      const rawFilesValue =
        typeof rawFiles === "string"
          ? rawFiles
          : Array.isArray(rawFiles) && rawFiles.every((element) => typeof element === "string")
            ? rawFiles
            : undefined;
      const elements =
        typeof rawFilesValue === "string"
          ? pathListElements(rawFilesValue, ctx.root)
          : Array.isArray(rawFilesValue)
            ? rawFilesValue
            : undefined;
      if (elements !== undefined && rawFilesValue !== undefined) {
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
            : rawFilesValue;
      }

      const command = substituteCommandSpec(template, values);
      if (typeof command !== "string" && !Array.isArray(command)) return { content: command.error, isError: true };

      const result = await runDeclared({
        commandName: key,
        command,
        // Post-PR2 `ctx.root` is the repo root (not the package dir), so an
        // omitted `commandCwd` runs the declared command at the repo root —
        // every production caller threads `commandCwd` via `buildCodingToolSupport`;
        // this fallback only fires from tests that bypass the support seam.
        workdir: opts.commandCwd ?? ctx.root,
        stripEnvVars: [...(opts.stripEnvVars ?? [])],
        // The agent's own iteration loop, not a harness gate: kept in the JSONL
        // at debug, off the console. Its outcome reaches the agent through the
        // returned content, and the harness reports its own gates separately.
        origin: "agent-tool",
      });
      const body = `exit ${result.exitCode}\n${result.output}`;
      // Tool-layer I/O bound, not the model-facing cap: `maxBytes` shapes what
      // the model is told and belongs to the session's truncation policy, which
      // spills the cut. Bounded here so a runaway command cannot be buffered
      // without limit, and cut on a codepoint boundary so the returned body
      // never carries a replacement character.
      return { content: cutToByteCap(body, ctx.readCeiling ?? READ_CEILING), isError: !result.success };
    },
  };
}
