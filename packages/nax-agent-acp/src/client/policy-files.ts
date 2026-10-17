/**
 * The policy files Cursor and pi read (SPEC-cursor-pi-acp-read-only US-004).
 * Neither agent reads nax's rules directly: Cursor loads a `cli-config.json` from
 * `CURSOR_CONFIG_DIR` and pi loads an extension with `-e` and takes its tool
 * allowlist from `--tools`, so nax writes the files and points the process's
 * environment at them (rule-policy.ts).
 *
 * Each file is content-addressed — the first 16 hex characters of the SHA-256 of
 * its body — and written atomically through a temporary name in its target
 * directory, on every launch: Cursor rewrites its config itself, and a rewrite
 * replaces a planted or half-written file. The state directory's owner is the
 * trust boundary; this package creates the directories 0700 and never reads back
 * what is already there.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { backendUnavailable } from "#src/client/errors";

/** Every file-system call the writers make; a test overrides them before any real write. */
export interface PolicyFileDeps {
  mkdir(path: string, options: { readonly recursive: true; readonly mode: number }): Promise<unknown>;
  writeFile(path: string, content: string): Promise<unknown>;
  chmod(path: string, mode: number): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
}

export const _policyFilesDeps: PolicyFileDeps = { mkdir, writeFile, chmod, rename };

/** The two pi files: the gate extension pi loads, and the wrapper `PI_ACP_PI_COMMAND` names. */
export type PiPolicyFile = "shell-gate" | "wrapper";

const PI_EXTENSIONS: Readonly<Record<PiPolicyFile, string>> = Object.freeze({ "shell-gate": ".ts", wrapper: ".sh" });

/** Nothing here is readable by another user: the directory is ours, the policy files are ours. */
const DIR_MODE = 0o700;
const CURSOR_CONFIG_MODE = 0o600;

/** The content-addressed part of a policy path. */
function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `target` with `content`, atomically and every time. The chmod runs on the
 * temporary file before the rename, so the umask cannot narrow the mode and no
 * reader ever sees a partial file. The temporary name is unique per call: two
 * opens racing on the same content (two sessions, one process) never rename each
 * other's file away. Any failure refuses the open — the caller has launched
 * nothing yet — naming the path that could not be written.
 */
async function writeAtomic(target: string, content: string, mode: number): Promise<void> {
  const dir = dirname(target);
  const temp = join(dir, `${basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await _policyFilesDeps.mkdir(dir, { recursive: true, mode: DIR_MODE });
    await _policyFilesDeps.writeFile(temp, content);
    await _policyFilesDeps.chmod(temp, mode);
    await _policyFilesDeps.rename(temp, target);
  } catch (err) {
    throw backendUnavailable(`the read-only policy file "${target}" could not be written: ${messageOf(err)}`, {
      path: target,
    });
  }
}

/** Cursor's isolated config: `<stateDir>/cursor/<h>/cli-config.json`. Returns the directory to point CURSOR_CONFIG_DIR at. */
export async function writeCursorPolicy(stateDir: string, content: string): Promise<string> {
  const dir = join(stateDir, "cursor", digest(content));
  await writeAtomic(join(dir, "cli-config.json"), content, CURSOR_CONFIG_MODE);
  return dir;
}

/** pi's `<stateDir>/pi/<name>-<h><ext>`; returns the file path. */
export async function writePiFile(
  stateDir: string,
  name: PiPolicyFile,
  content: string,
  mode: number,
): Promise<string> {
  const target = join(stateDir, "pi", `${name}-${digest(content)}${PI_EXTENSIONS[name]}`);
  await writeAtomic(target, content, mode);
  return target;
}
