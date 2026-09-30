/**
 * The entry gate: the one place a gated command prompts for trust, persists the
 * answer, and records it for the process (US-002).
 *
 * Every gated command calls `ensureProjectTrusted` before it loads hooks, a
 * runtime, plugins or a TUI, so an untrusted repository is refused before any
 * repository-controlled code runs. The backstops at each execution site
 * (`assertTrusted`) then run against what this function recorded -- the gate
 * decides, the registry remembers (design R-4/R-5).
 *
 * Two folders are protected: the filesystem root and the home directory.
 * Trusting either covers everything a user owns, so neither may be granted by
 * answering this prompt -- `nax trust add <root> --force` is the deliberate
 * escape hatch -- and neither is offered as a `[p]arent` answer (design §9).
 */

import { homedir as osHomedir } from "node:os";
import { dirname } from "node:path";
import { NaxError } from "@/errors";
import { findCoveringEntry, isProtectedFolder, normalizeTrustPath } from "./match";
import { promptTrustChoice } from "./prompt";
import { markTrusted } from "./registry";
import { addTrustEntry, readTrustStore, trustStorePath, trustStoreUnreadableError } from "./store";
import type { TrustChoice } from "./types";

/**
 * Injectable seams: the question (also replaced directly by prompt tests) and
 * the home directory, which decides whether a folder is protected.
 */
export const _trustGateDeps: {
  prompt: (root: string, parent: string | null) => Promise<TrustChoice>;
  homedir: () => string;
} = {
  prompt: promptTrustChoice,
  homedir: () => osHomedir(),
};

/**
 * Ensure `root` may host repository-controlled code, prompting for a decision
 * when the operator is present.
 *
 * Fails closed at every step: an unreadable store refuses rather than starting
 * from an empty one, a protected folder refuses without prompting, and no TTY
 * (or a `no` answer) refuses with the command that would grant trust.
 */
export async function ensureProjectTrusted(root: string, options: { interactive: boolean }): Promise<void> {
  const normalizedRoot = await normalizeTrustPath(root);
  const store = await readTrustStore();
  if (store.state === "unparseable") throw trustStoreUnreadableError(trustStorePath(), store.reason);
  if (store.state === "ok" && findCoveringEntry(store.file.folders, normalizedRoot) !== null) {
    markTrusted(normalizedRoot);
    return;
  }
  if (isProtectedFolder(normalizedRoot, _trustGateDeps.homedir())) {
    throw refusal(normalizedRoot, `run: nax trust add ${normalizedRoot} --force`);
  }
  if (options.interactive) {
    const choice = await _trustGateDeps.prompt(normalizedRoot, offeredParent(normalizedRoot));
    if (choice !== "no") {
      // The operator may trust the parent instead; the root itself is what the
      // process records, so the decision covers the folder that was asked about.
      await addTrustEntry(choice === "parent" ? dirname(normalizedRoot) : normalizedRoot, "prompt");
      markTrusted(normalizedRoot);
      return;
    }
  }
  throw refusal(normalizedRoot, `run: nax trust add ${normalizedRoot}`);
}

/** `PROJECT_UNTRUSTED` for `root`, naming the command that would grant trust. */
function refusal(root: string, hint: string): NaxError {
  return new NaxError(`[trust] project not trusted: ${root} (${hint})`, "PROJECT_UNTRUSTED", {
    stage: "trust",
    root,
    hint,
  });
}

/** The parent to offer as `[p]arent`, or `null` when it is a protected folder. */
function offeredParent(root: string): string | null {
  const parent = dirname(root);
  return isProtectedFolder(parent, _trustGateDeps.homedir()) ? null : parent;
}
