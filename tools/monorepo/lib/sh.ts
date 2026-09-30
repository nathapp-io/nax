// tools/monorepo/lib/sh.ts
export function run(cmd: string[], cwd: string, env?: Record<string, string>): string {
  const proc = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} (cwd ${cwd}) exited ${proc.exitCode}:\n${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}
