/**
 * Measures what routing nax's commands through rtk would actually save.
 *
 * Gate on the rtk interception spec (US-001): its `sites` and `git.verbs`
 * ship empty and are opened by this script's output, not by assertion.
 *
 * Corpus note: run JSONLs record tool NAME and resultBytes but not INPUT, and
 * the tool-audit sink is not retained locally, so git argv cannot be replayed
 * from history. It is synthesised through the real `buildGitArgv` instead,
 * which guarantees verb coverage and reproduces the `--relative` / `--` / `.`
 * that defeat rtk's compact paths.
 */
import { buildGitArgv } from "../src/tools/git";

export interface CorpusEntry {
  readonly id: string;
  readonly kind: "shell" | "argv";
  readonly command?: string;
  readonly argv?: readonly string[];
  readonly verb: string;
}

const GIT_SHAPES: readonly { id: string; input: Record<string, unknown> }[] = [
  { id: "diff-plain", input: { subcommand: "diff" } },
  { id: "diff-nameonly", input: { subcommand: "diff", nameOnly: true } },
  { id: "diff-ref", input: { subcommand: "diff", refs: ["HEAD~1", "HEAD"] } },
  { id: "log-plain", input: { subcommand: "log" } },
  { id: "log-oneline", input: { subcommand: "log", oneline: true } },
  { id: "log-nameonly", input: { subcommand: "log", nameOnly: true, maxCount: 7 } },
  { id: "show-plain", input: { subcommand: "show", refs: ["HEAD"] } },
  { id: "show-nameonly", input: { subcommand: "show", refs: ["HEAD"], nameOnly: true } },
  { id: "status-plain", input: { subcommand: "status" } },
  { id: "blame-file", input: { subcommand: "blame", paths: ["README.md"] } },
];

export function buildGitCorpus(): CorpusEntry[] {
  const out: CorpusEntry[] = [];
  for (const shape of GIT_SHAPES) {
    const argv = buildGitArgv(shape.input);
    if (!Array.isArray(argv)) continue;
    out.push({
      id: shape.id,
      kind: "argv",
      argv: ["git", ...argv],
      verb: String(shape.input.subcommand),
    });
  }
  return out;
}

export function buildQualityCorpus(commands: Record<string, unknown>): CorpusEntry[] {
  const out: CorpusEntry[] = [];
  for (const [name, spec] of Object.entries(commands)) {
    const list = Array.isArray(spec) ? spec : [spec];
    for (const [i, cmd] of list.entries()) {
      if (typeof cmd !== "string" || cmd.includes("{{")) continue; // skip placeholder templates
      out.push({ id: list.length > 1 ? `${name}[${i}]` : name, kind: "shell", command: cmd, verb: name });
    }
  }
  return out;
}

/** nax's per-tool output ceiling; see DEFAULT_TOOL_MAX_BYTES in src/tools/runtime.ts. */
export const TOOL_MAX_BYTES = 40_000;

/** What the model is actually told, after nax truncates. The number that matters. */
export function slice(bytes: number): number {
  return Math.min(bytes, TOOL_MAX_BYTES);
}

export interface Measurement {
  readonly id: string;
  readonly verb: string;
  readonly rawBytes: number;
  readonly rtkBytes: number;
  readonly rawExit: number;
  readonly rtkExit: number;
  readonly parity: boolean;
  readonly rawMs: number;
  readonly rtkMs: number;
  readonly sliced: { readonly raw: number; readonly rtk: number };
}

async function run(argv: readonly string[], cwd: string): Promise<{ bytes: number; exit: number; ms: number }> {
  const started = Date.now();
  const proc = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exit = await proc.exited;
  // nax merges the two streams (src/quality/runner.ts:241), so measure the merge.
  return { bytes: [out, err].filter(Boolean).join("\n").length, exit, ms: Date.now() - started };
}

