/**
 * Spawning an ACP agent (S4 spec §6.1 launch). The agent is a process-group
 * leader, so a kill reaches its children (npx, node, the adapter's own tools).
 * Its stdio becomes an ndjson ACP stream and its stderr feeds a bounded tail.
 * A spawn failure is never thrown: `exited` resolves with spawnError. Pipe
 * errors (EPIPE after the agent died) are absorbed so they cannot crash the host.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { type AgentApp, type AnyMessage, ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import { type AgentSessionError, createStderrTail, killProcessGroup, type StderrTail } from "@nathapp/nax-agent";
import { agentTextExcerpt, backendUnavailable, EXCERPT_BYTES } from "#src/client/errors";
import { race } from "#src/client/race";
import type { LaunchCandidate } from "#src/client/registry";

/** How long a transport failure waits for the exit status. */
const GONE_WAIT_MS = 1_000;
/** How long, after the exit, the last stderr may take to arrive. */
const STDERR_DRAIN_MS = 200;

export type LaunchTarget =
  | { readonly kind: "stream"; readonly stream: Stream }
  /** An in-process agent: the unit suite's fake (D-k). */
  | { readonly kind: "app"; readonly agent: AgentApp };

export interface AgentExit {
  readonly code: number | null;
  readonly signal: string | null;
  /** Set when the process never started (for example ENOENT). */
  readonly spawnError?: string;
}

export interface LaunchedAgent {
  readonly target: LaunchTarget;
  readonly pid: number | undefined;
  readonly stderr: StderrTail;
  /** Resolves once, when the process is gone. Never rejects. */
  readonly exited: Promise<AgentExit>;
  /** The exit once the process has exited (and its stderr drained), or undefined after `waitMs`. */
  whenGone(waitMs: number): Promise<AgentExit | undefined>;
  /** Closes stdin, SIGTERMs the group, SIGKILLs it after `graceMs`; resolves once exited. */
  terminate(graceMs: number): Promise<void>;
  /** SIGKILLs the group now. */
  kill(): void;
}

export interface LaunchRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** The SDK default when absent. */
  readonly maxMessageBytes?: number;
}

export type LaunchFn = (request: LaunchRequest) => LaunchedAgent;

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** True when `command` is an absolute executable path, or a bare name found on `pathVar`. */
export function findExecutable(command: string, pathVar: string | undefined): boolean {
  if (command.includes("/")) return isAbsolute(command) && isExecutableFile(command);
  return (pathVar ?? "").split(delimiter).some((dir) => dir !== "" && isExecutableFile(join(dir, command)));
}

/** The first candidate whose command is found (§6.10: tried in order). */
export function pickCandidate(
  candidates: readonly LaunchCandidate[],
  pathVar: string | undefined,
): LaunchCandidate | undefined {
  return candidates.find((candidate) => findExecutable(candidate.command, pathVar));
}

function ignore(): void {}

function failedLaunch(stderr: StderrTail, error: unknown): LaunchedAgent {
  const exit: AgentExit = {
    code: null,
    signal: null,
    spawnError: error instanceof Error ? error.message : String(error),
  };
  const stream: Stream = {
    readable: new ReadableStream<AnyMessage>({ start: (controller) => controller.close() }),
    writable: new WritableStream<AnyMessage>(),
  };
  return {
    target: { kind: "stream", stream },
    pid: undefined,
    stderr,
    exited: Promise.resolve(exit),
    whenGone: async () => exit,
    terminate: async () => {},
    kill: ignore,
  };
}

function trySpawn(request: LaunchRequest): ChildProcessWithoutNullStreams | { readonly error: unknown } {
  try {
    return spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: { ...request.env },
      stdio: "pipe",
      detached: true,
    });
  } catch (error) {
    return { error };
  }
}

export function launchAgent(request: LaunchRequest): LaunchedAgent {
  const stderr = createStderrTail();
  const child = trySpawn(request);
  if ("error" in child) return failedLaunch(stderr, child.error);
  return startedLaunch(child, stderr, request.maxMessageBytes);
}

function startedLaunch(
  child: ChildProcessWithoutNullStreams,
  stderr: StderrTail,
  maxMessageBytes: number | undefined,
): LaunchedAgent {
  const exited = new Promise<AgentExit>((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, spawnError: error.message }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const stderrEnded = new Promise<void>((resolve) => child.stderr.once("close", () => resolve()));
  child.stdin.on("error", ignore);
  child.stdout.on("error", ignore);
  child.stderr.on("error", ignore);
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
    maxMessageBytes === undefined ? undefined : { maxMessageBytes },
  );
  const pid = child.pid;
  let gone = false;
  void exited.then(() => {
    gone = true;
  });
  const kill = (): void => {
    if (!gone && pid !== undefined) killProcessGroup(pid, "SIGKILL");
  };
  return {
    target: { kind: "stream", stream },
    pid,
    stderr,
    exited,
    kill,
    async whenGone(waitMs) {
      const exit = await race(exited, { timeoutMs: waitMs });
      if (exit.kind !== "ok") return undefined;
      await race(stderrEnded, { timeoutMs: STDERR_DRAIN_MS });
      return exit.value;
    },
    async terminate(graceMs) {
      if (!gone && pid !== undefined) {
        child.stdin.end();
        killProcessGroup(pid, "SIGTERM");
        const timer = setTimeout(kill, graceMs);
        await exited;
        clearTimeout(timer);
      }
      await exited;
    },
  };
}

function describeExit(exit: AgentExit | undefined, during: string, secrets: readonly string[]): string {
  if (exit === undefined) return `its connection closed during ${during}`;
  if (exit.spawnError !== undefined) return `it could not be started (${agentTextExcerpt(exit.spawnError, secrets)})`;
  if (exit.signal !== null) return `it was killed by ${exit.signal} during ${during}`;
  return `it exited with code ${String(exit.code)} during ${during}`;
}

/** The agent process died or its stream closed: BACKEND_UNAVAILABLE with the exit and a redacted stderr excerpt. */
export async function agentGoneError(
  during: string,
  launched: LaunchedAgent,
  secrets: readonly string[],
): Promise<AgentSessionError> {
  const exit = await launched.whenGone(GONE_WAIT_MS);
  const stderr = launched.stderr.excerpt({ maxBytes: EXCERPT_BYTES, secrets });
  const what = describeExit(exit, during, secrets);
  const exitDetails =
    exit === undefined
      ? {}
      : { exitCode: exit.code, signal: exit.signal, ...(exit.spawnError === undefined ? {} : { spawnError: true }) };
  return backendUnavailable(stderr === "" ? what : `${what}; stderr: ${stderr}`, { during, ...exitDetails, stderr });
}
