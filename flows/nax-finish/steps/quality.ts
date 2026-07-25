import { FinishError } from "../errors";
import { DEFAULT_GATE_TIMEOUT_MS, runShell } from "../exec";
import type { ShellRunFn } from "../types";

export interface QualityCommands {
  build?: string;
  typecheck?: string;
  lint?: string;
  test?: string;
  format?: string;
}

export const _qualityDeps: { runShell: ShellRunFn; readText: (path: string) => Promise<string | null> } = {
  runShell,
  readText: async (path) => {
    const file = Bun.file(path);
    return (await file.exists()) ? await file.text() : null;
  },
};

const GATE_ORDER: (keyof QualityCommands)[] = ["build", "typecheck", "lint", "test", "format"];

export interface QualityGateOutcome {
  passed: boolean;
  /** Gate names that actually ran — empty means nothing was configured. */
  ran: string[];
  failing: string[];
  output: string;
}

/**
 * Run the repo's configured quality commands in order, each through
 * `/bin/sh -c` (matching `src/quality/runner.ts`) so `&&`, quoting and globs
 * survive, and each under a wall-clock cap so a hung gate can't stall the flow.
 *
 * `passed` is only true when at least one gate ran. A repo with no configured
 * commands must not report a green gate — that previously let the flow open a
 * "ready" PR having verified nothing.
 */
export async function runQualityGates(
  repoRoot: string,
  commands: QualityCommands,
  opts: { timeoutMs?: number } = {},
): Promise<QualityGateOutcome> {
  const failing: string[] = [];
  const ran: string[] = [];
  const chunks: string[] = [];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  for (const gate of GATE_ORDER) {
    const command = commands[gate];
    if (!command) continue;
    ran.push(gate);
    const res = await _qualityDeps.runShell(command, { cwd: repoRoot, timeoutMs });
    chunks.push(`[${gate}] exit=${res.exitCode}\n${res.stdout}\n${res.stderr}`);
    if (res.exitCode !== 0) failing.push(gate);
  }
  if (ran.length === 0) {
    return {
      passed: false,
      ran,
      failing: [],
      output: "[quality] no quality.commands configured in .nax/config.json — nothing was verified",
    };
  }
  return { passed: failing.length === 0, ran, failing, output: chunks.join("\n\n") };
}

/**
 * Read `quality.commands` from the repo-root `.nax/config.json` only.
 *
 * Deliberately root-scoped: per-package `.nax/mono/<pkg>/config.json` overrides
 * are unreliable as a repo-root gate (a package's own `test` command does not
 * verify the repo), and this gate runs once at the root by design.
 */
export async function loadQualityCommands(workdir: string): Promise<QualityCommands> {
  const text = await _qualityDeps.readText(`${workdir}/.nax/config.json`);
  if (!text) return {};
  let cfg: { quality?: { commands?: QualityCommands } };
  try {
    cfg = JSON.parse(text);
  } catch (cause) {
    throw new FinishError(
      "Failed to parse .nax/config.json while loading quality commands",
      "FINISH_CONFIG_UNPARSEABLE",
      {
        stage: "finish-quality",
        path: `${workdir}/.nax/config.json`,
        cause,
      },
    );
  }
  return cfg.quality?.commands ?? {};
}
