/**
 * `resolveCodingToolSupport`'s decision tree, extracted from
 * coding-tool-support.ts (A7 cognitive-complexity drain).
 *
 * `resolveCodingToolSupport` is the sequencer, defined last in this file: guard
 * clauses first, then the support-args assembly.
 *
 * Import direction: this file is nax's side of the coding-tool seam (S1 spec
 * section 4.2, port 1). It owns `resolveCodingToolSupport`, which reads nax
 * config and supplies every nax-owned port, and calls the move set's
 * `buildCodingToolSupport` with resolved arguments only. The move set never
 * imports this file.
 */

import {
  BASH_TOOL_NAME,
  type CodingToolName,
  type CommandLauncher,
  type DeclaredCommandRunner,
  EXEC_TOOL_NAME,
  expandMcpRuleGrants,
  mcpRuleAdmits,
  type ProtectedPathsPolicy,
  partitionMcpRules,
  type ResolvedProviderTools,
  resolveProviderTools,
  runTmpRoot,
  sessionTmpDirUnder,
  type ToolGrant,
} from "@nathapp/nax-agent";
import {
  buildCodingToolSupport,
  buildLedgerSessionName,
  type CodingToolSupport,
  errorMessage,
  naxOwnedPathsPolicy,
  type OwnedPathsPolicy,
  resolveSessionSandbox,
  type ToolAuditHeader,
  UNIVERSAL_CODING_TOOLS,
} from "@nathapp/nax-agent/internal";
import { getSafeLogger } from "@/logger";
import { loadConfigForPackage, type NaxConfig } from "../config";
import { toolAuditDir } from "../config/paths";
import { type ResolvedPermissions, resolvePermissions } from "../config/permissions";
import { type QualityCommandSpec, runQualityCommand } from "../quality";
import { packageOverrideKey, packageWorkdir } from "../runtime/packages";
import { resolvePackageName } from "./exec-package-name";
import { naxProtectedPaths } from "./nax-protected-paths";
import type { AgentRunOptions } from "./types";

/** The dispatch options `resolveCodingToolSupport` reads — its exact signature. */
export type ResolveCodingToolSupportOptions = Pick<
  AgentRunOptions,
  | "declaredTools"
  | "providers"
  | "commandInterceptor"
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
  | "runId"
  | "callId"
  | "scopeId"
  | "askResolver"
  | "commandShadow"
  | "abortSignal"
>;

/** The args literal `resolveCodingToolSupport` ends up calling the sync seam with. */
type ResolveSupportArgs = Parameters<typeof buildCodingToolSupport>[0];

/**
 * RULING F2: AgentRunOptions['config'] is typed as the agent-manager Pick
 * (agent/execution/profile), yet both hops source it from configLoader.current(),
 * so it carries the full NaxConfig at runtime — only the type lies. The read is
 * widened locally here; the shared agentManagerConfigSelector stays untouched.
 * (AgentManagerConfig is a Pick without quality/install, but every member here
 * is optional, so both shapes are assignable without a cast.)
 */
export interface WidenedDispatchConfig {
  quality?: {
    commands?: Partial<Record<string, QualityCommandSpec>>;
    stripEnvVars?: unknown;
    shell?: unknown;
  };
  install?: { allowScripts?: boolean };
  execution?: { denyPaths?: readonly string[] };
}

/** The quality/install/execution fields the dispatch needs, package-config first. */
export interface DispatchConfigFields {
  commands: Partial<Record<string, QualityCommandSpec>>;
  stripEnvVars: string[];
  shell: string | undefined;
  allowScripts: boolean;
  denyPaths: readonly string[] | undefined;
}

/** The MCP rule partitions plus the provider tools resolved against them. */
export interface ProviderContribution {
  allow: ReturnType<typeof partitionMcpRules>;
  denied: ReturnType<typeof partitionMcpRules>;
  asked: ReturnType<typeof partitionMcpRules>;
  providerResult: ResolvedProviderTools;
}

