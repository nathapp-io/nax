#!/usr/bin/env bun
/**
 * Generates `src/finish/review/prompts.gen.ts` from the canonical reviewer
 * prose in `src/finish/review/references/*.md`.
 *
 * The `.md` files are the source of truth (they were derived once,
 * byte-for-byte, from `flows/nax-finish/review-prompts.ts`'s template-literal
 * constants — see that file's history). This script only re-escapes them
 * back into TypeScript template literals; it never edits the `.md` files.
 *
 * Usage:
 *   bun run scripts/generate-review-prompts.ts
 *
 * `scripts/check-review-prompts-generated.ts` regenerates the same output in
 * memory and fails the build if it drifts from the committed
 * `prompts.gen.ts` — run that after editing any `.md` file here, or via
 * `bun run gen:review-prompts` to update it in place.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const REFERENCES_DIR = join(ROOT, "src", "finish", "review", "references");
const OUTPUT_FILE = join(ROOT, "src", "finish", "review", "prompts.gen.ts");

const OUTPUT_FORMAT_HEADING = "## Output format";

/**
 * Escapes a plain-text string for embedding inside a TypeScript template
 * literal, in ONE left-to-right pass over the three characters/sequences
 * that need escaping: backslash, backtick, and `${`. A single regex pass
 * (rather than three independent `.replace()` calls) avoids re-scanning text
 * a prior replacement introduced.
 */
export function escapeForTemplateLiteral(text: string): string {
  return text.replace(/\\|`|\$\{/g, (match) => {
    if (match === "\\") return "\\\\";
    if (match === "`") return "\\`";
    return "\\${";
  });
}

/** Splits worker-protocol.md into its mechanics prefix and output-format section. */
export function splitWorkerProtocol(wholeText: string): { mechanics: string; outputFormatSection: string } {
  const headingIndex = wholeText.indexOf(OUTPUT_FORMAT_HEADING);
  if (headingIndex === -1) {
    throw new Error(`worker-protocol.md is missing the "${OUTPUT_FORMAT_HEADING}" heading`);
  }
  return {
    mechanics: wholeText.slice(0, headingIndex),
    outputFormatSection: wholeText.slice(headingIndex),
  };
}

/** Extracts the first fenced code block (including its ``` fences) from `text`. */
export function extractFirstFencedBlock(text: string): string {
  const match = text.match(/```[\s\S]*?```/);
  if (!match) throw new Error("No fenced block found in the Output format section");
  return match[0];
}

/**
 * Reads the three canonical `.md` files and returns the exact text
 * `prompts.gen.ts` should contain. Shared by this script's `main()` and by
 * `scripts/check-review-prompts-generated.ts`, so the two can never drift
 * from each other by construction.
 */
export async function generatePromptsFileContent(): Promise<string> {
  const specReviewMd = await Bun.file(join(REFERENCES_DIR, "spec-review.md")).text();
  const codeQualityMd = await Bun.file(join(REFERENCES_DIR, "code-quality.md")).text();
  const workerProtocolMd = await Bun.file(join(REFERENCES_DIR, "worker-protocol.md")).text();

  const { mechanics, outputFormatSection } = splitWorkerProtocol(workerProtocolMd);
  const findingBlockShape = extractFirstFencedBlock(outputFormatSection);

  const header = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Produced by \`scripts/generate-review-prompts.ts\` from the canonical
 * reviewer prose in \`src/finish/review/references/*.md\`. Edit the \`.md\`
 * files and re-run \`bun run gen:review-prompts\` to regenerate.
 *
 * Drift between this file and the \`.md\` sources is caught by
 * \`scripts/check-review-prompts-generated.ts\` (wired into \`bun run lint\`).
 */

`;

  const body = [
    `export const SPEC_REVIEW_DIMENSIONS = \`${escapeForTemplateLiteral(specReviewMd)}\`;`,
    `export const QUALITY_REVIEW_DIMENSIONS = \`${escapeForTemplateLiteral(codeQualityMd)}\`;`,
    `export const WORKER_PROTOCOL = \`${escapeForTemplateLiteral(workerProtocolMd)}\`;`,
    `export const WORKER_PROTOCOL_MECHANICS = \`${escapeForTemplateLiteral(mechanics)}\`;`,
    `export const FINDING_BLOCK_SHAPE = \`${escapeForTemplateLiteral(findingBlockShape)}\`;`,
  ].join("\n\n");

  return `${header}${body}\n`;
}

async function main() {
  const output = await generatePromptsFileContent();
  mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
  await Bun.write(OUTPUT_FILE, output);
  console.log(`Wrote ${OUTPUT_FILE}`);
}

if (import.meta.main) {
  await main();
}
