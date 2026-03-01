/**
 * Project Metadata Auto-Injector (v0.16.1)
 *
 * Detects project language/stack and injects metadata into agent configs.
 * Supports: Node.js/Bun (package.json), Go (go.mod), Rust (Cargo.toml),
 *           Python (pyproject.toml / requirements.txt), PHP (composer.json),
 *           Ruby (Gemfile), Java/Kotlin (pom.xml / build.gradle).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NaxConfig } from "../config";
import type { ProjectMetadata } from "./types";

/** Notable Node.js dependency keywords */
const NOTABLE_NODE_DEPS = [
  "@nestjs", "express", "fastify", "koa", "hono", "next", "nuxt",
  "react", "vue", "svelte", "solid", "prisma", "typeorm", "mongoose",
  "drizzle", "sequelize", "jest", "vitest", "mocha", "bun", "zod",
  "typescript", "graphql", "trpc", "bull", "ioredis",
];

// ─── Language detectors ──────────────────────────────────────────────────────

/** Node.js / Bun: read package.json */
async function detectNode(workdir: string): Promise<{ name?: string; lang: string; dependencies: string[] } | null> {
  const pkgPath = join(workdir, "package.json");
  if (!existsSync(pkgPath)) return null;

  try {
    const file = Bun.file(pkgPath);
    const pkg = await file.json();
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const notable = [...new Set(
      Object.keys(allDeps).filter((dep) =>
        NOTABLE_NODE_DEPS.some((kw) => dep === kw || dep.startsWith(`${kw}/`) || dep.includes(kw)),
      ),
    )].slice(0, 10);
    const lang = pkg.devDependencies?.typescript || pkg.dependencies?.typescript ? "TypeScript" : "JavaScript";
    return { name: pkg.name, lang, dependencies: notable };
  } catch {
    return null;
  }
}

/** Go: read go.mod for module name + direct dependencies */
function detectGo(workdir: string): { name?: string; lang: string; dependencies: string[] } | null {
  const goMod = join(workdir, "go.mod");
  if (!existsSync(goMod)) return null;

  try {
    const content = readFileSync(goMod, "utf8");
    const moduleMatch = content.match(/^module\s+(\S+)/m);
    const name = moduleMatch?.[1];

    // Extract require block entries (direct deps, not indirect)
    const requires: string[] = [];
    const requireBlock = content.match(/require\s*\(([^)]+)\)/s)?.[1] ?? "";
    for (const line of requireBlock.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("//") && !trimmed.includes("// indirect")) {
        const dep = trimmed.split(/\s+/)[0];
        if (dep) requires.push(dep.split("/").slice(-1)[0]); // last segment only
      }
    }

    return { name, lang: "Go", dependencies: requires.slice(0, 10) };
  } catch {
    return null;
  }
}

