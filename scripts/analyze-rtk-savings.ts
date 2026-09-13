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
