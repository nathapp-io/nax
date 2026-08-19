/**
 * The PR body's "What changed" section — prompt, parse, the degradation
 * chain, and the `RunOperation` that drives the narrative session role.
 *
 * `resolveNarrative` is a standalone pure function, not folded into `parse`,
 * because the op's reply is only one of its two inputs — the caller (plan 4)
 * also has a spec summary to fall back to, read independently of the op call.
 * The degradation chain is the part that must never break, so it lives where
 * a test can reach it without an agent in the loop.
 */
import type { ConfiguredModel } from "@/config";
import { finishConfigSelector } from "@/config";
import type { FinishConfig } from "@/config/selectors";
import { TITLE_CLOSE_TAG, TITLE_MAX_CHARS, TITLE_OPEN_TAG, parseTitle } from "../finish/pr-title";
import type { RunOperation } from "./types";

/** Longest narrative rendered into a PR body, in characters, including the ellipsis. */
export const NARRATIVE_MAX_CHARS = 4000;

const TRUNCATION_SUFFIX = "…";

/**
 * Sentinel wrapping the prose, so `parseNarrative` has an explicit anchor
 * rather than an inferred one.
 *
 * The op's reply is the concatenation of every agent message chunk in the
 * turn. This node reads the diff with tools, so the agent's between-tool-call
 * narration ("Now I have a clear picture. Let me check…") is structurally
 * part of that string. A prompt asking for "no preamble" cannot prevent it;
 * only a delimiter can.
 *
 * A sentinel rather than the JSON contract the sibling ops use: this payload
 * is multi-paragraph prose about code, full of backticks, quotes and
 * newlines. Literal newlines inside a JSON string are invalid JSON, so a JSON
 * contract would fail on exactly the inputs this node exists to carry.
 */
const OPEN_TAG = "<narrative>";
const CLOSE_TAG = "</narrative>";

/**
 * Headings the agent emits despite being told not to. Anchors the fallback
 * strip when the sentinel is absent: everything up to and including the
 * heading is preamble.
 */
const HEADING_RE = /^[\s\S]*?(?:\*\*What changed\*\*|##+\s*What changed)\s*/i;

/** A `<title>…</title>` block, closed or not — removed wholesale from the prose. */
const TITLE_BLOCK_RE = new RegExp(`${TITLE_OPEN_TAG}[\\s\\S]*?(?:${TITLE_CLOSE_TAG}|$)`, "gi");

/** Headings a spec uses for its lead paragraph, in priority order. */
const SUMMARY_HEADINGS = ["summary", "overview"] as const;

/**
 * Prompt for the narrative op.
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
    "",
    "Then write the pull request title: a conventional-commit subject describing",
    `the change (\`fix: …\`, \`feat: …\`, \`refactor: …\`), at most ${TITLE_MAX_CHARS} characters.`,
    "Describe what the change does — not the feature's name, which the reader",
    "can already see on the branch.",
    "",
    "Reply with exactly these two blocks, and write nothing after the last one:",
    `${TITLE_OPEN_TAG}conventional-commit subject${TITLE_CLOSE_TAG}`,
    `${OPEN_TAG}the prose${CLOSE_TAG}`,
    "",
    "Everything outside those tags is discarded, so anything you say while working",
    "through the diff is safe to leave where it falls.",
  ].join("\n");
}

/**
 * `parse` for the narrative op's reply.
 *
 * Never throws. `finishTerminal` calls this after the PR is already
 * promoted — a throw here would fail the whole finish over cosmetic prose,
 * so every branch below degrades instead of rejecting.
 *
 * Three tiers, strongest anchor first:
 *   1. Sentinel — the contract the prompt asks for.
 *   2. Heading — the agent ignored the sentinel but still wrote
 *      `**What changed**`, which marks where its preamble stopped.
 *   3. Bare trim — no anchor available; better a narrative with preamble than
 *      no narrative at all.
 */
export function parseNarrative(text: string): string {
  if (typeof text !== "string") return "";

  // Last opening tag, not the first: if the agent narrates the tag before
  // emitting it for real ("I'll wrap this in <narrative>"), the real one wins.
  const open = text.lastIndexOf(OPEN_TAG);
  if (open !== -1) {
    const from = open + OPEN_TAG.length;
    const close = text.indexOf(CLOSE_TAG, from);
    const inner = (close === -1 ? text.slice(from) : text.slice(from, close)).trim();
    if (inner) return inner;
  }

  // Strip tag markers before the heading pass: an empty or malformed sentinel
  // falls through to here, and leftover `<narrative>` markup in a PR body is
  // worse than the preamble this function exists to remove. The title block
  // goes entirely — tags and content — since it is not part of the prose.
  const untagged = text.replace(TITLE_BLOCK_RE, "").split(OPEN_TAG).join("").split(CLOSE_TAG).join("");
  return untagged.replace(HEADING_RE, "").trim();
}

/** What the narrative op returns: the prose, and the title to rename the PR to. */
export interface FinishNarrativeOutput {
  narrative: string;
  title?: string;
}

/**
 * `parse` for the narrative op.
 *
 * Both halves are optional to the caller: a missing title leaves the PR on
 * `feat: <feature>`, and missing prose leaves the body's mechanical sections
 * alone. Never throws, for the reason `parseNarrative` documents.
 */
export function parseNarrativeNode(text: string): FinishNarrativeOutput {
  return { narrative: parseNarrative(text), title: parseTitle(text) };
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
 *
 * `readText` is an injected reader, kept as an explicit parameter rather than
 * a direct `Bun.file` call — it is this function's test seam. The real caller
 * (plan 4) supplies `(path) => Bun.file(path).text().catch(() => null)`.
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

export interface FinishNarrativeInput {
  /** The diff's base ref — `git diff <base>...HEAD`. */
  base: string;
  /** Narrator selection, resolved by the caller from config (D3.6). */
  model?: ConfiguredModel;
  timeoutMs?: number;
}

export const finishNarrativeOp: RunOperation<FinishNarrativeInput, FinishNarrativeOutput, FinishConfig> = {
  kind: "run",
  name: "finish-narrative",
  stage: "complete",
  config: finishConfigSelector,
  session: { role: "finish-narrative", lifetime: "fresh" },
  model: (input) => input.model,
  timeoutMs: (input) => input.timeoutMs,
  build(input, _ctx) {
    const content = buildNarrativePrompt({ base: input.base });
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content, overridable: false },
    };
  },
  parse(output, _input, _ctx) {
    return parseNarrativeNode(output);
  },
  /**
   * No `retry`: an unusable narrative reply — no sentinel, no heading, just
   * junk — is dropped, never re-prompted. Unlike the review and fix ops, this
   * prose is not load-bearing: the PR body has a deterministic fallback
   * (`resolveNarrative` falls through to the spec summary, then to nothing)
   * when the agent produces nothing usable, and re-prompting for cosmetic
   * copy would spend a turn the machine does not need. Do not add one back.
   */
  /**
   * `recover` here is NOT cosmetic bookkeeping, unlike it might look next to
   * a "the prose is optional" op. `finishTerminal` (in `machine.ts`) calls
   * `ops.narrate` *after* the PR has already been promoted and *before*
   * `state.status` is set. If this throws and nothing catches it below the
   * op boundary, a fully green, already-promoted run gets reported as
   * `escalated` — actively wrong, not merely missing a nice-to-have. An
   * empty narrative is always a safe, honest answer: `resolveNarrative` and
   * the PR body renderer already treat "no narrative" as a normal case.
   */
  async recover() {
    return { narrative: "" };
  },
};
