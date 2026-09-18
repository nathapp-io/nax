/**
 * Turn resolved grants plus an operation's declaration into a live runtime.
 *
 * nax-permission-mode-allow: consumes permissions already resolved by
 * resolvePermissions; decides none.
 *
 * This is the seam that makes coding tools reachable at all. Callers reach it
 * through resolveCodingToolSupport() below, which is the single entry point
 * both dispatch hops use — see its comment for why that matters.
 */

import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";
import {
  advertisedSchemaBytes,
  BASH_TOOL_NAME,
  type CodingTool,
  type CodingToolName,
  type CodingToolRuntime,
  compileToolPolicy,
  createBashTool,
  createCodingToolRuntime,
  createNoOpToolAuditSink,
  createRunCommandTool,
  createToolAuditSink,
  EXEC_TOOL_NAME,
  expandMcpRuleGrants,
  mcpRuleAdmits,
  narrowGrants,
  partitionMcpRules,
  type ResolvedProviderTools,
  resolveProviderTools,
  type ToolAuditSink,
  type ToolGrant,
  type ToolPatternNarrowing,
} from "@/tools";
import type { NaxConfig } from "../config";
import { loadConfigForPackage } from "../config";
import { toolAuditDir } from "../config/paths";
import { resolvePermissions } from "../config/permissions";
import type { QualityCommandSpec } from "../quality";
import { packageOverrideKey, packageWorkdir } from "../runtime/packages";
import { errorMessage } from "../utils/errors";
import { resolvePackageName } from "./exec-package-name";
import type { AgentRunOptions } from "./types";

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
  stripEnvVars?: readonly string[];
  /** `quality.shell` — the shell the Bash tool spawns. Defaults to /bin/sh. */
  shell?: string;
  auditDir?: string;
  sessionName?: string;
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
}): CodingToolSupport | undefined {
  if (args.declared.length === 0) return undefined;
  const grants = args.grants ?? [];
  if (grants.length === 0) return undefined;

  // An empty root passed to a spawn or a path join silently means
  // process.cwd() — the directory nax was launched from, which under `-d` is a
  // different repository. That is the #1794 defect; refuse instead. Callers
  // pass packageWorkdir(view), which never yields "".
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
  // Narrowed, not raw: `narrowGrants` is what the POLICY compiles, so reading
  // the raw list here would name forms in the tool's description that the
  // policy then refuses -- the wasted turn the `patterns` option exists to
  // prevent, inverted.
  const narrowedGrants = narrowGrants(grants, args.toolPatterns);
  const bashGrant = narrowedGrants.findLast((grant) => grant.tool === BASH_TOOL_NAME);
  const allowBash = args.declared.includes(BASH_TOOL_NAME);

  const declaredCommands = args.declaredCommands ?? new Map<string, QualityCommandSpec>();
  const sink =
    args.auditDir !== undefined
      ? createToolAuditSink({ dir: args.auditDir, sessionName: args.sessionName ?? "unattached" })
      : createNoOpToolAuditSink();
  const runtime = createCodingToolRuntime({
    policy: compileToolPolicy(narrowedGrants, args.root, {
      ...(args.denyRules !== undefined ? { denyRules: args.denyRules } : {}),
      ...(args.askRules !== undefined ? { askRules: args.askRules } : {}),
      ...(args.fileOutputPath !== undefined ? { ownedWriteExemption: args.fileOutputPath } : {}),
    }),
    declaredCommands: new Set(declaredCommands.keys()),
    ...(args.pipelineStage !== undefined ? { pipelineStage: args.pipelineStage } : {}),
    ...(args.storyId !== undefined ? { storyId: args.storyId } : {}),
    ...(args.denyPaths !== undefined ? { denyPaths: args.denyPaths } : {}),
    sink,
    extraTools: [
      ...(args.extraTools ?? []),
      ...(declaredCommands.size > 0 || allowExec
        ? [
            createRunCommandTool(declaredCommands, {
              stripEnvVars: args.stripEnvVars,
              commandCwd: args.commandCwd ?? args.root,
              ...(allowExec
                ? {
                    exec: {
                      repoRoot: args.repoRoot ?? args.root,
                      // Post-root-move: `args.root` is the repo root, so the
                      // fallback only matters for single-package repos where
                      // the two coincide (and for tests not threading
                      // `packageWorkdir`). Production always threads it via
                      // `commandCwd` plumbing in `resolveCodingToolSupport`
                      // (Task 10), which makes `effectiveTarget`'s
                      // `packageRelPath === ""` collapse impossible for a
                      // package story.
                      packageWorkdir: args.packageWorkdir ?? args.root,
                      allowScripts: args.allowScripts ?? false,
                      // The compiled grant, not BUILT_IN_EXEC_PATTERNS -- a
                      // project's own Exec(...) expression replaces that
                      // list rather than extending it (see the comment on
                      // BUILT_IN_EXEC_PATTERNS in src/config/permissions.ts).
                      // `allowExec` is true only when execGrant is defined,
                      // so this array is never actually empty at this call
                      // site; the fallback exists only for the type.
                      patterns: execGrant?.patterns ?? [],
                      ...(args.packageName !== undefined ? { packageName: args.packageName } : {}),
                    },
                  }
                : {}),
            }),
          ]
        : []),
      ...(allowBash
        ? [
            createBashTool({
              ...(args.shell !== undefined ? { shell: args.shell } : {}),
              ...(args.stripEnvVars !== undefined ? { stripEnvVars: args.stripEnvVars } : {}),
              // The compiled grant, so the description names what THIS stage
              // may run rather than a generic sentence.
              patterns: bashGrant?.patterns ?? [],
            }),
          ]
        : []),
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
 * Resolve coding-tool support for one dispatch, from the run options alone.
 *
 * nax-permission-mode-allow: delegates the decision to resolvePermissions();
 * decides nothing itself.
 *
 * Exists so the two real hops (`operations/build-hop-callback.ts`,
 * `runtime/session-run-hop.ts`) resolve support identically and cannot drift:
 * a tool wired into one hop and not the other is invisible until an operation
 * happens to dispatch through the other. Call this, never the raw producer
 * above — it takes no `auditDir`, so it yields a non-recording ledger sink.
 */
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

/** Injectable deps for testability — mirrors the _agentManagerDeps pattern. */
export const _codingToolSupportDeps = {
  loadConfigForPackage,
};

export async function resolveCodingToolSupport(
  options: Pick<
    AgentRunOptions,
    | "declaredTools"
    | "providers"
    | "toolPatterns"
    | "codingToolRoot"
    | "codingToolFileOutput"
    | "outputDir"
    | "pipelineStage"
    | "storyId"
    | "sessionRole"
    | "featureName"
    | "config"
    | "projectDir"
    | "codingToolPackageDir"
  >,
): Promise<CodingToolSupport | undefined> {
  const declared = options.declaredTools ?? [];
  const resolved = resolvePermissions(options.config, options.pipelineStage ?? "run");
  // PR1 (single-frame redesign, #2066 residual): resolve the declared-command
  // map (and the quality-derived fields around it) from the STORY'S PACKAGE
  // config when one is known, not the config this dispatch happened to be
  // threaded with. loadConfigForPackage is the R4-mandated resolver — never
  // loadConfigForWorkdir directly, never packageView.config
  // (packages.resolve() misses under worktree/parallel isolation, #2069);
  // its required `from` carries the --profile chain (#2126/#2127). Cheap on
  // a hit: loadConfigForWorkdir's own packageConfigCache
  // (rootConfigPath, packageDir, profileKey) serves every dispatch after the
  // first for the same package/profile.
  const packageDir = options.codingToolPackageDir;
  const projectDir = options.projectDir;
  let packageEffectiveConfig: NaxConfig | undefined;
  if (
    packageDir !== undefined &&
    packageDir.trim() !== "" &&
    packageDir !== "." &&
    projectDir !== undefined &&
    projectDir.trim() !== "" &&
    options.config !== undefined
  ) {
    try {
      packageEffectiveConfig = await _codingToolSupportDeps.loadConfigForPackage(
        projectDir,
        // Under storyIsolation "worktree" the package dir is prefixed with
        // `.nax-wt/<storyId>/`, which never matches the plain `<pkg>` keys the
        // per-package override lookup stored — normalize for the LOOKUP ONLY.
        // commandCwd below keeps the RAW dir so the command runs in the story's
        // worktree (see packageOverrideKey in src/runtime/packages.ts).
        packageOverrideKey(packageDir),
        // RULING F2 (see below): options.config's declared type is a Pick,
        // but at runtime both hops source it from the full NaxConfig.
        options.config as unknown as NaxConfig,
      );
    } catch (err) {
      getSafeLogger()?.warn("tools", "Per-package config failed to load for dispatch — using root config", {
        storyId: options.storyId ?? "_dispatch",
        packageDir,
        error: errorMessage(err),
      });
    }
  }

  // RULING F2: AgentRunOptions['config'] is typed as the agent-manager Pick
  // (agent/execution/profile), yet both hops source it from configLoader.current(),
  // so it carries the full NaxConfig at runtime — only the type lies. The read is
  // widened locally here; the shared agentManagerConfigSelector stays untouched.
  // Now sourced from packageEffectiveConfig when a package story resolved one
  // above, so a per-package quality.commands/install override is honored —
  // falls back to options.config for a root story or when resolution failed.
  const widenedConfig = (packageEffectiveConfig ?? options.config) as
    | {
        quality?: { commands?: Partial<Record<string, QualityCommandSpec>>; stripEnvVars?: unknown; shell?: unknown };
        // AgentManagerConfig (agentManagerConfigSelector) only picks
        // agent/execution/profile, so `install` is not in its type even
        // though both hops source this from the full NaxConfig at runtime
        // (see RULING F2 above). Widen locally rather than broaden the
        // shared selector.
        install?: { allowScripts?: boolean };
      }
    | undefined;
  const quality = widenedConfig?.quality;
  const commands = quality?.commands ?? {};
  const stripEnvVars = Array.isArray(quality?.stripEnvVars)
    ? quality.stripEnvVars.filter((value): value is string => typeof value === "string")
    : [];
  const shell = typeof quality?.shell === "string" ? quality.shell : undefined;
  const allowScripts = widenedConfig?.install?.allowScripts ?? false;
  // Same package-first fallback as widenedConfig above — a package can
  // override execution.denyPaths too.
  const denyPaths = (packageEffectiveConfig ?? options.config)?.execution?.denyPaths;
  const declaredCommands = new Map(
    Object.entries(commands).filter(
      (e): e is [string, QualityCommandSpec] => typeof e[1] === "string" || Array.isArray(e[1]),
    ),
  );
  // nax#2066: the declared-command map came from the ROOT config for a package
  // story, and nothing in the run artifacts said so — it took a transcript audit
  // to find. Name what the agent was actually given, once per dispatch.
  getSafeLogger()?.debug("tools", "Declared commands resolved for dispatch", {
    storyId: options.storyId ?? "_dispatch",
    commands: [...declaredCommands.keys()],
    permissionProfile: options.config?.execution?.permissionProfile ?? "unrestricted",
    codingToolRoot: options.codingToolRoot,
  });
  const root = options.codingToolRoot;
  // Independent of `root`: PR2 repoints `codingToolRoot` at the story's
  // execution root, so declared commands must resolve their cwd from the
  // story's own relative package dir + the (stable) project root rather
  // than from whatever `root` means at dispatch time. Falls back to `root`
  // when either input is unavailable (legacy callers, or a single-package
  // repo where the two already coincide).
  const commandCwd =
    projectDir !== undefined && projectDir.trim() !== ""
      ? packageWorkdir({ packageDir: packageDir ?? "", repoRoot: projectDir })
      : root;
  const auditDir =
    root !== undefined && root.trim() !== ""
      ? toolAuditDir(
          { root, ...(options.outputDir !== undefined ? { outputDir: options.outputDir } : {}) },
          options.featureName,
        )
      : undefined;
  const sessionName = buildLedgerSessionName({
    ...(options.storyId !== undefined ? { storyId: options.storyId } : {}),
    ...(options.sessionRole !== undefined ? { sessionRole: options.sessionRole } : {}),
    ...(options.featureName !== undefined ? { featureName: options.featureName } : {}),
  });
  // Resolved here, ahead of the sync tool seam (buildCodingToolSupport):
  // both dispatch hops call that seam on a hot path, so it stays synchronous
  // and never touches the filesystem itself. Skipped unless the op declared
  // Exec — no reason to read a manifest off disk on every dispatch when
  // nothing downstream will use the result.
  //
  // The manifest is read from the STORY'S PACKAGE dir (`commandCwd`), never
  // from `root`: post-PR2 `root` is `storyExecRoot` (the repo root), so
  // resolving there would scope cargo/uv/yarn workspace installs with the
  // root manifest's name — or deny outright for a virtual Cargo workspace.
  // `commandCwd` is absolute and worktree-aware, and falls back to `root`
  // when no package/project dir was supplied.
  const packageName =
    root !== undefined && root.trim() !== "" && declared.includes(EXEC_TOOL_NAME)
      ? await resolvePackageName(commandCwd ?? root)
      : undefined;
  // Provider tools bypass the DECLARATION half of advertisement (spec R4):
  // operation declarations live in code, so requiring a code edit to use a
  // configured provider would defeat config-only onboarding. `advertised()`
  // itself is unchanged — the names are appended to `declared` here.
  //
  // The profile is the OTHER half, and it is not bypassed (R12): `scoped`
  // admits exactly what the stage's `Mcp(...)` rules name — evaluated before a
  // tool is adapted, so an unadmitted tool still contributes no tool, grant or
  // map entry — while `safe` continues to contribute nothing at all and
  // `unrestricted` keeps every attached provider. An empty/absent root already
  // throws in buildCodingToolSupport, so skipping resolution there is correct;
  // it also keeps a possibly-undefined root out of resolveProviderTools.
  //
  // Mcp(...) is surface syntax: partition it out BEFORE anything compiles a
  // policy. A surviving {tool:"Mcp"} grant keys the compiled map on "Mcp",
  // matches no advertised name and denies every call while every parser test
  // stays green (provider-tools R3).
  const allow = partitionMcpRules(resolved.toolGrants ?? []);
  const denied = partitionMcpRules(resolved.denyRules ?? []);
  const asked = partitionMcpRules(resolved.askRules ?? []);

  // The root test is written inline rather than hoisted to a `hasRoot` boolean
  // so TypeScript narrows `root` inside the branch — a hoisted flag would force
  // an `as string` cast on a value the condition already proved.
  const providerScope = resolved.providerScope ?? "none";
  const providerResult: ResolvedProviderTools =
    providerScope !== "none" && root !== undefined && root.trim() !== ""
      ? await resolveProviderTools(options.providers ?? [], options.pipelineStage ?? "run", root, {
          // "all" keeps today's behaviour; "rules" admits only what the stage's
          // Mcp rules name, evaluated before a tool is ever adapted.
          ...(providerScope === "rules"
            ? {
                admits: (providerId: string, localName: string) =>
                  mcpRuleAdmits(allow.mcpPatterns, providerId, localName),
              }
            : {}),
        })
      : {
          tools: [],
          grants: [],
          failures: [] as readonly { providerId: string; reason: string }[],
          providerIdByTool: new Map<string, string>(),
          entries: [],
        };
  const declaredWithProviders = [...declared, ...providerResult.tools.map((t) => t.name)] as readonly CodingToolName[];
  // Logged before the empty-union return: a provider-only op whose only
  // provider failed must still say so, not vanish silently. A no-op when
  // providers were gated off (R12) and `failures` is empty.
  for (const failure of providerResult.failures) {
    getSafeLogger()?.warn("tools", "[provider] dropped", {
      storyId: options.storyId,
      providerId: failure.providerId,
      reason: failure.reason,
    });
  }
  // Resolved BEFORE this guard (R15): a provider-only op declares no built-in
  // names, yet appending the provider names above is exactly what makes it a
  // real op. An empty union is the only case that yields no support.
  if (declaredWithProviders.length === 0) return undefined;
  // Deny and ask bind under EVERY profile (spec R10), so Mcp deny/ask rules are
  // expanded even when providerScope is "all" — a deny must be able to withdraw
  // one tool from an otherwise fully-granted provider.
  const denyRules = [...denied.grants, ...expandMcpRuleGrants(denied.mcpPatterns, providerResult.entries)];
  const askRules = [...asked.grants, ...expandMcpRuleGrants(asked.mcpPatterns, providerResult.entries)];
  return buildCodingToolSupport({
    root: options.codingToolRoot,
    pipelineStage: options.pipelineStage ?? "run",
    // No `repoRoot`: post single-frame redesign (PR2) it equals `root`, so
    // buildCodingToolSupport's `args.repoRoot ?? args.root` fallback supplies it.
    // Task 10: Exec's package target needs the story's ABSOLUTE package dir.
    // `codingToolPackageDir` is RELATIVE to projectDir (and worktree-prefixed
    // in production), while Exec compares it against an absolute repoRoot —
    // passing it raw would produce garbage. `commandCwd` is the same value
    // already computed above via packageWorkdir({ packageDir, repoRoot:
    // projectDir }): absolute and worktree-aware. Omitted when either input is
    // unavailable, so buildCodingToolSupport falls back to `root` (correct for
    // a single-package repo, where the two coincide).
    ...(packageDir !== undefined &&
    packageDir.trim() !== "" &&
    packageDir !== "." &&
    projectDir !== undefined &&
    projectDir.trim() !== ""
      ? { packageWorkdir: commandCwd }
      : {}),
    commandCwd,
    grants: [...allow.grants, ...providerResult.grants],
    declared: declaredWithProviders,
    extraTools: providerResult.tools,
    providerIdByTool: providerResult.providerIdByTool,
    ...(options.toolPatterns !== undefined ? { toolPatterns: options.toolPatterns } : {}),
    ...(denyRules.length > 0 ? { denyRules } : {}),
    ...(askRules.length > 0 ? { askRules } : {}),
    ...(options.storyId !== undefined ? { storyId: options.storyId } : {}),
    declaredCommands,
    stripEnvVars,
    ...(shell !== undefined ? { shell } : {}),
    ...(auditDir !== undefined ? { auditDir } : {}),
    sessionName,
    ...(packageName !== undefined ? { packageName } : {}),
    allowScripts,
    ...(denyPaths !== undefined ? { denyPaths } : {}),
    ...(options.codingToolFileOutput !== undefined ? { fileOutputPath: options.codingToolFileOutput } : {}),
  });
}
