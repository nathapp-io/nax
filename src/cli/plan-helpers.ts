/**
 * Plan command helpers — CLI interaction bridge and codebase context utilities.
 *
 * Extracted from plan.ts to keep each file within the 600-line project limit.
 */

import { createInterface } from "node:readline";
import type { PackageSummary } from "../prompts";

/**
 * Create a CLI interaction bridge for stdin-based human interaction.
 * This bridge accepts questions from the agent and prompts the user via stdin.
 */
export function createCliInteractionBridge(): {
  detectQuestion: (text: string) => Promise<boolean>;
  onQuestionDetected: (text: string) => Promise<string>;
} {
  return {
    async detectQuestion(text: string): Promise<boolean> {
      return text.includes("?");
    },

    async onQuestionDetected(text: string): Promise<string> {
      // In non-TTY mode (headless/pipes), skip interaction and continue
      if (!process.stdin.isTTY) {
        return "";
      }

      // Print agent question and read one line from stdin
      process.stdout.write(`\n🤖 Agent: ${text}\nYou: `);

      return new Promise<string>((resolve) => {
        const rl = createInterface({ input: process.stdin, terminal: false });
        rl.once("line", (line) => {
          rl.close();
          resolve(line.trim());
        });
        rl.once("close", () => resolve(""));
      });
    },
  };
}

export const FRAMEWORK_PATTERNS: [RegExp, string][] = [
  [/\bnext\b/, "Next.js"],
  [/\bnuxt\b/, "Nuxt"],
  [/\bremix\b/, "Remix"],
  [/\bexpress\b/, "Express"],
  [/\bfastify\b/, "Fastify"],
  [/\bhono\b/, "Hono"],
  [/\bnestjs|@nestjs\b/, "NestJS"],
  [/\breact\b/, "React"],
  [/\bvue\b/, "Vue"],
  [/\bsvelte\b/, "Svelte"],
  [/\bastro\b/, "Astro"],
  [/\belectron\b/, "Electron"],
];

export const TEST_RUNNER_PATTERNS: [RegExp, string][] = [
  [/\bvitest\b/, "vitest"],
  [/\bjest\b/, "jest"],
  [/\bmocha\b/, "mocha"],
  [/\bava\b/, "ava"],
];

export const KEY_DEP_PATTERNS: [RegExp, string][] = [
  [/\bprisma\b/, "prisma"],
  [/\bdrizzle-orm\b/, "drizzle"],
  [/\btypeorm\b/, "typeorm"],
  [/\bmongoose\b/, "mongoose"],
  [/\bsqlite\b|better-sqlite/, "sqlite"],
  [/\bstripe\b/, "stripe"],
  [/\bgraphql\b/, "graphql"],
  [/\btrpc\b/, "tRPC"],
  [/\bzod\b/, "zod"],
  [/\btailwind\b/, "tailwind"],
];

/**
 * Build a compact summary of a package's tech stack from its package.json.
 */
export function buildPackageSummary(rel: string, pkg: Record<string, unknown> | null): PackageSummary {
  const name = typeof pkg?.name === "string" ? pkg.name : rel;
  const allDeps = { ...(pkg?.dependencies as object | undefined), ...(pkg?.devDependencies as object | undefined) };
  const depNames = Object.keys(allDeps).join(" ");
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>;

  const testScript = scripts.test ?? "";
  const runtime = testScript.includes("bun ") ? "bun" : testScript.includes("node ") ? "node" : "unknown";
  const framework = FRAMEWORK_PATTERNS.find(([re]) => re.test(depNames))?.[1] ?? "";
  const testRunner =
    TEST_RUNNER_PATTERNS.find(([re]) => re.test(depNames))?.[1] ?? (testScript.includes("bun test") ? "bun:test" : "");
  const keyDeps = KEY_DEP_PATTERNS.filter(([re]) => re.test(depNames)).map(([, label]) => label);

  return { path: rel, name, runtime, framework, testRunner, keyDeps };
}

/**
 * Build source roots section markdown for planning prompt.
 * Renders discovered source roots with their language, framework, and test runner.
 * When no roots are provided, renders a single entry for the root directory.
 */
export function buildSourceRootsSection(roots: import("../analyze/types").SourceRoot[]): string {
  const sections: string[] = [];

  sections.push("## Source Roots\n");
  sections.push("You have Read, Grep, and Glob tools — explore on demand. Cite findings as `path:line`.");
  sections.push("Budget: aim for ≤ 10 file reads per story.\n");

  if (roots.length === 0) {
    sections.push("- .  (unknown, framework: —, tests: —)");
  } else {
    for (const root of roots) {
      const language = root.language ?? "unknown";
      const framework = root.framework || "—";
      const testRunner = root.testRunner || "—";
      sections.push(`- ${root.path}  (${language}, framework: ${framework}, tests: ${testRunner})`);
    }
  }

  return sections.join("\n");
}
