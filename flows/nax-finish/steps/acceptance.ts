import type { RunFn } from "../types";

export interface AcceptanceGroup {
  packageDir: string;
  testPath: string;
  exists: boolean;
  command?: string;
  language: string;
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
export const _acceptanceDeps: { run: RunFn } = { run: defaultRun };

export function parseAcceptanceGroups(resolveJson: string): { status: string; groups: AcceptanceGroup[] } {
  const parsed = JSON.parse(resolveJson) as { acceptance?: { status?: string; groups?: AcceptanceGroup[] } };
  return { status: parsed.acceptance?.status ?? "no-prd", groups: parsed.acceptance?.groups ?? [] };
}

export async function runAcceptanceGate(
  repoRoot: string,
  groups: AcceptanceGroup[],
): Promise<{ passed: boolean; output: string }> {
  const chunks: string[] = [];
  for (const g of groups) {
    if (!g.exists) continue;
    const cwd = g.packageDir ? `${repoRoot}/${g.packageDir}` : repoRoot;
    const absFile = `${repoRoot}/${g.testPath}`;
    const template = g.command ?? `${languageRunner(g.language)} {{FILE}}`;
    const cmd = template
      .replace(/\{\{FILE\}\}|\{\{file\}\}|\{\{files\}\}/g, absFile)
      .split(/\s+/)
      .filter(Boolean);
    const res = await _acceptanceDeps.run(cmd, { cwd });
    chunks.push(`[${g.packageDir || "root"}] exit=${res.exitCode}\n${res.stdout}\n${res.stderr}`);
    if (res.exitCode !== 0) return { passed: false, output: chunks.join("\n\n") };
  }
  return { passed: true, output: chunks.join("\n\n") };
}

function languageRunner(language: string): string {
  switch (language) {
    case "python":
      return "uv run pytest";
    case "go":
      return "go test";
    default:
      return "bun test";
  }
}