/** The resolved pieces the conditional half of the support args needs. */
export interface ResolvedDispatchInputs {
  packageDir: string | undefined;
  projectDir: string | undefined;
  commandCwd: string | undefined;
  denyRules: readonly ToolGrant[];
  askRules: readonly ToolGrant[];
  denyPaths: readonly string[] | undefined;
  shell: string | undefined;
  auditDir: string | undefined;
  packageName: string | undefined;
  launcher: CommandLauncher | undefined;
}

/**
 * A package dir resolves a per-package config only when BOTH the story's
 * (relative, possibly worktree-prefixed) package dir and the project root are
 * usable: ""/"/." package dirs and a missing project root all fall back to the
 * dispatch's own config.
 */
export function hasUsablePackageDir(packageDir: string | undefined, projectDir: string | undefined): boolean {
  return usablePackageDirs(packageDir, projectDir) !== undefined;
}

/** `hasUsablePackageDir`'s rule, returning both dirs narrowed to `string` when it holds. */
function usablePackageDirs(
  packageDir: string | undefined,
  projectDir: string | undefined,
): { packageDir: string; projectDir: string } | undefined {
  if (packageDir === undefined || packageDir.trim() === "" || packageDir === ".") return undefined;
  if (projectDir === undefined || projectDir.trim() === "") return undefined;
  return { packageDir, projectDir };
}

/**
 * PR1 (single-frame redesign, #2066 residual): resolve the declared-command
 * map (and the quality-derived fields around it) from the STORY'S PACKAGE
 * config when one is known, not the config this dispatch happened to be
 * threaded with. loadConfigForPackage is the R4-mandated resolver — never
 * loadConfigForWorkdir directly, never packageView.config
 * (packages.resolve() misses under worktree/parallel isolation, #2069);
 * its required `from` carries the --profile chain (#2126/#2127). Cheap on
 * a hit: loadConfigForWorkdir's own packageConfigCache
 * (rootConfigPath, packageDir, profileKey) serves every dispatch after the
 * first for the same package/profile.
 */
export async function loadPackageEffectiveConfig(
  deps: { loadConfigForPackage: typeof loadConfigForPackage },
  options: ResolveCodingToolSupportOptions,
): Promise<NaxConfig | undefined> {
  const dirs = usablePackageDirs(options.codingToolPackageDir, options.projectDir);
  if (dirs === undefined || options.config === undefined) return undefined;
  const { packageDir, projectDir } = dirs;
  try {
    return await deps.loadConfigForPackage(
      projectDir,
      // Under storyIsolation "worktree" the package dir is prefixed with
      // `.nax-wt/<storyId>/`, which never matches the plain `<pkg>` keys the
      // per-package override lookup stored — normalize for the LOOKUP ONLY.
      // commandCwd below keeps the RAW dir so the command runs in the story's
      // worktree (see packageOverrideKey in src/runtime/packages.ts).
      packageOverrideKey(packageDir),
      // RULING F2 (see WidenedDispatchConfig): options.config's declared type is
      // a Pick, but at runtime both hops source it from the full NaxConfig.
      options.config as unknown as NaxConfig,
    );
  } catch (err) {
    getSafeLogger()?.warn("tools", "Per-package config failed to load for dispatch — using root config", {
      storyId: options.storyId ?? "_dispatch",
      packageDir,
      error: errorMessage(err),
    });
    return undefined;
  }
}

export function extractDispatchConfigFields(config: WidenedDispatchConfig | undefined): DispatchConfigFields {
  const quality = config?.quality;
  return {
    commands: quality?.commands ?? {},
    stripEnvVars: Array.isArray(quality?.stripEnvVars)
      ? quality.stripEnvVars.filter((value): value is string => typeof value === "string")
      : [],
    shell: typeof quality?.shell === "string" ? quality.shell : undefined,
    allowScripts: config?.install?.allowScripts ?? false,
    // Same package-first fallback as the config itself — a package can
    // override execution.denyPaths too.
    denyPaths: config?.execution?.denyPaths,
  };
}

