/**
 * The config fields one coding-tool dispatch reads, and the declared-command
 * runner bound to the dispatch's timeout. Split from
 * `coding-tool-support-resolve.ts`, which resolves the package-first config
 * these are read from.
 */
import type { DeclaredCommandRequest, DeclaredCommandResult, DeclaredCommandRunner } from "@nathapp/nax-agent";
import { type FullSuiteTimeoutConfig, type QualityCommandSpec, resolveFullSuiteTimeoutSeconds } from "../quality";

const MS_PER_SECOND = 1_000;

/**
 * The declared commands that run the test suite (the keys
 * `resolveQualityTestCommands` reads, plus coverage). Only these get the
 * full-suite budget; lint/typecheck keep the runner default, matching the
 * harness's own lint/typecheck gates, so a hung watcher still dies quickly.
 */
const SUITE_COMMAND_NAMES: ReadonlySet<string> = new Set(["test", "testScoped", "coverage"]);

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
  execution?: { denyPaths?: readonly string[] } & FullSuiteTimeoutConfig["execution"];
}

/** The quality/install/execution fields the dispatch needs, package-config first. */
export interface DispatchConfigFields {
  commands: Partial<Record<string, QualityCommandSpec>>;
  stripEnvVars: string[];
  shell: string | undefined;
  allowScripts: boolean;
  denyPaths: readonly string[] | undefined;
  /** Hard timeout for a suite-running declared command the agent runs: the full-suite gate's (#2536). */
  suiteCommandTimeoutMs: number;
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
    suiteCommandTimeoutMs: resolveFullSuiteTimeoutSeconds(config) * MS_PER_SECOND,
  };
}

/** nax's runner: the port's request plus the hard timeout nax-agent does not know about. */
export type TimedDeclaredCommandRunner = (
  request: DeclaredCommandRequest & { readonly timeoutMs?: number },
) => Promise<DeclaredCommandResult>;

/**
 * Bind the suite timeout on nax's side of the port, so `nax-agent` needs no
 * API change. Without it the agent's test run fell back to the runner's 120s
 * default, below the full-suite gate's own budget (#2536).
 */
export function withSuiteCommandTimeout(runner: TimedDeclaredCommandRunner, timeoutMs: number): DeclaredCommandRunner {
  return (request) =>
    SUITE_COMMAND_NAMES.has(request.commandName) ? runner({ ...request, timeoutMs }) : runner(request);
}