export async function measure(entry: CorpusEntry, cwd: string): Promise<Measurement> {
  const rawArgv = entry.kind === "shell" ? ["/bin/sh", "-c", entry.command ?? ""] : [...(entry.argv ?? [])];
  const rtkArgv =
    entry.kind === "shell" ? ["/bin/sh", "-c", `rtk ${entry.command ?? ""}`] : ["rtk", ...(entry.argv ?? [])];

  const raw = await run(rawArgv, cwd);
  const rtk = await run(rtkArgv, cwd);

  return {
    id: entry.id,
    verb: entry.verb,
    rawBytes: raw.bytes,
    rtkBytes: rtk.bytes,
    rawExit: raw.exit,
    rtkExit: rtk.exit,
    parity: raw.exit === rtk.exit,
    rawMs: raw.ms,
    rtkMs: rtk.ms,
    sliced: { raw: slice(raw.bytes), rtk: slice(rtk.bytes) },
  };
}

export interface VerbRow {
  readonly verb: string;
  readonly n: number;
  readonly rawKB: number;
  readonly rtkKB: number;
  /** Reduction in FULL output. The headline, and the misleading one. */
  readonly savedPct: number;
  /** Reduction in what the model is actually told. The number that matters. */
  readonly slicedSavedPct: number;
  readonly disqualified: boolean;
  readonly reason?: string;
}

export function summarize(measurements: readonly Measurement[]): VerbRow[] {
  const byVerb = new Map<string, Measurement[]>();
  for (const m of measurements) {
    const list = byVerb.get(m.verb) ?? [];
    list.push(m);
    byVerb.set(m.verb, list);
  }

  const rows: VerbRow[] = [];
  for (const [verb, list] of byVerb) {
    const raw = list.reduce((s, m) => s + m.rawBytes, 0);
    const rtk = list.reduce((s, m) => s + m.rtkBytes, 0);
    const slicedRaw = list.reduce((s, m) => s + m.sliced.raw, 0);
    const slicedRtk = list.reduce((s, m) => s + m.sliced.rtk, 0);
    const diverged = list.filter((m) => !m.parity);

    rows.push({
      verb,
      n: list.length,
      rawKB: raw / 1024,
      rtkKB: rtk / 1024,
      savedPct: raw === 0 ? 0 : (100 * (raw - rtk)) / raw,
      slicedSavedPct: slicedRaw === 0 ? 0 : (100 * (slicedRaw - slicedRtk)) / slicedRaw,
      disqualified: diverged.length > 0,
      // Exit-code parity is a CORRECTNESS gate: a verb that changes a command's
      // exit code is unusable no matter how much output it saves, because nax
      // computes `success: exitCode === 0` from it.
      reason:
        diverged.length > 0
          ? `exit-code divergence on ${diverged.length}/${list.length} (e.g. ${diverged[0].id}: raw ${diverged[0].rawExit} vs rtk ${diverged[0].rtkExit})`
          : undefined,
    });
  }
  return rows.sort((a, b) => b.rawKB - a.rawKB);
}

export function formatReport(rows: readonly VerbRow[]): string {
  const lines = ["verb\tn\trawKB\trtkKB\tsaved%\tdelivered-saved%\tverdict"];
  for (const r of rows) {
    lines.push(
      [
        r.verb,
        r.n,
        r.rawKB.toFixed(0),
        r.rtkKB.toFixed(0),
        r.savedPct.toFixed(1),
        r.slicedSavedPct.toFixed(1),
        r.disqualified ? `DISQUALIFIED — ${r.reason}` : "ok",
      ].join("\t"),
    );
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const hasRtk = Bun.spawnSync(["rtk", "--version"]).exitCode === 0;
  if (!hasRtk) {
    console.log("rtk not on PATH — skipping. Install rtk to produce the measurement table.");
    process.exit(0);
  }
  const cwd = process.cwd();
  const configPath = `${cwd}/.nax/config.json`;
  const commands =
    (
      await Bun.file(configPath)
        .json()
        .catch(() => ({}))
    ).quality?.commands ?? {};
  const corpus = [...buildGitCorpus(), ...buildQualityCorpus(commands)];
  const measurements: Measurement[] = [];
  for (const entry of corpus) measurements.push(await measure(entry, cwd));
  console.log(formatReport(summarize(measurements)));
}
