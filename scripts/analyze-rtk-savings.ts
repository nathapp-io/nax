/**
 * Measures what routing nax's commands through rtk would actually save.
 *
 * Gate on the rtk interception spec (US-001): its `sites` and `git.verbs`
 * ship empty and are opened by this script's output, not by assertion.
 *
 * Corpus note: run JSONLs record tool NAME and resultBytes but not INPUT, and
 * the tool-audit sink is not retained locally, so git argv cannot be replayed
 * from history. It is synthesised through the real `buildGitArgv` instead,
 * which guarantees verb coverage and reproduces the `--` / `.` shape that
 * defeats rtk's compact paths.
 */
import { NaxError } from "../src/errors";
import { buildGitArgv } from "../src/tools/git";

export interface CorpusEntry {
  readonly id: string;
  readonly kind: "shell" | "argv";
  readonly command?: string;
  readonly argv?: readonly string[];
  readonly verb: string;
}

/** Shapes whose output size does not depend on which commit HEAD is on. */
const GIT_SHAPES: readonly { id: string; input: Record<string, unknown> }[] = [
  { id: "diff-plain", input: { subcommand: "diff" } },
  { id: "diff-nameonly", input: { subcommand: "diff", nameOnly: true } },
  { id: "log-plain", input: { subcommand: "log" } },
  { id: "log-oneline", input: { subcommand: "log", oneline: true } },
  { id: "log-nameonly", input: { subcommand: "log", nameOnly: true, maxCount: 7 } },
  { id: "status-plain", input: { subcommand: "status" } },
  { id: "blame-file", input: { subcommand: "blame", paths: ["README.md"] } },
];

/**
 * Shapes that measure exactly one commit, and therefore measure whatever that
 * commit happened to contain.
 *
 * This is not a detail. The first corpus run sampled only `HEAD` and reported
 * `diff` at 1.8%; a run one merge later reported the same verb at 67.4%. The
 * difference was entirely the size of the last commit (8.6 KB vs 76.8 KB), not
 * anything about rtk. Sampling a spread of commits is what turns these rows
 * from a coin flip into evidence.
 */
const COMMIT_RELATIVE_SHAPES: readonly { id: string; input: (ref: string) => Record<string, unknown> }[] = [
  { id: "diff-ref", input: (ref) => ({ subcommand: "diff", refs: [`${ref}~1`, ref] }) },
  { id: "show-plain", input: (ref) => ({ subcommand: "show", refs: [ref] }) },
  { id: "show-nameonly", input: (ref) => ({ subcommand: "show", refs: [ref], nameOnly: true }) },
];

export function buildGitCorpus(sampleRefs: readonly string[] = ["HEAD"]): CorpusEntry[] {
  const out: CorpusEntry[] = [];
  for (const shape of GIT_SHAPES) {
    const argv = buildGitArgv(shape.input);
    if (!Array.isArray(argv)) continue;
    out.push({ id: shape.id, kind: "argv", argv: ["git", ...argv], verb: String(shape.input.subcommand) });
  }
  for (const shape of COMMIT_RELATIVE_SHAPES) {
    for (const [i, ref] of sampleRefs.entries()) {
      const input = shape.input(ref);
      const argv = buildGitArgv(input);
      if (!Array.isArray(argv)) continue;
      out.push({
        id: sampleRefs.length > 1 ? `${shape.id}[${i}]` : shape.id,
        kind: "argv",
        argv: ["git", ...argv],
        verb: String(input.subcommand),
      });
    }
  }
  return out;
}

/**
 * The last `n` commit hashes with a parent, newest first.
 *
 * `--min-parents=1` drops the root commit, whose `<ref>~1` does not resolve and
 * would contribute ~200 bytes of identical `fatal:` text to both sides of the
 * comparison — a 0%-saving sample diluting the very average the sampling exists
 * to stabilise. It also matters in a shallow clone, where the oldest commit is
 * grafted and behaves like a root.
 *
 * Throws rather than returning `[]`: an empty list silently removes `show`
 * from the report and strips every `diff` sample, and the table just comes back
 * shorter with no indication anything went wrong.
 */
