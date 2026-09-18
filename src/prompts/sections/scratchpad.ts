/**
 * Agent scratchpad awareness section.
 *
 * Every op receives the scratchpad tools (`ScratchpadWrite` / `ScratchpadRead` /
 * `ScratchpadList`, src/tools/scratchpad.ts), confined to `SCRATCHPAD_DIR`. The
 * long analytical turns — implementer, rectifier, and both reviewers — would
 * otherwise never learn that directory exists: the standing `.nax/` immutability
 * rule (`buildNaxArtifactsSection`, which names the scratchpad as its one
 * exception) reads as a blanket prohibition on its own.
 *
 * Composed unconditionally, like the guardrail sections — the builders carry no
 * permission context. A project that does not grant the scratchpad tools still
 * gets the section; it just does not get the tools.
 */

import { SCRATCHPAD_DIR } from "@/tools";

export function buildScratchpadSection(): string {
  const dir = `${SCRATCHPAD_DIR}/`;
  return `# Scratchpad

You have a scratchpad at \`${dir}\` — a throwaway directory for working notes: notes to yourself,
command output you want to re-read, and intermediate lists. Write to it with \`ScratchpadWrite\`,
read back with \`ScratchpadRead\`, and list what is there with \`ScratchpadList\`. Paths are relative
to the scratchpad.

Its contents are wiped at the start of each run and are never committed. Nothing there survives the
run, reaches the repository, or is read by another step — treat every file as disposable, and
overwrite freely.

\`${dir}\` is the one directory under \`.nax/\` you may write to. Every other path under \`.nax/\`
must still never be moved, renamed, or deleted.`;
}