/** Rust: read Cargo.toml for package name + dependencies */
function detectRust(workdir: string): { name?: string; lang: string; dependencies: string[] } | null {
  const cargoPath = join(workdir, "Cargo.toml");
  if (!existsSync(cargoPath)) return null;

  try {
    const content = readFileSync(cargoPath, "utf8");
    const nameMatch = content.match(/^\[package\][^[]*name\s*=\s*"([^"]+)"/ms);
    const name = nameMatch?.[1];

    // Extract [dependencies] section keys
    const depsSection = content.match(/^\[dependencies\]([^[]*)/ms)?.[1] ?? "";
    const deps = depsSection
      .split("\n")
      .map((l) => l.split("=")[0].trim())
      .filter((l) => l && !l.startsWith("#"))
      .slice(0, 10);

    return { name, lang: "Rust", dependencies: deps };
  } catch {
    return null;
  }
}

/** Python: read pyproject.toml or requirements.txt */
function detectPython(workdir: string): { name?: string; lang: string; dependencies: string[] } | null {
  const pyproject = join(workdir, "pyproject.toml");
  const requirements = join(workdir, "requirements.txt");

  if (!existsSync(pyproject) && !existsSync(requirements)) return null;

  try {
    if (existsSync(pyproject)) {
      const content = readFileSync(pyproject, "utf8");
      const nameMatch = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
      const depsSection = content.match(/^\[project\][^[]*dependencies\s*=\s*\[([^\]]*)\]/ms)?.[1] ?? "";
      const deps = depsSection
        .split(",")
        .map((d) => d.trim().replace(/["'\s>=<!^~].*/g, ""))
        .filter(Boolean)
        .slice(0, 10);
      return { name: nameMatch?.[1], lang: "Python", dependencies: deps };
    }

    // Fallback: requirements.txt
    const lines = readFileSync(requirements, "utf8")
      .split("\n")
      .map((l) => l.split(/[>=<!]/)[0].trim())
      .filter((l) => l && !l.startsWith("#"))
      .slice(0, 10);
    return { lang: "Python", dependencies: lines };
  } catch {
    return null;
  }
}

/** PHP: read composer.json */
async function detectPhp(workdir: string): Promise<{ name?: string; lang: string; dependencies: string[] } | null> {
  const composerPath = join(workdir, "composer.json");
  if (!existsSync(composerPath)) return null;

  try {
    const file = Bun.file(composerPath);
    const composer = await file.json();
    const deps = Object.keys({ ...(composer.require ?? {}), ...(composer["require-dev"] ?? {}) })
      .filter((d) => d !== "php")
      .map((d) => d.split("/").pop() ?? d)
      .slice(0, 10);
    return { name: composer.name, lang: "PHP", dependencies: deps };
  } catch {
    return null;
  }
}

/** Ruby: read Gemfile */
function detectRuby(workdir: string): { name?: string; lang: string; dependencies: string[] } | null {
  const gemfile = join(workdir, "Gemfile");
  if (!existsSync(gemfile)) return null;

  try {
    const content = readFileSync(gemfile, "utf8");
    const gems = [...content.matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)]
      .map((m) => m[1])
      .slice(0, 10);
    return { lang: "Ruby", dependencies: gems };
  } catch {
    return null;
  }
}

/** Java/Kotlin: detect from pom.xml or build.gradle */
function detectJvm(workdir: string): { name?: string; lang: string; dependencies: string[] } | null {
  const pom = join(workdir, "pom.xml");
  const gradle = join(workdir, "build.gradle");
  const gradleKts = join(workdir, "build.gradle.kts");

  if (!existsSync(pom) && !existsSync(gradle) && !existsSync(gradleKts)) return null;

  try {
    if (existsSync(pom)) {
      const content = readFileSync(pom, "utf8");
      const nameMatch = content.match(/<artifactId>([^<]+)<\/artifactId>/);
      const deps = [...content.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)]
        .map((m) => m[1])
        .filter((d) => d !== nameMatch?.[1])
        .slice(0, 10);
      const lang = existsSync(join(workdir, "src/main/kotlin")) ? "Kotlin" : "Java";
      return { name: nameMatch?.[1], lang, dependencies: deps };
    }

    const gradleFile = existsSync(gradleKts) ? gradleKts : gradle;
    const content = readFileSync(gradleFile, "utf8");
    const lang = gradleFile.endsWith(".kts") ? "Kotlin" : "Java";
    const deps = [...content.matchAll(/implementation[^'"]*['"]([^:'"]+:[^:'"]+)[^'"]*['"]/g)]
      .map((m) => m[1].split(":").pop() ?? m[1])
      .slice(0, 10);
    return { lang, dependencies: deps };
  } catch {
    return null;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * Detect project language and build metadata.
 * Runs all detectors; first match wins (Node checked last to avoid false positives in polyglot repos).
 */
export async function buildProjectMetadata(workdir: string, config: NaxConfig): Promise<ProjectMetadata> {
  // Priority: Go > Rust > Python > PHP > Ruby > JVM > Node
  const detected =
    detectGo(workdir) ??
    detectRust(workdir) ??
    detectPython(workdir) ??
    (await detectPhp(workdir)) ??
    detectRuby(workdir) ??
    detectJvm(workdir) ??
    (await detectNode(workdir));

  return {
    name: detected?.name,
    language: detected?.lang,
    dependencies: detected?.dependencies ?? [],
    testCommand: config.execution?.testCommand,
    lintCommand: config.execution?.lintCommand,
    typecheckCommand: config.execution?.typecheckCommand,
  };
}

/**
 * Format metadata as a markdown section for injection into agent configs.
 */
export function formatMetadataSection(metadata: ProjectMetadata): string {
  const lines: string[] = ["## Project Metadata", "", "> Auto-injected by `nax generate`", ""];

  if (metadata.name) {
    lines.push(`**Project:** \`${metadata.name}\``);
    lines.push("");
  }

  if (metadata.language) {
    lines.push(`**Language:** ${metadata.language}`);
    lines.push("");
  }

  if (metadata.dependencies.length > 0) {
    lines.push(`**Key dependencies:** ${metadata.dependencies.join(", ")}`);
    lines.push("");
  }

  const commands: string[] = [];
  if (metadata.testCommand) commands.push(`test: \`${metadata.testCommand}\``);
  if (metadata.lintCommand) commands.push(`lint: \`${metadata.lintCommand}\``);
  if (metadata.typecheckCommand) commands.push(`typecheck: \`${metadata.typecheckCommand}\``);

  if (commands.length > 0) {
    lines.push(`**Commands:** ${commands.join(" | ")}`);
    lines.push("");
  }

  lines.push("---");
  lines.push("");

  return lines.join("\n");
}
