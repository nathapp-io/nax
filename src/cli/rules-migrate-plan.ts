/**
 * `nax rules migrate` — pure migration planner
 *
 * Extracted from rulesMigrateCommand so the dry-run preview and the real run
 * describe the SAME work: both consume the same `MigrationPlan`, derived once
 * from the same sources and the same `fileExists` answers. Previously the two
 * branches kept their own write-or-skip decisions and quietly diverged —
 * dry-run skipped the existing-target check, counted those targets as
 * written, and emitted no summary (defect 1).
 *
 * The planner is intentionally pure: it does no I/O of its own, only calls
 * the injected `fileExists`. That keeps the function trivially testable
 * without monkey-patching Bun.file and lets both modes agree by construction.
 */

export interface MigrationPlanEntry {
  sourcePath: string;
  targetFileName: string;
  targetPath: string;
  content: string;
}

export interface MigrationPlan {
  writes: MigrationPlanEntry[];
  skips: MigrationPlanEntry[];
}

export interface PlanMigrationOptions {
  targetDir: string;
  force: boolean;
  fileExists: (path: string) => Promise<boolean>;
}

/**
 * Decide which sources become writes and which become skips.
 *
 * A source becomes a SKIP exactly when its target exists and `force` is
 * false; otherwise it becomes a WRITE. Every source lands in exactly one
 * of the two lists — never both, never neither — so downstream consumers
 * (real-run writer, dry-run summary) can iterate either list alone and
 * still see every entry exactly once.
 *
 * Source order is preserved within each list: the real run writes in that
 * order, and the dry-run preview is reported in the same order so the two
 * outputs line up entry-for-entry.
 */
export async function planMigration(
  sources: MigrationPlanEntry[],
  options: PlanMigrationOptions,
): Promise<MigrationPlan> {
  const writes: MigrationPlanEntry[] = [];
  const skips: MigrationPlanEntry[] = [];

  for (const source of sources) {
    const exists = await options.fileExists(source.targetPath);
    if (exists && !options.force) {
      skips.push(source);
    } else {
      writes.push(source);
    }
  }

  return { writes, skips };
}
