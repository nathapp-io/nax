/**
 * The promotion text and forge argv (SPEC-workflow-record-promote, US-003): ticking the
 * "Before marking ready" checklist of a draft PR, the single evidence comment that records why each
 * open item is closed, and the three forge command lines `nax workflow promote --yes` runs.
 *
 * Everything here is pure — it takes a PR body or the recorded entries and returns text or an argv,
 * and runs nothing. Reading the PR before the write and running the commands belong to the command
 * (US-004/US-005), so these stay unit-testable without a forge.
 *
 * `pr-body-safe` is imported as a sibling leaf: the `@/finish` barrel it used to reach
 * `escapeInline` through loads `src/finish/context.ts`, and that imports `@/cli`, which would close
 * a runtime import cycle back to `src/workflow/`.
 */
import type { ForgeKind } from "@/forge";
import type { DecisionEntry } from "./decisions-sidecar";
import { safeInline } from "./pr-body-safe";

const UNTICKED = "- [ ] ";
const TICKED = "- [x] ";
const EVIDENCE_HEADING = "## Resolved before ready";

/**
 * The `- [ ] **<id>**` prefix a line must start with to be that entry's checklist line. The id is
 * interpolated as a plain string, never as a pattern: `B1` therefore cannot match `**B10**`, and an
 * id such as `_run:ci` needs no escaping. `openItemLine` (`pr-body.ts`) writes exactly this prefix.
 */
function checklistPrefix(id: string): string {
  return `${UNTICKED}**${id}**`;
}

/**
 * The suffix a tick appends to the entry's line. `waived` and `overridden` carry the human's reason,
 * so it is neutralised the same way the body's own text is.
 */
function tickSuffix(entry: DecisionEntry): string {
  switch (entry.disposition) {
    case "fixed":
      // A `fixed` entry is written with a sha (US-001 validates that); degrade rather than print one.
      return entry.sha === undefined ? " — fixed" : ` — fixed in ${entry.sha}`;
    case "verified":
      return " — verified";
    case "confirmed":
      return " — confirmed";
    case "waived":
      return ` — waived: ${safeInline(entry.reason)}`;
    case "overridden":
      return ` — overridden: ${safeInline(entry.reason)}`;
  }
}

/** The first entry still waiting for a tick whose prefix `line` starts with, if any. */
function pendingEntryFor(line: string, pending: ReadonlyMap<string, DecisionEntry>): DecisionEntry | undefined {
  for (const entry of pending.values()) {
    if (line.startsWith(checklistPrefix(entry.id))) return entry;
  }
  return undefined;
}

/**
 * Ticks the checklist line of each entry in `body`: only the first line of a matching entry changes
 * (`[ ]` becomes `[x]` and the disposition's suffix is appended), its indented continuation lines and
 * every other line are returned verbatim, and an entry whose id is on no checklist line — as well as
 * one whose line is already ticked — is ignored. `ticked` names the ids in the order their lines
 * appear, which is the order a reader of the body meets them.
 */
export function tickChecklist(body: string, entries: readonly DecisionEntry[]): { body: string; ticked: string[] } {
  const pending = new Map(entries.map((entry) => [entry.id, entry] as const));
  const ticked: string[] = [];
  const lines = body.split("\n").map((line) => {
    const entry = pendingEntryFor(line, pending);
    if (entry === undefined) return line;
    pending.delete(entry.id);
    ticked.push(entry.id);
    return `${TICKED}${line.slice(UNTICKED.length)}${tickSuffix(entry)}`;
  });
  return { body: lines.join("\n"), ticked };
}

/** `- <id> (<kind>) <disposition>: <reason>`, with ` (<sha>)` appended for a `fixed` entry. */
function evidenceLine(entry: DecisionEntry): string {
  const id = safeInline(entry.id);
  const kind = safeInline(entry.kind);
  const reason = safeInline(entry.reason);
  const sha = entry.disposition === "fixed" && entry.sha !== undefined ? ` (${entry.sha})` : "";
  return `- ${id} (${kind}) ${entry.disposition}: ${reason}${sha}`;
}

/**
 * The one comment `nax workflow promote --yes` posts: every entry's id, kind, disposition and reason
 * on one line, so a reviewer reads what was ruled without opening the sidecar.
 */
export function evidenceComment(entries: readonly DecisionEntry[]): string {
  return [EVIDENCE_HEADING, "", ...entries.map(evidenceLine)].join("\n");
}

/** Argv that rewrites the PR body from a file-free argument, one spelling per forge. */
export function editBodyArgv(forge: ForgeKind, prRef: string, body: string): string[] {
  return forge === "github"
    ? ["gh", "pr", "edit", prRef, "--body", body]
    : ["glab", "mr", "update", prRef, "--description", body];
}

/** Argv that posts a comment on the PR, one spelling per forge. */
export function commentArgv(forge: ForgeKind, prRef: string, text: string): string[] {
  return forge === "github"
    ? ["gh", "pr", "comment", prRef, "--body", text]
    : ["glab", "mr", "note", "create", prRef, "-m", text];
}

/** Argv that marks the PR ready for review, one spelling per forge. */
export function markReadyArgv(forge: ForgeKind, prRef: string): string[] {
  return forge === "github" ? ["gh", "pr", "ready", prRef] : ["glab", "mr", "update", prRef, "--ready"];
}
