import type { RunFn } from "../types";

export interface QualityCommands {
  build?: string;
  typecheck?: string;
  lint?: string;
  test?: string;
  format?: string;
}

async function defaultRun(cmd: string[], opts: { cwd: string }) {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
export const _qualityDeps: { run: RunFn; readText: (path: string) => Promise<string | null> } = {
  run: defaultRun,
  readText: async (path) => {
    const file = Bun.file(path);
    return (await file.exists()) ? await file.text() : null;
  },
};

const GATE_ORDER: (keyof QualityCommands)[] = ["build", "typecheck", "lint", "test", "format"];

export async function runQualityGates(
  repoRoot: string,
  commands: QualityCommands,
): Promise<{ passed: boolean; failing: string[]; output: string }> {
  const failing: string[] = [];
  const chunks: string[] = [];
  for (const gate of GATE_ORDER) {
    const command = commands[gate];
    if (!command) continue;
    const res = await _qualityDeps.run(command.split(/\s+/).filter(Boolean), { cwd: repoRoot });
    chunks.push(`[${gate}] exit=${res.exitCode}\n${res.stdout}\n${res.stderr}`);
    if (res.exitCode !== 0) failing.push(gate);
  }
  return { passed: failing.length === 0, failing, output: chunks.join("\n\n") };
}

export async function loadQualityCommands(workdir: string): Promise<QualityCommands> {
  const text = await _qualityDeps.readText(`${workdir}/.nax/config.json`);
  if (!text) return {};
  const cfg = JSON.parse(text) as { quality?: { commands?: QualityCommands } };
  return cfg.quality?.commands ?? {};
}