export function declaredCommandsFrom(
  commands: Partial<Record<string, QualityCommandSpec>>,
): Map<string, QualityCommandSpec> {
  return new Map(
    Object.entries(commands).filter(
      (e): e is [string, QualityCommandSpec] => typeof e[1] === "string" || Array.isArray(e[1]),
    ),
  );
}

/**
 * Declared commands resolve their cwd from the story's own relative package
 * dir + the (stable) project root rather than from whatever `root` means at
 * dispatch time — PR2 repoints `codingToolRoot` at the story's execution root.
 * Falls back to `root` when either input is unavailable (legacy callers, or a
 * single-package repo where the two already coincide).
 */
export function resolveCommandCwd(
  packageDir: string | undefined,
  projectDir: string | undefined,
  root: string | undefined,
): string | undefined {
  return projectDir !== undefined && projectDir.trim() !== ""
    ? packageWorkdir({ packageDir: packageDir ?? "", repoRoot: projectDir })
    : root;
}

export function resolveDispatchAuditDir(
  root: string | undefined,
  outputDir: string | undefined,
  featureName: string | undefined,
): string | undefined {
  return root !== undefined && root.trim() !== ""
    ? toolAuditDir({ root, ...(outputDir !== undefined ? { outputDir } : {}) }, featureName)
    : undefined;
}

/** The run-scoped tool-audit ledger header, present-field only. */
export function buildLedgerHeader(options: ResolveCodingToolSupportOptions): ToolAuditHeader {
  return {
    ...(options.runId !== undefined ? { runId: options.runId } : {}),
    ...(options.featureName !== undefined ? { featureName: options.featureName } : {}),
    ...(options.storyId !== undefined ? { storyId: options.storyId } : {}),
    ...(options.sessionRole !== undefined ? { sessionRole: options.sessionRole } : {}),
  };
}

/**
 * Resolved ahead of the sync tool seam (buildCodingToolSupport):
 * both dispatch hops call that seam on a hot path, so it stays synchronous
 * and never touches the filesystem itself. Skipped unless the op declared
 * Exec — no reason to read a manifest off disk on every dispatch when
 * nothing downstream will use the result.
 *
 * The manifest is read from the STORY'S PACKAGE dir (`commandCwd`), never
 * from `root`: post-PR2 `root` is `storyExecRoot` (the repo root), so
 * resolving there would scope cargo/uv/yarn workspace installs with the
 * root manifest's name — or deny outright for a virtual Cargo workspace.
 * `commandCwd` is absolute and worktree-aware, and falls back to `root`
 * when no package/project dir was supplied.
 */
export async function resolvePackageNameForDispatch(
  root: string | undefined,
  declared: readonly CodingToolName[],
  commandCwd: string | undefined,
): Promise<string | undefined> {
  return root !== undefined && root.trim() !== "" && declared.includes(EXEC_TOOL_NAME)
    ? await resolvePackageName(commandCwd ?? root)
    : undefined;
}

/**
 * Provider tools bypass the DECLARATION half of advertisement (spec R4):
 * operation declarations live in code, so requiring a code edit to use a
 * configured provider would defeat config-only onboarding. `advertised()`
 * itself is unchanged — the names are appended to `declared` by
 * `unionDeclaredTools`.
 *
 * The profile is the OTHER half, and it is not bypassed (R12): `scoped`
 * admits exactly what the stage's `Mcp(...)` rules name — evaluated before a
 * tool is adapted, so an unadmitted tool still contributes no tool, grant or
 * map entry — while `safe` continues to contribute nothing at all and
 * `unrestricted` keeps every attached provider. An empty/absent root already
 * throws in buildCodingToolSupport, so skipping resolution there is correct;
 * it also keeps a possibly-undefined root out of resolveProviderTools.
 *
 * Mcp(...) is surface syntax: partition it out BEFORE anything compiles a
 * policy. A surviving {tool:"Mcp"} grant keys the compiled map on "Mcp",
 * matches no advertised name and denies every call while every parser test
 * stays green (provider-tools R3).
 */
