/**
 * `nax advisor` — A1 advisor decisions (spec §4.7).
 *
 * `list`  — the feature ledger(s), flagged decisions first.
 * `label` — append a human label to `<outputDir>/advisor-audit/<feature>/labels.jsonl`.
 * `replay` / `import-finish` live in sibling modules (Tasks 11–12).
 *
 * Output dir resolution mirrors `src/cli/approvals.ts`: `loadConfig(workdir)`
 * (a throw reads as no config), project key `config.name` trimmed or the
 * directory basename, then `projectOutputDir(key, config.outputDir)`.
 */
import { readdir } from "node:fs/promises";
import { basename } from "node:path";
import type { Command } from "commander";
import type { AdviceDecision, AdviceLabel } from "@/advisor";
import { appendLabel, readDecisions } from "@/advisor";
import { featuresDir, loadConfig } from "@/config";
import { projectOutputDir } from "@/runtime";
import { _advisorReplayDeps, type AdvisorReplayDeps, runAdvisorReplay } from "./advisor-replay";

export interface AdvisorCliDeps {
  resolveOutputDir: (workdir: string) => Promise<string>;
  log: (text: string) => void;
  logErr: (text: string) => void;
  exit: (code: number) => void;
  now: () => string;
}

export const _advisorCliDeps: AdvisorCliDeps = {
  resolveOutputDir: async (workdir) => {
    const config = await loadConfig(workdir).catch(() => null);
    const projectKey = config?.name?.trim() || basename(workdir);
    return projectOutputDir(projectKey, config?.outputDir);
  },
  log: (text) => {
    console.log(text);
  },
  logErr: (text) => {
    console.error(text);
  },
  exit: (code) => {
    process.exit(code);
  },
  now: () => new Date().toISOString(),
};

const ID_PATTERN = /^(D|Q)-[\w-]+$/;
const VERDICTS = new Set(["agree", "disagree"]);
const FEATURE_PATTERN = /^[\w.-]+$/;

function formatDecision(d: AdviceDecision, feature?: string): string {
  const flag = d.needsHumanConfirm ? "  (needs confirm)" : "";
  const where = [feature, d.storyId].filter(Boolean).join(" ");
  return `${d.id}  [${d.kind}] ${where}  ${d.action.type}${flag}  ${d.rationale}`;
}

function flaggedFirst(ds: readonly AdviceDecision[]): AdviceDecision[] {
  return [...ds.filter((d) => d.needsHumanConfirm), ...ds.filter((d) => !d.needsHumanConfirm)];
}

