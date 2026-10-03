/**
 * Turn resolved grants plus an operation's declaration into a live runtime.
 *
 * nax-permission-mode-allow: consumes permissions already resolved by
 * resolvePermissions; decides none.
 *
 * Callers reach it through `resolveCodingToolSupport`
 * (`coding-tool-support-resolve.ts`, nax side), the single entry point both
 * dispatch hops use.
 */

import type { CommandInterceptor } from "#src/command-interceptor/index";
import type { CommandShadow } from "#src/command-safety/index";
import type { BashApprovalMode } from "#src/config/bash-approval";
import { getSafeLogger, NaxError } from "#src/infra/index";
import type { QualityCommandSpec } from "#src/internal/command-spec/index";
import type { AskResolver } from "#src/permissions/index";
import type { CommandLauncher } from "#src/sandbox/index";
import {
  advertisedSchemaBytes,
  BASH_TOOL_NAME,
  type CodingTool,
  type CodingToolName,
  type CodingToolRuntime,
  compileToolPolicy,
  createCodingToolRuntime,
  createNoOpToolAuditSink,
  createToolAuditSink,
  type DeclaredCommandRunner,
  EXEC_TOOL_NAME,
  type ProtectedPathsPolicy,
  type ToolAuditSink,
  type ToolGrant,
  type ToolPatternNarrowing,
} from "#src/tools/index";
import { resolveBashSupport } from "./coding-tool-bash.ts";
import { buildDeclaredCommandTools } from "./coding-tool-extras.ts";
import { isTempConfined, rawScreenOptionsFor } from "./coding-tool-sandbox.ts";

export interface CodingToolSupport {
  readonly runtime: CodingToolRuntime;
  readonly tools: readonly CodingTool[];
  readonly auditSink: ToolAuditSink;
}