export async function resolveProviderContribution(
  resolved: ResolvedPermissions,
  options: ResolveCodingToolSupportOptions,
  root: string | undefined,
): Promise<ProviderContribution> {
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
  return { allow, denied, asked, providerResult };
}

/**
 * The scratchpad tools are the universal layer every op receives. The
 * append only fires when the op declared any built-in names OR a provider
 * contributed names — an op that declared nothing and has no providers is
 * a no-op hop that should NOT receive coding-tool support (it would force
 * `buildCodingToolSupport` to throw CODING_TOOL_ROOT_MISSING when the
 * caller has no root to give it, which breaks the dispatch shape these
 * tests pin). Filtered against `declared` because an op that omits `tools`
 * resolves to DEFAULT_CODING_TOOLS, which already carries all three.
 */
export function unionDeclaredTools(
  declared: readonly CodingToolName[],
  providerResult: ResolvedProviderTools,
): readonly CodingToolName[] {
  const universalTools = UNIVERSAL_CODING_TOOLS.filter((name) => !declared.includes(name));
  return [
    ...declared,
    ...providerResult.tools.map((t) => t.name),
    ...(declared.length > 0 || providerResult.tools.length > 0 ? universalTools : []),
  ] as readonly CodingToolName[];
}

/**
 * Logged before the empty-union return: a provider-only op whose only
 * provider failed must still say so, not vanish silently. A no-op when
 * providers were gated off (R12) and `failures` is empty.
 */
export function warnDroppedProviders(providerResult: ResolvedProviderTools, storyId: string | undefined): void {
  for (const failure of providerResult.failures) {
    getSafeLogger()?.warn("tools", "[provider] dropped", {
      storyId,
      providerId: failure.providerId,
      reason: failure.reason,
    });
  }
}

/**
 * P4: the probe is async, so it runs here as data; execution.sandbox is
 * root-scoped (ADR-031).
 */
export async function resolveDispatchLauncher(
  options: ResolveCodingToolSupportOptions,
  declared: readonly CodingToolName[],
  sessionName: string,
): Promise<CommandLauncher | undefined> {
  if (options.codingToolRoot === undefined || options.codingToolRoot.trim() === "") return undefined;
  // One parent resolution feeds both the policy root and the session TMPDIR:
  // `runTmpRoot` re-resolves on every call with no cache, so two independent
  // calls could observe a host flip and split the pair the sandbox trusts.
  const runRoot = options.runId !== undefined ? runTmpRoot(options.runId) : undefined;
  return await resolveSessionSandbox({
    config: options.config?.execution?.sandbox,
    root: options.codingToolRoot,
    ...(options.outputDir !== undefined ? { outputDir: options.outputDir } : {}),
    needsLauncher: declared.includes(BASH_TOOL_NAME) || declared.includes(EXEC_TOOL_NAME),
    ...(options.storyId !== undefined ? { storyId: options.storyId } : {}),
    ...(runRoot !== undefined ? { tmpDir: sessionTmpDirUnder(runRoot, sessionName), runTmpRoot: runRoot } : {}),
    protectedPaths: _codingToolSupportDeps.protectedPaths(),
    ownedPaths: _codingToolSupportDeps.ownedPaths,
  });
}

