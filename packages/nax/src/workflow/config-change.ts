/**
 * US-002 (gate-config-route, #2897/#2898): the rule that lists the config changes a run may make for
 * a story's red gates. `quality.commands` run through a shell outside the permission gate, so no model
 * decides whether a command is safe — the allowed values are fixed here, from the package manifest as
 * committed at the story's base commit, and the advisor only picks one of them.
 *
 * US-003 adds `applyConfigChange`, the orchestrator-owned transaction that writes the chosen value into
 * the package's config file, reloads it, commits that one path and rolls everything back when a later
 * step fails. No session and no model ever writes config.
 */
import { join } from "node:path";
import type { ProtectedPathsPolicy } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { ConfigChangeCandidate, QualityCommandKey } from "@/advisor";
import { loadConfigForPackage, type NaxConfig, PROJECT_NAX_DIR, packageConfigCache } from "@/config";
import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";
import type { PackageRegistry, PackageView } from "@/runtime";
import { gitWithTimeout } from "@/utils/git";
import type { ConfigChangeAnswer } from "./advisor";
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
 * The module's test seam. `git` is the one process this file runs. An override here is read at call
 * time, never captured. US-003 adds the config reload a change goes through and the file reads and
 * writes it makes, so every failure a run cannot be made to produce (a throwing writer, a config that
 * stops validating, a commit that exits non-zero) is injectable.
 */