async function featureNames(repoRoot: string): Promise<string[]> {
  const entries = await readdir(featuresDir(repoRoot), { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

export async function advisorListCommand(
  opts: { dir: string; feature?: string; json: boolean },
  deps: AdvisorCliDeps,
): Promise<number> {
  const features = opts.feature ? [opts.feature] : await featureNames(opts.dir);
  const all: { feature: string; decision: AdviceDecision }[] = [];
  for (const feature of features) {
    for (const decision of await readDecisions(opts.dir, feature)) all.push({ feature, decision });
  }
  if (opts.json) {
    deps.log(
      JSON.stringify(
        all.map((e) => (opts.feature ? e.decision : { feature: e.feature, ...e.decision })),
        null,
        2,
      ),
    );
    return 0;
  }
  if (all.length === 0) {
    deps.log("No advisor decisions recorded.");
    return 0;
  }
  const ordered = flaggedFirst(all.map((e) => e.decision));
  for (const d of ordered) {
    const feature = all.find((e) => e.decision === d)?.feature;
    deps.log(formatDecision(d, opts.feature ? undefined : feature));
  }
  return 0;
}

export async function advisorLabelCommand(
  opts: {
    dir: string;
    feature: string;
    id: string;
    verdict: string;
    expected?: string;
    unsafeTypes?: string;
    note?: string;
  },
  deps: AdvisorCliDeps,
): Promise<number> {
  if (!ID_PATTERN.test(opts.id) || !VERDICTS.has(opts.verdict) || !FEATURE_PATTERN.test(opts.feature)) {
    deps.logErr("error: usage: nax advisor label <D-n|Q-…> <agree|disagree> -f <feature>");
    return 2;
  }
  const unsafeTypes = opts.unsafeTypes
    ?.split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  const label: AdviceLabel = {
    id: opts.id,
    verdict: opts.verdict as AdviceLabel["verdict"],
    ...(opts.expected ? { expected: opts.expected } : {}),
    ...(unsafeTypes && unsafeTypes.length > 0 ? { unsafeTypes } : {}),
    ...(opts.note ? { note: opts.note } : {}),
    labelledAt: deps.now(),
  };
  await appendLabel(await deps.resolveOutputDir(opts.dir), opts.feature, label);
  deps.log(`labelled ${opts.id} ${opts.verdict}`);
  return 0;
}

async function guarded(deps: AdvisorCliDeps, body: () => Promise<number>): Promise<void> {
  try {
    deps.exit(await body());
  } catch (err) {
    deps.logErr(`error: ${err instanceof Error ? err.message : String(err)}`);
    deps.exit(1);
  }
}

/** Register `nax advisor list|label` (replay and import-finish are added by their own modules). */
export function registerAdvisorCommand(
  program: Command,
  deps: AdvisorCliDeps = _advisorCliDeps,
  replayDeps: AdvisorReplayDeps = _advisorReplayDeps,
): Command {
  const group = program.command("advisor").description("Inspect, label and replay advisor decisions");
  group
    .command("list")
    .description("List advisor decisions (flagged first)")
    .option("-d, --dir <path>", "Project directory", process.cwd())
    .option("-f, --feature <name>", "Feature name (default: every feature)")
    .option("--json", "Emit JSON")
    .action((o: { dir: string; feature?: string; json?: boolean }) =>
      guarded(deps, () => advisorListCommand({ dir: o.dir, feature: o.feature, json: o.json === true }, deps)),
    );
  group
    .command("label")
    .description("Label a decision for the go-live replay")
    .argument("<id>", "Decision or question id (D-n / Q-…)")
    .argument("<verdict>", "agree | disagree")
    .requiredOption("-f, --feature <name>", "Feature name")
    .option("-d, --dir <path>", "Project directory", process.cwd())
    .option("--expected <type>", "The action type a human would have chosen")
    .option("--unsafe-types <types>", "Comma-separated action types that are unsafe for this case")
    .option("--note <text>", "Free-text note")
    .action(
      (
        id: string,
        verdict: string,
        o: { dir: string; feature: string; expected?: string; unsafeTypes?: string; note?: string },
      ) => guarded(deps, () => advisorLabelCommand({ ...o, id, verdict }, deps)),
    );
  group
    .command("replay")
    .description("Re-run recorded advisor questions (billed) and compare; --eval scores against labels")
    .argument("[id]", "One decision/question id (default: every record of the feature)")
    .requiredOption("-f, --feature <name>", "Feature name")
    .option("-d, --dir <path>", "Project directory", process.cwd())
    .option("--model <model>", "Tier name or agent:model to replay with")
    .option("--memory <mode>", "stateless | warm", "stateless")
    .option("--eval", "Score replays against labels.jsonl (exit 1 on any unsafe replay)")
    .option("--json", "Emit JSON")
    .action(
      (
        id: string | undefined,
        o: { dir: string; feature: string; model?: string; memory: string; eval?: boolean; json?: boolean },
      ) =>
        guarded(deps, async () => {
          if (
            !FEATURE_PATTERN.test(o.feature) ||
            (o.memory !== "stateless" && o.memory !== "warm") ||
            (id && !ID_PATTERN.test(id))
          ) {
            deps.logErr("error: usage: nax advisor replay [id] -f <feature> [--memory stateless|warm]");
            return 2;
          }
          return runAdvisorReplay(
            {
              dir: o.dir,
              feature: o.feature,
              id,
              model: o.model,
              memory: o.memory,
              eval: o.eval === true,
              json: o.json === true,
            },
            replayDeps,
          );
        }),
    );
  return group;
}