/** The option-forwarding conditional spreads, unchanged in key and shape. */
export function optionalDispatchArgs(options: ResolveCodingToolSupportOptions): Partial<ResolveSupportArgs> {
  return {
    ...(options.toolPatterns !== undefined ? { toolPatterns: options.toolPatterns } : {}),
    ...(options.storyId !== undefined ? { storyId: options.storyId } : {}),
    ...(options.callId !== undefined ? { callId: options.callId } : {}),
    ...(options.scopeId !== undefined ? { scopeId: options.scopeId } : {}),
    ...(options.codingToolFileOutput !== undefined ? { fileOutputPath: options.codingToolFileOutput } : {}),
    ...(options.askResolver !== undefined ? { askResolver: options.askResolver } : {}),
    ...(options.commandShadow !== undefined ? { commandShadow: options.commandShadow } : {}),
    ...(options.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
  };
}

/** The conditional spreads over pieces resolved earlier in the sequence. */
export function resolvedDispatchArgs(inputs: ResolvedDispatchInputs): Partial<ResolveSupportArgs> {
  return {
    // Task 10: Exec's package target needs the story's ABSOLUTE package dir.
    // `codingToolPackageDir` is RELATIVE to projectDir (and worktree-prefixed
    // in production), while Exec compares it against an absolute repoRoot —
    // passing it raw would produce garbage. `commandCwd` is the same value
    // already computed for the dispatch via packageWorkdir({ packageDir,
    // repoRoot: projectDir }): absolute and worktree-aware. Omitted when
    // either input is unavailable, so buildCodingToolSupport falls back to
    // `root` (correct for a single-package repo, where the two coincide).
    ...(hasUsablePackageDir(inputs.packageDir, inputs.projectDir) ? { packageWorkdir: inputs.commandCwd } : {}),
    ...(inputs.denyRules.length > 0 ? { denyRules: inputs.denyRules } : {}),
    ...(inputs.askRules.length > 0 ? { askRules: inputs.askRules } : {}),
    ...(inputs.denyPaths !== undefined ? { denyPaths: inputs.denyPaths } : {}),
    ...(inputs.shell !== undefined ? { shell: inputs.shell } : {}),
    ...(inputs.auditDir !== undefined ? { auditDir: inputs.auditDir } : {}),
    ...(inputs.packageName !== undefined ? { packageName: inputs.packageName } : {}),
    ...(inputs.launcher !== undefined ? { launcher: inputs.launcher } : {}),
  };
}

/** Injectable deps for testability — mirrors the _agentManagerDeps pattern. Each nax-owned port has its default here. */
export const _codingToolSupportDeps: {
  loadConfigForPackage: typeof loadConfigForPackage;
  /** Port 7: the declared-command runner RunCommand calls. */
  runDeclaredCommand: DeclaredCommandRunner;
  /** Port 6: the host-owned paths the tools and the sandbox protect. */
  protectedPaths: () => ProtectedPathsPolicy;
  /** S3-2 port: the paths nax owns the writes to; injected into the tools (and, from Task 4, the sandbox). */
  ownedPaths: OwnedPathsPolicy;
} = {
  loadConfigForPackage,
  runDeclaredCommand: runQualityCommand,
  protectedPaths: naxProtectedPaths,
  ownedPaths: naxOwnedPathsPolicy,
};

/**
 * Resolve coding-tool support for one dispatch, from the run options alone.
 *
 * nax-permission-mode-allow: delegates the decision to resolvePermissions();
 * decides nothing itself.
 *
 * Exists so the two real hops (`operations/build-hop-callback.ts`,
 * `runtime/session-run-hop.ts`) resolve support identically and cannot drift:
 * a tool wired into one hop and not the other is invisible until an operation
 * happens to dispatch through the other. Call this, never the raw producer in
 * `coding-tool-support.ts` — it takes no `auditDir`, so it yields a
 * non-recording ledger sink.
 */
export async function resolveCodingToolSupport(
  options: ResolveCodingToolSupportOptions,
): Promise<CodingToolSupport | undefined> {
  const declared = options.declaredTools ?? [];
  const resolved = resolvePermissions(options.config, options.pipelineStage ?? "run");
  // PR1 (single-frame redesign, #2066 residual): the declared-command map and
  // the quality-derived fields around it resolve from the STORY'S PACKAGE
  // config when one is known — see loadPackageEffectiveConfig.
  const packageEffectiveConfig = await loadPackageEffectiveConfig(_codingToolSupportDeps, options);
  // RULING F2: options.config is typed as the agent-manager Pick, yet carries
  // the full NaxConfig at runtime — the read is widened inside
  // extractDispatchConfigFields. Package-first: a per-package
  // quality.commands/install/execution override is honored; options.config
  // covers a root story or a failed resolution.
  const fields = extractDispatchConfigFields(packageEffectiveConfig ?? options.config);
  const declaredCommands = declaredCommandsFrom(fields.commands);
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
  const commandCwd = resolveCommandCwd(options.codingToolPackageDir, options.projectDir, root);
  const auditDir = resolveDispatchAuditDir(root, options.outputDir, options.featureName);
  const sessionName = buildLedgerSessionName({
    ...(options.storyId !== undefined ? { storyId: options.storyId } : {}),
    ...(options.sessionRole !== undefined ? { sessionRole: options.sessionRole } : {}),
    ...(options.featureName !== undefined ? { featureName: options.featureName } : {}),
  });
  const header = buildLedgerHeader(options);
  const packageName = await resolvePackageNameForDispatch(root, declared, commandCwd);
  const { allow, denied, asked, providerResult } = await resolveProviderContribution(resolved, options, root);
  const declaredWithProviders = unionDeclaredTools(declared, providerResult);
  warnDroppedProviders(providerResult, options.storyId);
  // Resolved BEFORE this guard (R15): a provider-only op declares no built-in
  // names, yet appending the provider names above is exactly what makes it a
  // real op. An empty union is the only case that yields no support.
  if (declaredWithProviders.length === 0) return undefined;
  // Deny and ask bind under EVERY profile (spec R10), so Mcp deny/ask rules are
  // expanded even when providerScope is "all" — a deny must be able to withdraw
  // one tool from an otherwise fully-granted provider.
  const denyRules = [...denied.grants, ...expandMcpRuleGrants(denied.mcpPatterns, providerResult.entries)];
  const askRules = [...asked.grants, ...expandMcpRuleGrants(asked.mcpPatterns, providerResult.entries)];
  const launcher = await resolveDispatchLauncher(options, declared, sessionName);
  return buildCodingToolSupport({
    root: options.codingToolRoot,
    pipelineStage: options.pipelineStage ?? "run",
    // No `repoRoot`: post single-frame redesign (PR2) it equals `root`, so
    // buildCodingToolSupport's `args.repoRoot ?? args.root` fallback supplies it.
    commandCwd,
    grants: [...allow.grants, ...providerResult.grants],
    bashApproval: resolved.bashApproval,
    declared: declaredWithProviders,
    extraTools: providerResult.tools,
    providerIdByTool: providerResult.providerIdByTool,
    declaredCommands,
    runDeclaredCommand: _codingToolSupportDeps.runDeclaredCommand,
    interceptor: options.commandInterceptor,
    protectedPaths: _codingToolSupportDeps.protectedPaths(),
    ownedPaths: _codingToolSupportDeps.ownedPaths,
    stripEnvVars: fields.stripEnvVars,
    sessionName,
    header,
    allowScripts: fields.allowScripts,
    naxAllowWrite: options.config?.execution?.sandbox?.filesystem.allowWrite ?? [],
    ...optionalDispatchArgs(options),
    ...resolvedDispatchArgs({
      packageDir: options.codingToolPackageDir,
      projectDir: options.projectDir,
      commandCwd,
      denyRules,
      askRules,
      denyPaths: fields.denyPaths,
      shell: fields.shell,
      auditDir,
      packageName,
      launcher,
    }),
  });
}