export async function recentCommits(cwd: string, n: number): Promise<string[]> {
  if (!Number.isInteger(n) || n < 1) {
    throw new NaxError(`sample size must be a positive integer, got ${n}`, "RTK_CORPUS_BAD_SAMPLE");
  }
  const proc = Bun.spawn(["git", "log", `-n${n}`, "--min-parents=1", "--format=%H"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [text, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) {
    throw new NaxError(`git log failed while sampling commits: ${err.trim()}`, "RTK_CORPUS_SAMPLE_FAILED");
  }
  const refs = text.split("\n").filter(Boolean);
  if (refs.length === 0) throw new NaxError("no commits with a parent to sample", "RTK_CORPUS_SAMPLE_EMPTY");
  return refs;
}

/** Commands that write by default, with no flag to give them away. */
const WRITES_BY_DEFAULT =
  /(^|[\s;&|])(gofmt|goimports|black|isort|rustfmt|sed\s+-i|cargo\s+fmt|ruff\s+format|npm\s+install|bun\s+install|yarn\s+install|pnpm\s+install)(\s|$)/;

/** Write-enabling flags, long and short, with or without an attached value. */
const WRITE_FLAGS = /(^|\s)(--(write|fix|apply)(-[a-z-]+)?(=\S*)?|-[iw])(\s|$)/;

/**
 * True when a quality command would write to the working tree.
 *
 * This decides whether an arbitrary user-authored string gets EXECUTED, twice,
 * so it is deliberately trigger-happy: a false positive costs one unmeasured
 * row (reported, not hidden), a false negative rewrites the user's tree. It is
 * still a deny-list and therefore still incomplete — `qualitySkips` reports
 * every skip so a reader can tell "measured 0%" from "never measured".
 *
 * Checking the command and not just the key matters: the key is named by the
 * user, and `precommit: "bun run lint:fix"` is as mutating as `lintFix` is.
 */
export function isMutatingQualityCommand(name: string, command: string): boolean {
  if (/fix$/i.test(name)) return true;
  if (WRITE_FLAGS.test(command)) return true;
  if (WRITES_BY_DEFAULT.test(command)) return true;
  return /(^|[\s;&|])\S*(lint|format|fmt):?fix\b/i.test(command);
}

export interface QualitySkip {
  readonly id: string;
  readonly reason: string;
}

/**
 * Every command dropped from the quality corpus, and why.
 *
 * A silent skip is indistinguishable, in the report, from a command that was
 * measured and saved nothing — and this report's conclusion IS a set of
 * measured zeros. The skips are printed alongside the table.
 */
export function qualitySkips(commands: Record<string, unknown>): QualitySkip[] {
  const out: QualitySkip[] = [];
  for (const [name, spec] of Object.entries(commands)) {
    const list = Array.isArray(spec) ? spec : [spec];
    for (const [i, cmd] of list.entries()) {
      const id = list.length > 1 ? `${name}[${i}]` : name;
      if (typeof cmd !== "string") continue;
      if (cmd.includes("{{")) out.push({ id, reason: "placeholder template, not executable as written" });
      else if (isMutatingQualityCommand(name, cmd))
        out.push({ id, reason: "mutating: would write to the working tree" });
      else if (injectRtk(cmd) === null) out.push({ id, reason: "rtk wrapper cannot express this command shape" });
    }
  }
  return out;
}

export function buildQualityCorpus(commands: Record<string, unknown>): CorpusEntry[] {
  const out: CorpusEntry[] = [];
  for (const [name, spec] of Object.entries(commands)) {
    const list = Array.isArray(spec) ? spec : [spec];
    for (const [i, cmd] of list.entries()) {
      if (typeof cmd !== "string" || cmd.includes("{{")) continue; // placeholder template
      if (isMutatingQualityCommand(name, cmd)) continue; // corpus leaves the tree alone
      if (injectRtk(cmd) === null) continue; // reported by qualitySkips, never measured as 0%
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

/**
 * Places `rtk` after any leading `VAR=value` assignments, or returns `null`
 * when the command is a shape this cannot wrap correctly.
 *
 * Two failure modes, and the second is why this returns `null` rather than a
 * best effort. A naive `rtk ${command}` makes the shell hand `AGENT=1` to rtk
 * as its subcommand; rtk fails to exec it and exits 127 — loud, and the first
 * corpus run duly mis-reported it as an exit-code DISQUALIFICATION for the
 * whole `lint` verb. But splitting the prefix on whitespace is *silently*
 * wrong: `FOO="a b" bun test` becomes `FOO="a rtk b" bun test`, which never
 * invokes rtk at all and therefore measures raw-vs-raw and reports a clean
 * 0.0% saving at perfect exit parity — indistinguishable from a real measured
 * zero, in a table whose whole purpose is to decide a feature on measured
 * zeros. A refusal the caller must handle is the only safe shape.
 */
export function injectRtk(command: string): string | null {
  // A shell operator means the prefix position is not simply "the front".
  if (/[|&;<>()`$]/.test(command)) return null;
  const match = command.match(/^((?:[A-Za-z_][A-Za-z0-9_]*=[^\s'"]*\s+)*)(\S[\s\S]*)$/);
  if (!match) return null;
  const [, assignments, rest] = match;
  // A bare `VAR=value` with no command would put rtk in front of the assignment.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest)) return null;
  return `${assignments}rtk ${rest}`;
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
  let rtkArgv: string[];
  if (entry.kind === "shell") {
    const wrapped = injectRtk(entry.command ?? "");
    // Refusing is not the same as measuring zero; say so rather than compare
    // the raw command against itself.
    if (wrapped === null) throw new NaxError(`cannot wrap command for rtk: ${entry.id}`, "RTK_CORPUS_UNWRAPPABLE");
    rtkArgv = ["/bin/sh", "-c", wrapped];
  } else {
    rtkArgv = ["rtk", ...(entry.argv ?? [])];
  }

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
  /** Per-sample delivered savings. A byte-weighted mean hides a single commit dominating the row. */
  readonly medianSavedPct: number;
  readonly minSavedPct: number;
  readonly maxSavedPct: number;
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
    const perSample = list
      .map((m) => (m.sliced.raw === 0 ? 0 : (100 * (m.sliced.raw - m.sliced.rtk)) / m.sliced.raw))
      .sort((a, b) => a - b);
    const mid = Math.floor(perSample.length / 2);
    const median = perSample.length % 2 === 1 ? perSample[mid] : (perSample[mid - 1] + perSample[mid]) / 2;

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
      medianSavedPct: median,
      minSavedPct: perSample[0],
      maxSavedPct: perSample[perSample.length - 1],
    });
  }
  return rows.sort((a, b) => b.rawKB - a.rawKB);
}

export function formatReport(rows: readonly VerbRow[]): string {
  const lines = ["verb\tn\trawKB\trtkKB\tsaved%\tdelivered-saved%\tmedian%\tmin%\tmax%\tverdict"];
  for (const r of rows) {
    lines.push(
      [
        r.verb,
        r.n,
        r.rawKB.toFixed(0),
        r.rtkKB.toFixed(0),
        r.savedPct.toFixed(1),
        r.slicedSavedPct.toFixed(1),
        r.medianSavedPct.toFixed(1),
        r.minSavedPct.toFixed(1),
        r.maxSavedPct.toFixed(1),
        r.disqualified ? `DISQUALIFIED — ${r.reason}` : "ok",
      ].join("\t"),
    );
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const hasRtk = Bun.which("rtk") !== null;
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
  const refs = await recentCommits(cwd, Number(process.env.RTK_SAMPLE_COMMITS ?? 12));
  const corpus = [...buildGitCorpus(refs), ...buildQualityCorpus(commands)];
  const measurements: Measurement[] = [];
  for (const entry of corpus) measurements.push(await measure(entry, cwd));
  console.log(formatReport(summarize(measurements)));
  const skips = qualitySkips(commands);
  if (skips.length > 0) {
    console.log("\nNOT MEASURED (absent from the table above, not a measured zero):");
    for (const skip of skips) console.log(`  ${skip.id}\t${skip.reason}`);
  }
}
