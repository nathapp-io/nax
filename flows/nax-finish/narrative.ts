/**
 * The PR body's "What changed" section — prompt, parse, and the chain that
 * decides what text (if any) the section carries.
 *
 * Prompt building lives here rather than in `src/prompts/builders/` because
 * `flows/` is loaded by acpx in its own Node process and imports nothing from
 * `src/`. `review-prompts.ts` sits beside this file for the same reason.
 *
 * `resolveNarrative` is a standalone pure function, not flow wiring, because
 * the acp node that produces the model text cannot be executed in tests. The
 * degradation chain is the part that must never break, so it lives where a
 * test can reach it.
 */

/** Longest narrative rendered into a PR body, in characters, including the ellipsis. */
export const NARRATIVE_MAX_CHARS = 4000;

const TRUNCATION_SUFFIX = "…";

/** Headings a spec uses for its lead paragraph, in priority order. */
const SUMMARY_HEADINGS = ["summary", "overview"] as const;

/**
 * Prompt for the narrative node.
 *
 * Two jobs: point the agent at the real diff (never the spec, which describes
 * intent rather than what shipped), and forbid restating the sections the body
 * already renders deterministically.
 */
export function buildNarrativePrompt(args: { base: string }): string {
  return [
    'Write the "What changed" section of a pull request body.',
    "",
    `Read the branch diff yourself: \`git diff ${args.base}...HEAD\`.`,
    "Read whatever source files you need to understand it.",
    "",
    "The PR body ALREADY renders these deterministically, from run artifacts:",
    "- a Stories table (story id, title, acceptance-criteria count)",
    "- a Verification block (acceptance status, regression status, gates run, diffstat)",
    "- a Review rounds block (every finding, with its severity)",
    "- an Out of scope list",
    "",
    "Do NOT restate, summarise, or refer to any of them. Repeating them is how the",
    "written and the generated halves of this body drift apart.",
    "",
    "Describe what the change actually does, in prose: the shape of the change, and",
    "anything a reviewer would otherwise have to reconstruct from the diff by hand.",
    `Hard limit: ${NARRATIVE_MAX_CHARS} characters.`,
    "Do not write a heading — the heading is added for you.",
    "Return the prose only. No JSON, no code fences, no preamble.",
  ].join("\n");
}

/**
 * `parse` for the narrative acp node.
 *
 * Never throws. A throw inside `parse` fails the node, and acpx has no error
 * edge — see `verdict.ts`. Here that would mean the flow dying *after* the PR
 * was already opened.
 */
export function parseNarrative(text: string): string {
  return typeof text === "string" ? text.trim() : "";
}

function truncate(text: string): string {
  if (text.length <= NARRATIVE_MAX_CHARS) return text;
  return text.slice(0, NARRATIVE_MAX_CHARS - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

/**
 * Pick the narrative text, best source first.
 *
 * The spec summary is the fallback rather than the primary source because a
 * spec describes intent: when an implementation deviates and the deviation is
 * accepted, a spec-derived narrative confidently describes code that does not
 * exist.
 *
 * `undefined` means "render no section at all" — never an empty heading.
 */
export function resolveNarrative(agentText: string | undefined, specSummary: string | null): string | undefined {
  const fromAgent = agentText?.trim();
  if (fromAgent) return truncate(fromAgent);
  const fromSpec = specSummary?.trim();
  if (fromSpec) return truncate(fromSpec);
  return undefined;
}

function sectionBody(lines: string[], heading: string): string | null {
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return body.length > 0 ? body : null;
}

/**
 * First `## Summary` or `## Overview` block in the spec, or `null`.
 *
 * Both headings are accepted because both occur in this repository's real
 * specs — five of six use `## Summary`, the older `plugin-001` uses
 * `## Overview`. Fail-open on every read error: a missing or unreadable spec
 * costs the section, never the PR.
 */
export async function readSpecSummary(
  specPath: string | undefined,
  readText: (path: string) => Promise<string | null>,
): Promise<string | null> {
  if (!specPath) return null;
  let text: string | null;
  try {
    text = await readText(specPath);
  } catch {
    return null;
  }
  if (text === null) return null;
  const lines = text.split(/\r?\n/);
  for (const heading of SUMMARY_HEADINGS) {
    const body = sectionBody(lines, heading);
    if (body !== null) return body;
  }
  return null;
}
