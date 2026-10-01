/**
 * Segmentation comparison for the P5 eval: does scoring each segment of a
 * chained command (`a && b`, `a | b`, `a; b`) catch what whole-command scoring
 * misses?
 *
 * The concern is dilution: one dangerous segment inside a long, benign chain
 * may score lower as part of the whole than on its own. The candidate is
 * `max(whole, segments)` — an OR, never an average — so it can only raise a
 * score; the question is whether it raises dangerous rows more than benign
 * ones. The whole command stays the unit a human approves; this measures a
 * possible extra signal and decides nothing.
 *
 * Segments come from the policy's own lexer. A command it refuses
 * (substitutions, here-docs, unterminated quotes) has no segments and is
 * scored whole only — the extra signal stops, the whole-command score does not.
 */
import { lexBashCommand } from "../src/permissions";
import {
  allScores,
  auroc,
  type ModelScores,
  type NarrowableRow,
  rateAt,
  type ScorerName,
  scoreModel,
  type Weights,
} from "./command-safety-eval";

/** A word that needs quoting to survive being re-joined into a command line. */
const NEEDS_QUOTES = /[\s'"\\$`;&|<>()*?[\]{}~#]/;

function quoteWord(word: string, allowGlob: boolean): string {
  const bare = allowGlob ? word.replace(/[*?]/g, "") : word;
  if (word.length > 0 && !NEEDS_QUOTES.test(bare)) return word;
  return `'${word.replace(/'/g, "'\\''")}'`;
}

/**
 * The text of each segment of a chained command, re-joined from the lexer's
 * tokens and redirects. Empty for a single command (whole scoring covers it)
 * and for a command the lexer refuses.
 */
export function segmentCommands(command: string): string[] {
  const lexed = lexBashCommand(command);
  if (lexed.kind !== "ok" || lexed.segments.length < 2) return [];
  return lexed.segments.map((segment) =>
    [
      // Glob characters are kept bare: `rm -rf *` must read as a glob, not a literal star.
      ...segment.tokens.map((token) => quoteWord(token.text, true)),
      ...segment.redirects.map((redirect) => `${redirect.operator} ${quoteWord(redirect.target, false)}`),
    ].join(" "),
  );
}

/**
 * Field-wise maximum over the whole command and its scored segments. An
 * unscored whole stays unscored, so both arms of the comparison cover exactly
 * the same rows.
 */
export function maxModelScores(
  whole: ModelScores | undefined,
  segments: readonly (ModelScores | undefined)[],
): ModelScores | undefined {
  if (whole === undefined) return undefined;
  return segments.reduce<ModelScores>(
    (acc, seg) =>
      seg === undefined
        ? acc
        : {
            harm: Math.max(acc.harm, seg.harm),
            noulMax: Math.max(acc.noulMax, seg.noulMax),
            mean: Math.max(acc.mean, seg.mean),
          },
    whole,
  );
}

/** One labelled command scored both ways. `chained` = it had segments to score. */
export interface SegmentedRow {
  readonly label: "dangerous" | "benign" | "grey";
  readonly chained: boolean;
  readonly whole: Partial<Record<ScorerName, number>>;
  readonly segmented: Partial<Record<ScorerName, number>>;
}

export interface SegmentationComparison {
  readonly scorer: ScorerName;
  readonly aurocWhole: number;
  readonly aurocSegmented: number;
  /** Chained labelled rows the comparison can move. */
  readonly chained: { readonly dangerous: number; readonly benign: number };
  /** At `threshold`: chained dangerous rows only the segmented arm catches. */
  readonly newlyCaught: number;
  /** At `threshold`: chained benign rows only the segmented arm flags. */
  readonly newlyFlagged: number;
  readonly catchWhole: number;
  readonly catchSegmented: number;
  readonly falseAlarmWhole: number;
  readonly falseAlarmSegmented: number;
}

/** Both arms per scorer, over rows scored both ways. Grey rows are excluded, as in the main eval. */
export function compareSegmentation(
  rows: readonly SegmentedRow[],
  scorers: readonly ScorerName[],
  threshold: number,
): SegmentationComparison[] {
  return scorers.flatMap((scorer) => {
    const pick = (label: SegmentedRow["label"], arm: "whole" | "segmented") =>
      rows.flatMap((r) => {
        const v = r[arm][scorer];
        return r.label === label && v !== undefined ? [v] : [];
      });
    const posWhole = pick("dangerous", "whole");
    const negWhole = pick("benign", "whole");
    if (posWhole.length === 0 || negWhole.length === 0) return [];
    const posSeg = pick("dangerous", "segmented");
    const negSeg = pick("benign", "segmented");
    const flips = (label: SegmentedRow["label"]) =>
      rows.filter((r) => {
        const w = r.whole[scorer];
        const s = r.segmented[scorer];
        return r.label === label && r.chained && w !== undefined && s !== undefined && w < threshold && s >= threshold;
      }).length;
    const chainedCount = (label: SegmentedRow["label"]) => rows.filter((r) => r.label === label && r.chained).length;
    return [
      {
        scorer,
        aurocWhole: auroc(posWhole, negWhole),
        aurocSegmented: auroc(posSeg, negSeg),
        chained: { dangerous: chainedCount("dangerous"), benign: chainedCount("benign") },
        newlyCaught: flips("dangerous"),
        newlyFlagged: flips("benign"),
        catchWhole: rateAt(posWhole, threshold),
        catchSegmented: rateAt(posSeg, threshold),
        falseAlarmWhole: rateAt(negWhole, threshold),
        falseAlarmSegmented: rateAt(negSeg, threshold),
      },
    ];
  });
}

const f = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : "n/a");

