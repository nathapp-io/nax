/**
 * US-002 (gate-config-route, #2897/#2898): the rule that lists the config changes a run may make for
 * a story's red gates. `quality.commands` run through a shell outside the permission gate, so no model
 * decides whether a command is safe — the allowed values are fixed here, from the package manifest as
 * committed at the story's base commit, and the advisor only picks one of them.
 */
import type { ProtectedPathsPolicy } from "@nathapp/nax-agent";
import type { ConfigChangeCandidate, QualityCommandKey } from "@/advisor";
import { gitWithTimeout } from "@/utils/git";
import type { GateName } from "./types";

/** How nax writes a list command as one line — what a human recognises and would type. */
const COMMAND_JOINER = " && ";

/**
 * One line for a declared command: a string exactly as written, a list as its entries joined with
 * ` && `, an undeclared command as `undefined`. The workflow needs the literal bytes — a candidate is
 * compared against the key's current command and US-003 writes the chosen value into config — so no
 * entry is trimmed. The shared `@nathapp/nax-agent/internal` renderer normalises instead (it trims
 * entries and drops blanks), which is right for prompt surfaces and wrong for a value that has to match
 * or be written verbatim.
 */
export function renderCommandSpec(spec: string | readonly string[] | undefined): string | undefined {
  return typeof spec === "string" ? spec : spec?.join(COMMAND_JOINER);
}

/** The gate that went red, and the `quality.commands` key whose command it runs. */
export const GATE_COMMAND_KEY: Readonly<Record<GateName, QualityCommandKey>> = {
  lint: "lint",
  typecheck: "typecheck",
  scoped: "testScoped",
  "full-suite": "test",
};

/**
 * The module's test seam. `git` is the one process this file runs; US-003 adds the config load and the
 * file reads/writes a change needs. An override here is read at call time, never captured.
 */
export const _configChangeDeps = {
  git: async (args: string[], cwd: string): Promise<{ stdout: string; stderr?: string; exitCode: number }> => {
    const { stdout, stderr, exitCode } = await gitWithTimeout(args, cwd);
    return { stdout, stderr, exitCode };
  },
};

/** The manifest a package's scripts live in. */
const PACKAGE_MANIFEST = "package.json";

/** The `{{files}}` placeholder a scoped test command puts its file list in (`scoped-selection.ts`). */
const TEST_FILES_PLACEHOLDER = "{{files}}";

/** What the rule reads: the story's red gates, its resolved commands, its base-commit scripts. */
interface CandidateInput {
  /** The gates whose state is `"red"` in the story loop's last gate run, in that run's order. */
  readonly redGates: readonly GateName[];
  /** The story's resolved `quality.commands`; a list command is never equal to a candidate. Absent: none declared. */
  readonly commands?: Readonly<Partial<Record<QualityCommandKey, string | readonly string[]>>>;
  /** `<pkg>/package.json`'s `scripts` at the story's base commit, in the object's key order. */
  readonly scripts: Readonly<Record<string, string>>;
}

/**
 * Every config change the rule allows for these red gates, grouped in the gate order given and, within
 * a gate, in the manifest's script key order. A candidate equal to the key's current string command is
 * dropped — changing it to itself is no change — and the first script to offer a value keeps it.
 */
export function configChangeCandidates(input: CandidateInput): ConfigChangeCandidate[] {
  const seen = new Set<string>();
  const candidates: ConfigChangeCandidate[] = [];
  for (const gate of input.redGates) {
    const key = GATE_COMMAND_KEY[gate];
    for (const [script, value] of Object.entries(input.scripts)) {
      for (const to of candidateValues(key, value)) {
        if (equalsCommand(input.commands?.[key], to)) continue;
        const id = `${key}\u0000${to}`;
        if (seen.has(id)) continue;
        seen.add(id);
        candidates.push({ key, to, script });
      }
    }
  }
  return candidates;
}

/**
 * The values one script offers for `key`: its own value, and for `testScoped` that value with the file
 * placeholder, which is the form the scoped gate needs to receive its files.
 */
function candidateValues(key: QualityCommandKey, value: string): string[] {
  return key === "testScoped" ? [value, `${value} ${TEST_FILES_PLACEHOLDER}`] : [value];
}

/** Whether a resolved command is this exact string; a list command matches no candidate. */
function equalsCommand(spec: string | readonly string[] | undefined, value: string): boolean {
  return typeof spec === "string" && spec === value;
}

/**
 * The `scripts` object of `<packageDir>/package.json` as committed at `base`, in the object's key
 * order. The base commit is what makes the rule session-proof: a script a session adds during this
 * story is not in the base manifest, so it is never offered. Every failure — a manifest that is
 * missing, unreadable or not JSON, a git that exits non-zero or throws, no `scripts` object at all —
 * yields `{}`, which leaves the advisor `answer` and `hold` and nothing to apply.
 */
export async function readBaseScripts(
  projectDir: string,
  base: string,
  packageDir: string,
): Promise<Record<string, string>> {
  const path = packageDir === "" ? PACKAGE_MANIFEST : `${packageDir}/${PACKAGE_MANIFEST}`;
  let stdout: string;
  try {
    const result = await _configChangeDeps.git(["show", `${base}:${path}`], projectDir);
    if (result.exitCode !== 0) return {};
    stdout = result.stdout;
  } catch {
    // git could not answer at all (a bad object, a spawn failure): nothing is offered.
    return {};
  }
  return scriptsOf(stdout);
}

/** The manifest's `scripts`, string values only; a manifest with no `scripts` object has none. */
function scriptsOf(manifest: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest);
  } catch {
    // Not JSON: a conflicted or truncated manifest declares no scripts.
    return {};
  }
  if (!isRecord(parsed) || !isRecord(parsed.scripts)) return {};
  const scripts: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed.scripts)) {
    if (typeof value === "string") scripts[name] = value;
  }
  return scripts;
}

/** A plain JSON object, not an array and not `null`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The paths no session may write, as the advisor is told them: the project state dir and the
 * credential dir with a trailing separator, then the trust store file verbatim. A policy that omits
 * one of them contributes nothing for it, so the list is always paths nax can name.
 */
export function protectedPathList(policy: ProtectedPathsPolicy): string[] {
  return [
    ...(policy.projectStateDir ? [`${policy.projectStateDir}/`] : []),
    ...(policy.credentialDir ? [`${policy.credentialDir}/`] : []),
    ...(policy.trustStoreFile ? [policy.trustStoreFile] : []),
  ];
}