export const _configChangeDeps = {
  git: async (args: string[], cwd: string): Promise<{ stdout: string; stderr?: string; exitCode: number }> => {
    const { stdout, stderr, exitCode } = await gitWithTimeout(args, cwd);
    return { stdout, stderr, exitCode };
  },
  loadConfigForPackage: (projectDir: string, packageDir: string | undefined, from: NaxConfig): Promise<NaxConfig> =>
    loadConfigForPackage(projectDir, packageDir, from),
  readFile: (path: string): Promise<string> => Bun.file(path).text(),
  writeFile: async (path: string, content: string): Promise<void> => {
    await Bun.write(path, content);
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

/** The per-package config file name, under `.nax/mono/<pkg>/`. */
const PACKAGE_CONFIG_NAME = "config.json";

/** The shape a written config keeps: 2-space indentation and one trailing newline (US-003 AC-2). */
const JSON_INDENT = 2;
const TRAILING_NEWLINE = "\n";

/** The gate names in the order `GATE_COMMAND_KEY` declares them, for a reverse lookup. */
const GATE_NAMES = Object.keys(GATE_COMMAND_KEY) as readonly GateName[];

/**
 * Why a change was not applied. Every one of them leaves the tree exactly as it was found: the
 * refusals before the write touch nothing, and the three after it roll the file back.
 */
export type ConfigChangeRefusal =
  | "needs-confirm"
  | "root-package"
  | "not-offered"
  | "untracked"
  | "invalid-config"
  | "write-failed"
  | "commit-failed";

export type ConfigChangeOutcome =
  | { applied: true; key: QualityCommandKey; from: string | undefined; to: string; commit: string }
  | { applied: false; key: QualityCommandKey; to: string; reason: ConfigChangeRefusal };

export interface ApplyConfigChangeInput {
  /** Repo root: where `.nax/` lives and the cwd every git call runs in. */
  readonly projectDir: string;
  /** The story's package directory relative to `projectDir`; `""` for the repo root. */
  readonly packageDir: string;
  /** The story's base commit (`sc.base`) — the manifest `readBaseScripts` must read. */
  readonly base: string;
  readonly change: ConfigChangeAnswer;
  readonly currentConfig: NaxConfig;
  readonly registry: PackageRegistry;
}

/** `config` and `packageView` are present only when the change was applied. */
export interface ApplyConfigChangeResult {
  readonly outcome: ConfigChangeOutcome;
  readonly config?: NaxConfig;
  readonly packageView?: PackageView;
}

/**
 * Apply the config change the advisor picked, or refuse it without touching the tree.
 *
 * The transaction, in the order the refusals have to happen: confirmation and the root package
 * (`""`) are settled first because they decide whether the rest may run at all; then the rule is
 * recomputed from the same inputs it was built from, the file's git tracking is checked, and the one
 * key is rewritten; then the run reloads the config and the registry, and commits that single path.
 * Any failure from the write onwards restores the file's original bytes and refreshes the registry
 * again, so a refused change leaves neither a half-written file nor a gate reading a command the
 * file no longer declares.
 */
export async function applyConfigChange(input: ApplyConfigChangeInput): Promise<ApplyConfigChangeResult> {
  const refused = (reason: ConfigChangeRefusal): ApplyConfigChangeResult => ({
    outcome: { applied: false, key: input.change.key, to: input.change.to, reason },
  });
  if (input.change.needsHumanConfirm) return refused("needs-confirm");
  // `"."` is the root as well (`loadConfigForPackage` reads it that way), and the root config is
  // cached for the whole run, so a change there could only reach the next run.
  if (input.packageDir === "" || input.packageDir === ".") return refused("root-package");

  const path = packageConfigPath(input.packageDir);
  const written = await writeChangedConfig(input, path);
  if ("reason" in written) return refused(written.reason);

  const reloaded = await reloadChangedPackage(input, path, written.originalBytes);
  if ("reason" in reloaded) return refused(reloaded.reason);

  const commit = await commitConfigPath(input.projectDir, path, commitSubject(input.change, input.packageDir));
  if (commit === null) {
    // `commitConfigPath` staged the new bytes before the commit failed, so the rollback has to take
    // the path back out of the index as well — the working tree alone is not the whole change.
    await restoreAndRefresh({ ...input, path, originalBytes: written.originalBytes, unstage: true });
    return refused("commit-failed");
  }

  return {
    outcome: {
      applied: true,
      key: input.change.key,
      from: renderCommandSpec(input.currentConfig.quality.commands[input.change.key]),
      to: input.change.to,
      commit,
    },
    config: reloaded.config,
    packageView: reloaded.packageView,
  };
}

/** `.nax/mono/<pkg>/config.json`, repo-rooted. The advisor never chooses this path. */
function packageConfigPath(packageDir: string): string {
  return `${PROJECT_NAX_DIR}/mono/${packageDir}/${PACKAGE_CONFIG_NAME}`;
}

/** The commit subject, naming the key, the package and the advisor decision that chose it. */
function commitSubject(change: ConfigChangeAnswer, packageDir: string): string {
  return `chore(nax): set quality.commands.${change.key} for ${packageDir} (advisor ${change.decisionId})`;
}

/**
 * Steps 2–4: recompute the rule, check the file is tracked, rewrite the one key. Refuses before any
 * byte changes; a write that throws restores the bytes it may have half-written.
 */
async function writeChangedConfig(
  input: ApplyConfigChangeInput,
  path: string,
): Promise<{ originalBytes: string } | { reason: ConfigChangeRefusal }> {
  if (!(await changeIsOffered(input))) return { reason: "not-offered" };
  if (!(await isTrackedFile(input.projectDir, path))) return { reason: "untracked" };
  const originalBytes = await readConfigText(input.projectDir, path);
  if (originalBytes === null) return { reason: "write-failed" };
  const updated = withQualityCommand(originalBytes, input.change.key, input.change.to);
  if (updated === null) return { reason: "write-failed" };
  try {
    await _configChangeDeps.writeFile(join(input.projectDir, path), serializeConfig(updated));
  } catch (err) {
    getSafeLogger()?.warn("workflow", "Config change reverted: the config file could not be written", {
      packageDir: input.packageDir,
      error: errorMessage(err),
    });
    await restoreConfigBytes(input.projectDir, path, originalBytes);
    return { reason: "write-failed" };
  }
  return { originalBytes };
}

/**
 * Whether the rule still offers this exact key and value. Recomputed from the same inputs the menu
 * was built from — the base-commit scripts, the current commands and the gate for this key — so a
 * decision that reached `applyConfigChange` from anywhere else cannot name a value of its own.
 */
async function changeIsOffered(input: ApplyConfigChangeInput): Promise<boolean> {
  const scripts = await readBaseScripts(input.projectDir, input.base, input.packageDir);
  const candidates = configChangeCandidates({
    redGates: GATE_NAMES.filter((gate) => GATE_COMMAND_KEY[gate] === input.change.key),
    commands: input.currentConfig.quality.commands,
    scripts,
  });
  return candidates.some((c) => c.key === input.change.key && c.to === input.change.to);
}

/** Whether git tracks the file: an untracked config has no committed state for the change to amend. */
async function isTrackedFile(projectDir: string, path: string): Promise<boolean> {
  try {
    const result = await _configChangeDeps.git(["ls-files", "--error-unmatch", "--", path], projectDir);
    return result.exitCode === 0;
  } catch {
    // A git that cannot answer is no evidence that the file is tracked, and guessing "yes" would
    // write a file whose change can never be committed.
    return false;
  }
}

/** The config file's text, or `null` when it cannot be read. */
async function readConfigText(projectDir: string, path: string): Promise<string | null> {
  try {
    return await _configChangeDeps.readFile(join(projectDir, path));
  } catch {
    // Nothing was read, so there is nothing that could be preserved or restored.
    return null;
  }
}

/**
 * The parsed config with `quality.commands.<key>` set, creating an absent `quality` or `commands`
 * object, and leaving every other key as it was. `null` when the file is not JSON.
 */
function withQualityCommand(text: string, key: QualityCommandKey, to: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A config that is not JSON cannot be edited key-by-key; rewriting it wholesale would drop
    // whatever it holds.
    return null;
  }
  const root = isRecord(parsed) ? parsed : {};
  const quality = isRecord(root.quality) ? root.quality : {};
  const commands = isRecord(quality.commands) ? quality.commands : {};
  return { ...root, quality: { ...quality, commands: { ...commands, [key]: to } } };
}

/** 2-space-indented JSON ending in one newline, the format the rest of `.nax/` keeps. */
function serializeConfig(document: Record<string, unknown>): string {
  return `${JSON.stringify(document, null, JSON_INDENT)}${TRAILING_NEWLINE}`;
}

/**
 * Step 5: reload the run's config and the registry entry for the package. The per-package cache is
 * cleared first — it holds the pre-change config, and serving that to the next gate would undo the
 * change — then either the new config and view come back, or the file is rolled back.
 */
async function reloadChangedPackage(
  input: ApplyConfigChangeInput,
  path: string,
  originalBytes: string,
): Promise<{ config: NaxConfig; packageView: PackageView } | { reason: ConfigChangeRefusal }> {
  packageConfigCache.clear();
  try {
    const config = await _configChangeDeps.loadConfigForPackage(
      input.projectDir,
      input.packageDir,
      input.currentConfig,
    );
    const packageView = await input.registry.refresh(input.packageDir);
    return { config, packageView };
  } catch (err) {
    getSafeLogger()?.warn("workflow", "Config change reverted: the written config did not resolve", {
      packageDir: input.packageDir,
      error: errorMessage(err),
    });
    await restoreAndRefresh({ ...input, path, originalBytes });
    return { reason: "invalid-config" };
  }
}

/**
 * Step 6: commit that one path, the way `commitLedger` does it — a pathspec commit, so an edit
 * staged by someone else never rides along. Returns the new HEAD sha, or `null` when git refused.
 *
 * A `git commit` that stages nothing (the file already declared the value) also exits non-zero, and
 * that is the honest answer: the change promised a commit and there is none, so the caller rolls the
 * file back rather than reporting success.
 */
async function commitConfigPath(projectDir: string, path: string, message: string): Promise<string | null> {
  const added = await _configChangeDeps.git(["add", "--", path], projectDir);
  if (added.exitCode !== 0) return null;
  const commit = await _configChangeDeps.git(["commit", "--no-verify", "-m", message, "--", path], projectDir);
  if (commit.exitCode !== 0) return null;
  const head = await _configChangeDeps.git(["rev-parse", "HEAD"], projectDir);
  // The commit landed; a sha that cannot be read afterwards is only a less useful detail, never a
  // reason to report the applied change as failed.
  return head.exitCode === 0 ? head.stdout.trim() : "";
}

/**
 * Put the file back and make the run agree with it again: the per-package cache is cleared (it holds
 * the config built from the reverted bytes) and the registry re-reads the restored override, so no
 * later gate runs the command the change tried to set.
 *
 * `unstage` is set when the caller had already staged the new bytes (the commit step): the path's
 * index entry goes back to HEAD, which leaves the restored working-tree file clean and any unrelated
 * staged edit untouched. Both rollback steps throw when they cannot be completed — a refusal must
 * never stand in for a rollback that did not happen (see {@link rollbackFailed}).
 */
async function restoreAndRefresh(
  args: ApplyConfigChangeInput & { path: string; originalBytes: string; unstage?: boolean },
): Promise<void> {
  await restoreConfigBytes(args.projectDir, args.path, args.originalBytes);
  if (args.unstage === true) await unstageConfigPath(args.projectDir, args.path);
  packageConfigCache.clear();
  try {
    await args.registry.refresh(args.packageDir);
  } catch (err) {
    // Not a rollback failure: the file is back to its original bytes. The refusal the caller needs
    // still goes out, and a later resolve() re-reads the restored file.
    getSafeLogger()?.warn("workflow", "Config change restored, but the package registry did not refresh", {
      packageDir: args.packageDir,
      error: errorMessage(err),
    });
  }
}

/**
 * Write the original bytes back. Deliberately not through the seam a failed write went through, and
 * loud when it cannot land: a caller that reported an ordinary refusal here would be claiming a
 * clean tree it does not have.
 */
async function restoreConfigBytes(projectDir: string, path: string, originalBytes: string): Promise<void> {
  try {
    // `_configChangeDeps.writeFile` is exactly what failed in the write-failed case, possibly after
    // truncating the destination; the rollback must land whatever that writer does next.
    await Bun.write(join(projectDir, path), originalBytes);
  } catch (err) {
    throw rollbackFailed(path, "restore the config file's original bytes", err);
  }
}

/** Reset the path's index entry to HEAD, leaving the working tree and every other staged path alone. */
async function unstageConfigPath(projectDir: string, path: string): Promise<void> {
  const step = "unstage the config file";
  let reset: { stdout: string; stderr?: string; exitCode: number };
  try {
    reset = await _configChangeDeps.git(["reset", "-q", "--", path], projectDir);
  } catch (err) {
    throw rollbackFailed(path, step, err);
  }
  if (reset.exitCode !== 0) throw rollbackFailed(path, step, reset.stderr ?? reset.stdout);
}

/**
 * A rollback that did not complete. Distinct from every `ConfigChangeRefusal` on purpose: those say
 * "nothing changed", and this one says the opposite — the tree may still hold the new (or a
 * half-written) config, so the caller must stop and say so rather than run on.
 */
function rollbackFailed(path: string, step: string, cause: unknown): NaxError {
  return new NaxError(`Config change rollback could not ${step}: ${path}`, "CONFIG_CHANGE_ROLLBACK_FAILED", {
    stage: "workflow",
    path,
    step,
    cause,
  });
}
