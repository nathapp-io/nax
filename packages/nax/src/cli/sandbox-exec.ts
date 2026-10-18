import { randomUUID } from "node:crypto";
import { constants } from "node:os";
import { createSrtBackend, type SandboxBackend } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { z } from "zod";

const REFUSED_EXIT = 126;
const SIGNAL_EXIT_BASE = 128;
const policyFileSchema = z.strictObject({
  version: z.literal(1),
  home: z.string().optional(),
  stripEnv: z.array(z.string()),
  policy: z.strictObject({
    writeRoots: z.array(z.string()),
    denyWrite: z.array(z.string()),
    denyRead: z.array(z.string()),
    network: z.strictObject({
      allowedDomains: z.array(z.string()).optional(),
      allowLocalBinding: z.literal(true).optional(),
    }),
  }),
});

type ExecChild = {
  exited: Promise<{ exitCode: number | null; signal: string | null }>;
  kill(signal: string): void;
};

export const _sandboxExecDeps: {
  readFile(path: string): Promise<string>;
  createBackend(network: z.infer<typeof policyFileSchema>["policy"]["network"]): SandboxBackend;
  cwd(): string;
  env(): Record<string, string | undefined>;
  // nax-git-env-allow: Generic sandbox argv seam; caller supplies the policy-filtered command environment.
  spawn(argv: readonly string[], opts: { cwd: string; env: Record<string, string> }): ExecChild;
  onSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
  stderr(line: string): void;
} = {
  readFile: (path) => Bun.file(path).text(),
  createBackend: createSrtBackend,
  cwd: () => process.cwd(),
  env: () => process.env,
  spawn: (argv, opts) => {
    // nax-git-env-allow: Backend-produced sandbox argv must inherit opts.env after policy credential stripping and HOME restoration.
    const child = Bun.spawn([...argv], { ...opts, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return {
      exited: child.exited.then((exitCode) => ({ exitCode, signal: child.signalCode })),
      kill: (signal) => {
        child.kill(signal as NodeJS.Signals);
      },
    };
  },
  onSignal: (signal, handler) => {
    process.on(signal, handler);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

function childEnv(file: z.infer<typeof policyFileSchema>): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(_sandboxExecDeps.env()).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !file.stripEnv.includes(entry[0]),
    ),
  );
  if (file.home !== undefined) env.HOME = file.home;
  return env;
}

async function runChild(
  argv: readonly string[],
  opts: { cwd: string; env: Record<string, string> },
  backend: SandboxBackend,
): Promise<number> {
  // nax-git-env-allow: Run sandbox backend argv with the already policy-filtered opts.env, not a Git-specific environment.
  const child = _sandboxExecDeps.spawn(argv, opts);
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  try {
    _sandboxExecDeps.onSignal("SIGINT", interrupt);
    _sandboxExecDeps.onSignal("SIGTERM", terminate);
    const result = await child.exited;
    return result.signal
      ? SIGNAL_EXIT_BASE + (constants.signals[result.signal as NodeJS.Signals] ?? 0)
      : (result.exitCode ?? REFUSED_EXIT);
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    backend.commandFinished();
  }
}

/** Internal per-command entry: deliberately reads neither config nor trust state. */
export async function sandboxExecCommand(policyFile: string, command: string): Promise<number> {
  let backend: SandboxBackend | undefined;
  try {
    const file = policyFileSchema.parse(JSON.parse(await _sandboxExecDeps.readFile(policyFile)));
    backend = _sandboxExecDeps.createBackend(file.policy.network);
    if (!(await backend.isSupportedPlatform())) {
      _sandboxExecDeps.stderr("nax sandbox exec: the OS sandbox is not available on this host");
      return REFUSED_EXIT;
    }
    const cwd = _sandboxExecDeps.cwd();
    const argv = await backend.wrap({ command, shell: "/bin/bash", policy: file.policy, cwd, commandId: randomUUID() });
    return await runChild(argv, { cwd, env: childEnv(file) }, backend);
  } catch (error) {
    _sandboxExecDeps.stderr(`nax sandbox exec: ${errorMessage(error)}`);
    return REFUSED_EXIT;
  } finally {
    try {
      await backend?.reset();
    } catch {
      /* Teardown must not replace the command's exit status. */
    }
  }
}
