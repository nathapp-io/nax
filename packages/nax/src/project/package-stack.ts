/**
 * Shared package stack inference utilities.
 *
 * Centralizes framework and test-runner detection from package.json so
 * scanner and plan prompt helpers stay in sync.
 */

import { detectManifestFrameworksFromPackageJson } from "../test-runners";

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

export function inferFrameworkAndTestRunner(pkg: Record<string, unknown> | null): {
  framework: string;
  testRunner: string;
} {
  if (!pkg) return { framework: "", testRunner: "" };

  const allDeps = {
    ...(pkg.dependencies as Record<string, unknown> | undefined),
    ...(pkg.devDependencies as Record<string, unknown> | undefined),
  };
  const depNames = Object.keys(allDeps).join(" ");
  const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
  const testScript = typeof scripts.test === "string" ? scripts.test : "";

  const framework = FRAMEWORK_PATTERNS.find(([re]) => re.test(depNames))?.[1] ?? "";

  // Keep summary intent aligned with the configured primary test command.
  if (testScript.includes("bun test")) {
    return { framework, testRunner: "bun:test" };
  }

  const manifestFrameworks = detectManifestFrameworksFromPackageJson(pkg);
  const summaryRunner = manifestFrameworks.find(
    (runner) => runner === "vitest" || runner === "jest" || runner === "mocha",
  );
  const testRunner = summaryRunner || (/\bava\b/.test(depNames) ? "ava" : "");

  return { framework, testRunner };
}
