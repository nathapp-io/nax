#!/usr/bin/env bun

const WORKDIR = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/\/$/, "");
const TEST_TIMEOUT = "--timeout=60000";
const PHASES = ["test/unit/", "test/integration/", "test/ui/"] as const;
const SHUTDOWN_GRACE_MS = 300;
const SIGNAL_EXIT_CODE: Record<"SIGINT" | "SIGTERM" | "SIGHUP", number> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};

let activeProcess: Bun.Subprocess<"ignore", "inherit", "inherit"> | null = null;
let shuttingDown = false;

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Ignore if the group has already exited.
  }
}

async function stopActiveProcess(): Promise<void> {
  const proc = activeProcess;
  if (proc === null) {
    return;
  }

  killProcessGroup(proc.pid, "SIGTERM");

  const processState = await Promise.race([
    proc.exited.then(() => "exited" as const),
    Bun.sleep(SHUTDOWN_GRACE_MS).then(() => "timeout" as const),
  ]);

  if (processState === "timeout") {
    killProcessGroup(proc.pid, "SIGKILL");
  }
}

function registerSignalHandlers(): void {
  const onSignal = async (signal: "SIGINT" | "SIGTERM" | "SIGHUP") => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    await stopActiveProcess();

    process.exit(SIGNAL_EXIT_CODE[signal]);
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
}

async function runPhase(path: string, bail: boolean): Promise<number> {
  const cmd = ["bun", "test", path, TEST_TIMEOUT];
  if (bail) {
    cmd.push("--bail");
  }

  const proc = Bun.spawn(cmd, {
    cwd: WORKDIR,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    detached: true,
  });

  activeProcess = proc;
  const exitCode = await proc.exited;
  if (activeProcess === proc) {
    activeProcess = null;
  }

  return exitCode;
}

async function main(): Promise<void> {
  const bail = process.argv.includes("--bail");
  registerSignalHandlers();

  for (const phasePath of PHASES) {
    const exitCode = await runPhase(phasePath, bail);
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  }
}

await main();
