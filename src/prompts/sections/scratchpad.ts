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
 * US-004 — rewrote the lifetime text. The old promise ("wiped at the start
 * of each run") was a half-truth that hid the load-bearing end-of-run wipe:
 * a successful run's scratchpad is removed before the next run starts, and
 * a failed run's scratchpad is retained for inspection (bounded by the
 * next run's start wipe). A future reader who only saw the start-of-run
 * sentence could infer "scratchpad only clears if I run nax twice" and miss
 * the end-of-run guarantee entirely. The new text covers all three
 * transitions so the lifetime is unambiguous.
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

Its contents are wiped when a run finishes and are never committed. Nothing there reaches the repository
or is read by another step. A failed run's scratchpad is retained for inspection — files an agent wrote
before failing outlive that run, and are cleared at the next run's start. Treat every file as disposable,
and overwrite freely.

To try a snippet that imports project code or dependencies, write it under \`${dir}\` with
\`ScratchpadWrite\` and run it from there: relative imports resolve from \`${dir}\`, so prefer the
project's package names or path aliases where it has them. A script written outside the repository,
such as in \`/tmp\`, cannot resolve the project's modules, and the file tools cannot write there.

\`${dir}\` is the one directory under \`.nax/\` you may write to. Every other path under \`.nax/\`
must still never be moved, renamed, or deleted.`;
}
