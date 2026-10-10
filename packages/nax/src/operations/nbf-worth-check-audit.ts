/** Best-effort structured log and per-story audit for worth-check judgments. */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Finding } from "../findings";
import { getLogger } from "../logger";
import { type NaxRuntime, totalSpendUsd } from "../runtime";
import type { NbfWorthCheckOpOutput, NbfWorthVerdict } from "./nbf-worth-check";

export interface NbfWorthCheckRecord {
  readonly runtime: NaxRuntime;
  readonly storyId: string;
  readonly featureName: string | undefined;
  readonly packageDir: string;
  readonly mode: "on" | "shadow";
  readonly findings: readonly Finding[];
  readonly result?: NbfWorthCheckOpOutput;
  readonly error?: string;
  readonly durationMs: number;
  readonly costUsd: number;
}

export interface NbfWorthCheckAuditFile {
  readonly storyId: string;
  readonly featureName: string | undefined;
  readonly mode: "on" | "shadow";
  readonly parsed: boolean;
  readonly unparsedPreview?: string;
  readonly findings: readonly {
    index: number;
    severity: string;
    category: string;
    file: string | undefined;
    line: number | undefined;
    message: string;
  }[];
  readonly verdicts: readonly NbfWorthVerdict[];
  readonly durationMs: number;
  readonly costUsd: number;
}

export const _nbfWorthCheckAuditDeps = {
  write: async (path: string, record: NbfWorthCheckAuditFile): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, JSON.stringify(record, null, 2));
  },
  now: (): number => Date.now(),
  costTotal: (runtime: NaxRuntime): number => totalSpendUsd(runtime.costAggregator.snapshot()),
};

function fileRecord(record: NbfWorthCheckRecord): NbfWorthCheckAuditFile {
  const parsed = record.result?.parsed === true;
  return {
    storyId: record.storyId,
    featureName: record.featureName,
    mode: record.mode,
    parsed,
    ...(!parsed
      ? { unparsedPreview: record.error ?? (record.result?.parsed === false ? record.result.unparsedPreview : "") }
      : {}),
    findings: record.findings.map(({ severity, category, file, line, message }, index) => ({
      index: index + 1,
      severity,
      category,
      file,
      line,
      message,
    })),
    verdicts: record.result?.parsed === true ? record.result.verdicts : [],
    durationMs: record.durationMs,
    costUsd: record.costUsd,
  };
}

async function recordNbfWorthCheckInternal(record: NbfWorthCheckRecord): Promise<void> {
  const logger = getLogger();
  const result = record.result;
  if (record.error !== undefined || result?.parsed === false) {
    logger.warn("nbf-worth-check", "worth-check failed — fixing all findings", {
      storyId: record.storyId,
      packageDir: record.packageDir,
      error: record.error ?? (result?.parsed === false ? result.unparsedPreview : "unknown error"),
    });
  } else {
    const verdicts = result?.parsed ? result.verdicts : [];
    const skipped = verdicts.flatMap((verdict) =>
      verdict.verdict === "skip"
        ? [
            {
              file: record.findings[verdict.index - 1]?.file ?? "",
              line: record.findings[verdict.index - 1]?.line ?? 0,
              reason: verdict.reason,
            },
          ]
        : [],
    );
    const fix = verdicts.filter((verdict) => verdict.verdict === "fix").length;
    const skip = verdicts.filter((verdict) => verdict.verdict === "skip").length;
    logger.info("nbf-worth-check", "worth-check verdicts", {
      storyId: record.storyId,
      packageDir: record.packageDir,
      mode: record.mode,
      fix,
      skip,
      skipped,
    });
    if (record.mode === "on" && verdicts.length > 0 && fix === 0 && skip === verdicts.length) {
      logger.info("nbf-worth-check", "all advisory findings skipped — NBF not run", {
        storyId: record.storyId,
        packageDir: record.packageDir,
        skip,
      });
    }
  }
  try {
    const audit = fileRecord(record);
    const feature = record.featureName || "_unknown";
    const path = join(
      record.runtime.outputDir,
      "nbf-worth-check",
      feature,
      `${record.storyId}-${_nbfWorthCheckAuditDeps.now()}.json`,
    );
    await _nbfWorthCheckAuditDeps.write(path, audit);
  } catch (error) {
    logger.warn("nbf-worth-check", "worth-check audit write failed", {
      storyId: record.storyId,
      packageDir: record.packageDir,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function recordNbfWorthCheck(record: NbfWorthCheckRecord): Promise<void> {
  try {
    await recordNbfWorthCheckInternal(record);
  } catch {
    // Logging and audit are deliberately best-effort; neither may affect NBF.
  }
}