/** Scores one command's segments, each command text classified once. */
export type SegmentScorer = (segment: string) => Promise<ModelScores | undefined>;

/** Live rows a scorer would send to ask at `threshold`, whole vs segmented. */
export interface LiveSegmentation {
  readonly scorer: ScorerName;
  readonly threshold: number;
  readonly chainedRows: number;
  readonly asksWhole: number;
  readonly asksSegmented: number;
}

interface CorpusScored {
  readonly command: string;
  readonly label: SegmentedRow["label"];
  readonly rule: boolean;
  readonly model: ModelScores | undefined;
}

async function segmentScores(command: string, score: SegmentScorer): Promise<(ModelScores | undefined)[]> {
  const segments = segmentCommands(command);
  const out: (ModelScores | undefined)[] = [];
  for (const segment of segments) out.push(await score(segment));
  return out;
}

/** Corpus rows scored both ways (the whole-command model score is reused, only segments are new). */
export async function segmentCorpus(
  rows: readonly CorpusScored[],
  score: SegmentScorer,
  weights?: Weights,
): Promise<SegmentedRow[]> {
  const out: SegmentedRow[] = [];
  for (const row of rows) {
    const segs = await segmentScores(row.command, score);
    out.push({
      label: row.label,
      chained: segs.length > 0,
      whole: allScores(row.rule, row.model, weights),
      segmented: allScores(row.rule, maxModelScores(row.model, segs), weights),
    });
  }
  return out;
}

/** Live narrowing cost both ways, at each scorer's whole-arm threshold. The rule half is the row's recorded hits. */
export async function segmentLive(
  live: readonly NarrowableRow[],
  thresholds: readonly { scorer: ScorerName; threshold: number }[],
  score: SegmentScorer,
  weights?: Weights,
): Promise<LiveSegmentation[]> {
  const scored: {
    chained: boolean;
    whole: Partial<Record<ScorerName, number>>;
    seg: Partial<Record<ScorerName, number>>;
  }[] = [];
  for (const row of live) {
    const rule = Object.values(row.rules?.hits ?? {}).some(Boolean);
    const model = scoreModel(row.model);
    const segs = row.command === undefined ? [] : await segmentScores(row.command, score);
    scored.push({
      chained: segs.length > 0,
      whole: allScores(rule, model, weights),
      seg: allScores(rule, maxModelScores(model, segs), weights),
    });
  }
  const over = (v: number | undefined, t: number) => v !== undefined && v >= t;
  return thresholds.map(({ scorer, threshold }) => ({
    scorer,
    threshold,
    chainedRows: scored.filter((s) => s.chained).length,
    asksWhole: scored.filter((s) => over(s.whole[scorer], threshold)).length,
    asksSegmented: scored.filter((s) => over(s.seg[scorer], threshold)).length,
  }));
}

/** The report section: one table for the corpus, one for live rows. */
export function renderSegmentation(
  corpus: readonly SegmentationComparison[],
  live: readonly LiveSegmentation[],
  maxFp: number,
): string {
  return [
    `## Segmentation: whole vs max(whole, segments), at each scorer's whole-arm ${maxFp * 100}% FP threshold`,
    "",
    "| scorer | chained dangerous / benign | AUROC whole -> seg | catch whole -> seg | false alarm whole -> seg | newly caught | newly flagged |",
    "|---|---|---|---|---|---|---|",
    ...corpus.map(
      (c) =>
        `| ${c.scorer} | ${c.chained.dangerous} / ${c.chained.benign} | ${f(c.aurocWhole)} -> ${f(c.aurocSegmented)} | ${f(c.catchWhole)} -> ${f(c.catchSegmented)} | ${f(c.falseAlarmWhole)} -> ${f(c.falseAlarmSegmented)} | ${c.newlyCaught} | ${c.newlyFlagged} |`,
    ),
    "",
    "Live rows (asks A would raise):",
    "",
    ...live.map(
      (l) =>
        `- ${l.scorer} (t=${f(l.threshold)}): ${l.asksWhole} -> ${l.asksSegmented} asks; ${l.chainedRows} chained rows`,
    ),
    "",
  ].join("\n");
}
