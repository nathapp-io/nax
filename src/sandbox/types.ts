/**
 * Types for the OS sandbox around agent-authored commands (P4).
 *
 * Every path in a SandboxPolicy is absolute, literal and realpath-resolved:
 * srt on Linux silently DROPS any denyWrite entry containing a glob
 * (spec F1), and resolves only paths that already exist (spec 12, finding 3).
 */
import type { ArgvExecResult } from "../utils/argv-exec";

export type SandboxBackendName = "srt";

export interface SandboxNetworkPolicy {
  /** Absent = unrestricted. */
  readonly allowedDomains?: readonly string[];
}

export interface SandboxPolicy {
  readonly writeRoots: readonly string[];
  readonly denyWrite: readonly string[];
  readonly denyRead: readonly string[];
  readonly network: SandboxNetworkPolicy;
}

export type ProbeResult = { readonly available: true } | { readonly available: false; readonly reason: string };

export interface SandboxWrapRequest {
  readonly command: string;
  readonly shell: string;
  readonly policy: SandboxPolicy;
  readonly cwd: string;
  readonly commandId: string;
}

export interface SandboxBackend {
  readonly name: SandboxBackendName;
  isSupportedPlatform(): Promise<boolean>;
  /** Argv ONLY. The backend's env never crosses this boundary (spec F6). */
  wrap(req: SandboxWrapRequest): Promise<readonly string[]>;
  /** Extra violation text for this command, or "" when there is none. */
  annotate(commandId: string, stderr: string): string;
  /** Called once per finished wrapped command (in-flight bookkeeping). */
  commandFinished(): void;
  reset(): Promise<void>;
}

export type SandboxState =
  | { readonly kind: "disabled" }
  | { readonly kind: "available"; readonly backend: SandboxBackendName; readonly network: "open" | readonly string[] }
  | { readonly kind: "unavailable"; readonly backend: SandboxBackendName; readonly reason: string };

export interface SandboxRecord {
  readonly backend: SandboxBackendName | "none";
  readonly wrapped: boolean;
  readonly reason?: string;
  readonly denialHint?: true;
}

export type LaunchSpec =
  | { readonly kind: "shell"; readonly shell: string; readonly command: string }
  | { readonly kind: "argv"; readonly argv: readonly string[] };

export interface LaunchRequest {
  readonly spec: LaunchSpec;
  /** The policy root (`ctx.root`); write roots derive from it. */
  readonly root: string;
  /** Where the command starts; the PACKAGE dir for an Exec `target: "package"` call. */
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly stripEnvVars: readonly string[];
  /** The CALLER's own overlay (Exec's Yarn no-scripts env). Never the backend's. */
  readonly env?: Readonly<Record<string, string>>;
  /** Aborts the run: forwarded to runArgv, which SIGKILLs the process group. US-001. */
  readonly signal?: AbortSignal;
}

export interface LaunchResult extends ArgvExecResult {
  /** The logical argv (what the tool asked to run), not the sandbox wrapper argv. */
  readonly executed: readonly string[];
  readonly sandbox: SandboxRecord;
}

export interface CommandLauncher {
  readonly state: SandboxState;
  run(req: LaunchRequest): Promise<LaunchResult>;
}