export function buildCodingToolSupport(args: {
  root?: string;
  /**
   * Execution root for Exec's `target: "repoRoot"` form.
   *
   * Under story worktree isolation this is the story's worktree root
   * (`<repo>/.nax-wt/<storyId>`), NOT the main checkout — a repo-scoped command
   * that used `PackageView.repoRoot` here wrote the user's real working tree
   * (nax#2093). Falls back to `root` when absent. Post single-frame redesign
   * (PR2) `root` is already `storyExecRoot`, so `resolveCodingToolSupport`
   * passes no separate value and the fallback supplies it.
   */
  repoRoot?: string;
  /**
   * The story's ABSOLUTE package dir for Exec's `target: "package"` cwd.
   *
   * Post-root-move, `codingToolRoot` is `storyExecRoot` (the repo/worktree
   * root), so `args.root` can no longer
   * stand in for the package dir: `run-command-exec.ts` computes
   * `relative(repoRoot, packageWorkdir)`, which would always be "" and make
   * `package-managers.ts`'s `effectiveTarget` collapse EVERY Exec call —
   * `target: "package"` included — onto the repo root. It MUST be an
   * absolute path: `packageWorkdir` is compared against the absolute
   * `repoRoot`, so a relative value yields garbage. Falls back to `root`
   * when absent (single-package repos, legacy callers, tests).
   */
  packageWorkdir?: string;
  /**
   * Execution cwd for RunCommand's DECLARED (non-Exec) branch, independent
   * of `root` (tool containment). Falls back to `root` when absent.
   *
   * PRODUCER: resolveCodingToolSupport below, computed from
   * `codingToolPackageDir` + `projectDir` (docs/superpowers/specs/2026-09-18-single-frame-redesign-design.md
   * PR 1) so it stays pointed at the story's package dir even after PR2
   * repoints `codingToolRoot`/`root` at the repo root.
   */
  commandCwd?: string;
  grants?: readonly ToolGrant[];
  declared: readonly CodingToolName[];
  /** Provider-supplied tools for this hop, looked up before the global registry. */
  extraTools?: readonly CodingTool[];
  /** Advertised provider tool name -> owning provider id, for the ledger. */
  providerIdByTool?: ReadonlyMap<string, string>;
  storyId?: string;
  declaredCommands?: ReadonlyMap<string, QualityCommandSpec>;
  /** Port 7, forwarded to RunCommand. Supplied by `resolveCodingToolSupport`. */
  runDeclaredCommand?: DeclaredCommandRunner;
  /** Port 7: the run's interceptor, placed on every tool context. */
  interceptor?: CommandInterceptor;
  /** Port 6: host-owned paths, placed on every tool context. */
  protectedPaths?: ProtectedPathsPolicy;
  stripEnvVars?: readonly string[];
  /** `quality.shell` — the shell the Bash tool spawns. Defaults to /bin/sh. */
  shell?: string;
  auditDir?: string;
  sessionName?: string;
  header?: import("../tools/tool-audit.ts").ToolAuditHeader;
  callId?: string;
  scopeId?: string;
  /**
   * Manifest name of the workspace member at the story's package dir
   * (`packageWorkdir`/`commandCwd`), NOT at `root` — post-PR2 `root` is the
   * repo root, so reading its manifest would scope workspace installs with the
   * root name. See `resolvePackageName`.
   */
  packageName?: string;
  /** `config.install.allowScripts` (Task 8 adds the field); defaults to false. */
  allowScripts?: boolean;
  /** `config.execution.denyPaths` (nax#1972); forwarded to createCodingToolRuntime verbatim. */
  denyPaths?: readonly string[];
  /** Per-tool narrowing from the op's `toolPatterns` (nax#2013). */
  toolPatterns?: ToolPatternNarrowing;
  /** Stage deny rules (spec R6); forwarded to `compileToolPolicy`. Bypasses `narrowGrants`. */
  denyRules?: readonly ToolGrant[];
  /** Stage ask rules (spec R1/R6); forwarded to `compileToolPolicy`. Bypasses `narrowGrants`. */
  askRules?: readonly ToolGrant[];
  /** PipelineStage this support is built for; carried into every `AskRequest`. */
  pipelineStage?: string;
  /**
   * Absolute path the dispatching op declared as its `fileOutput` (nax#2115);
   * forwarded to `compileToolPolicy` as its `ownedWriteExemption`.
   */
  fileOutputPath?: string;
  /** nax#2260: `execution.sandbox.filesystem.allowWrite`, forwarded to `compileToolPolicy`. */
  naxAllowWrite?: readonly string[];
  bashApproval?: BashApprovalMode;
  /** Injectable ask resolver (Task 3); defaults to the headless deny resolver. */
  askResolver?: AskResolver;
  /**
   * P5 shadow classifier. Observational, except its optional `guard`
   * (US-004): a flagged allowed `Bash`/`Exec` call becomes an ask.
   */
  commandShadow?: CommandShadow;
  /** P4: resolved by resolveCodingToolSupport (async); data only here. */
  launcher?: CommandLauncher;
  /** US-001: forwarded into ToolRunContext so Bash/Exec can SIGKILL on cancel. */
  abortSignal?: AbortSignal;
}): CodingToolSupport | undefined {
  if (args.declared.length === 0) return undefined;
  const grants = args.grants ?? [];
  const bashApproval = args.bashApproval ?? "gated";
  // ADR-030 / F1: under `raw`, a declared Bash gets a SYNTHETIC grant further
  // down (resolveBashSupport) even with zero real grants -- `scoped` with no
  // stage allow rules is the only path there, and must not be
  // indistinguishable from `scoped` + an unrelated allow list. Computed
  // ahead of the guard so the guard can special-case it.
  const rawSyntheticBash = bashApproval === "raw" && args.declared.includes(BASH_TOOL_NAME);
  if (grants.length === 0 && !rawSyntheticBash) return undefined;

  // An empty root passed to a spawn or a path join silently means
  // process.cwd() — the directory nax was launched from, which under `-d` is a
  // different repository. That is the #1794 defect; refuse instead. Callers
  // pass packageWorkdir(view), which never yields "".
  //
  // F1 side effect: this throw now also fires for raw + declared Bash + an
  // empty root, where the old guard returned `undefined` first. Correct --
  // the #1794 guard should fire there -- and pinned by a test.
  if (args.root === undefined || args.root.trim() === "") {
    throw new NaxError(
      "Cannot enable coding tools: no working directory was supplied, so the permitted root is unknown.",
      "CODING_TOOL_ROOT_MISSING",
      { stage: "tools" },
    );
  }

  // `Exec` is a capability marker in an operation's `tools` declaration, not
  // a registered tool — nothing in registerBuiltinCodingTools carries this
  // name. It decides whether RunCommand gets its argv branch (Task 6); it
  // must never reach runtime.advertised() itself, or the lookup for a tool
  // named "Exec" would simply fail and the marker would vanish from the
  // advertised set without a trace of why.
  const execGrant = grants.findLast((grant) => grant.tool === EXEC_TOOL_NAME);
  const allowExec = args.declared.includes(EXEC_TOOL_NAME) && execGrant !== undefined;
  const advertised = args.declared.filter((name) => name !== EXEC_TOOL_NAME);

  // Gated on DECLARATION ALONE — deliberately not on the grant.
  //
  // Declaration is the ceiling: a tool the runtime can LOOK UP is callable even
  // when `advertised()` never returned it (callTool resolves the name before it
  // consults advertisement), so a stage that grants Bash must not hand it to a
  // reviewer op that never declared it (spec §6 row 11).
  //
  // But an op that DID declare it and holds no grant must be refused by the
  // POLICY, not by a failed name lookup: "unknown tool" carries no redirect,
  // and spec §6 row 1 requires the ungranted case to offer an alternative. So
  // the tool is constructed either way; with no grant, `grantedTools()` still
  // excludes it (never advertised, no schema cost in the prompt), yet the
  // tool's EXISTENCE is what lets the call reach `policy.check` and be denied
  // there -- and only that denial path (in `runtime.callTool`, using
  // `denial-redirect.ts`) can attach a redirect.
  const { effectiveGrants, allowBash, bashDescriptionPatterns } = resolveBashSupport({
    declared: args.declared,
    grants,
    toolPatterns: args.toolPatterns,
    bashApproval,
  });

  const declaredCommands = args.declaredCommands ?? new Map<string, QualityCommandSpec>();
  // P4/S5: under `raw`, an UNAVAILABLE launcher refuses every Bash call.
  // US-002: an AVAILABLE one marks the screen sandbox-wrapped, so a PRD it only reads is allowed.
  const rawScreenOptions = rawScreenOptionsFor(args.launcher);
  const sink =
    args.auditDir !== undefined
      ? createToolAuditSink({
          dir: args.auditDir,
          sessionName: args.sessionName ?? "unattached",
          ...(args.header ? { header: args.header } : {}),
        })
      : createNoOpToolAuditSink();
  const runtime = createCodingToolRuntime({
    policy: compileToolPolicy(effectiveGrants, args.root, {
      bashApproval,
      ...rawScreenOptions,
      ...(args.denyRules !== undefined ? { denyRules: args.denyRules } : {}),
      ...(args.askRules !== undefined ? { askRules: args.askRules } : {}),
      ...(args.fileOutputPath !== undefined ? { ownedWriteExemption: args.fileOutputPath } : {}),
      ...(args.naxAllowWrite !== undefined ? { naxAllowWrite: args.naxAllowWrite } : {}),
    }),
    declaredCommands: new Set(declaredCommands.keys()),
    interceptor: args.interceptor,
    protectedPaths: args.protectedPaths,
    ...(args.abortSignal !== undefined ? { signal: args.abortSignal } : {}),
    ...(args.askResolver !== undefined ? { askResolver: args.askResolver } : {}),
    ...(args.commandShadow !== undefined ? { commandShadow: args.commandShadow } : {}),
    // US-004: the sandbox's temp posture reaches the command guard's temp-only
    // exemption. `isTempConfined` keeps the state read out of this function,
    // which sits at its complexity baseline.
    tempConfined: isTempConfined(args.launcher),
    ...(args.pipelineStage !== undefined ? { pipelineStage: args.pipelineStage } : {}),
    ...(args.storyId !== undefined ? { storyId: args.storyId } : {}),
    ...(args.callId !== undefined ? { callId: args.callId } : {}),
    ...(args.scopeId !== undefined ? { scopeId: args.scopeId } : {}),
    ...(args.denyPaths !== undefined ? { denyPaths: args.denyPaths } : {}),
    sink,
    extraTools: [
      ...(args.extraTools ?? []),
      ...buildDeclaredCommandTools({
        declaredCommands,
        runDeclaredCommand: args.runDeclaredCommand,
        allowExec,
        execGrant,
        allowBash,
        bashDescriptionPatterns,
        bashApproval,
        humanApproval: args.askResolver?.humanReachable === true,
        root: args.root,
        ...(args.repoRoot !== undefined ? { repoRoot: args.repoRoot } : {}),
        ...(args.packageWorkdir !== undefined ? { packageWorkdir: args.packageWorkdir } : {}),
        ...(args.commandCwd !== undefined ? { commandCwd: args.commandCwd } : {}),
        ...(args.allowScripts !== undefined ? { allowScripts: args.allowScripts } : {}),
        ...(args.packageName !== undefined ? { packageName: args.packageName } : {}),
        ...(args.stripEnvVars !== undefined ? { stripEnvVars: args.stripEnvVars } : {}),
        ...(args.shell !== undefined ? { shell: args.shell } : {}),
        ...(args.launcher !== undefined ? { launcher: args.launcher } : {}),
      }),
    ],
    ...(args.providerIdByTool !== undefined ? { providerIdByTool: args.providerIdByTool } : {}),
  });
  const tools = runtime.advertised(advertised);
  // The fixed per-hop cost of advertising provider tools: their schemas enter
  // the prompt whether or not any is called. #2031 shipped the meter and left
  // it unread; this is its consumer, and the same instrument nax#1991's
  // context-burn report needs.
  const providerTools = tools.filter((tool) => args.providerIdByTool?.has(tool.name) === true);
  if (providerTools.length > 0) {
    getSafeLogger()?.debug("tools", "[provider] advertised", {
      storyId: args.storyId,
      count: providerTools.length,
      schemaBytes: advertisedSchemaBytes(providerTools),
    });
  }
  if (tools.length === 0) return undefined;
  return { runtime, tools, auditSink: sink };
}

/**
 * Ledger session name.
 *
 * Story-only names collide across the three TDD roles, which all write to one
 * directory -- so a ledger could not answer which session made a call, and that
 * is the evidence ADR-029 parity claims are read from.
 */
export function buildLedgerSessionName(opts: { storyId?: string; sessionRole?: string; featureName?: string }): string {
  const base = opts.storyId ?? opts.featureName;
  if (base === undefined) return "unattached";
  return opts.sessionRole === undefined ? base : `${base}-${opts.sessionRole}`;
}
