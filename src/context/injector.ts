/**
 * Project Metadata Auto-Injector (v0.16.1)
 *
 * Reads package.json and nax config to inject project metadata into context.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { NaxConfig } from "../config";
import type { ProjectMetadata } from "./types";

/** Key dependency keywords to detect and include */
const NOTABLE_DEPS = [
  "nestjs",
  "@nestjs",
  "express",
  "fastify",
  "koa",
  "hono",
  "next",
  "nuxt",
  "react",
  "vue",
  "svelte",
  "solid",
  "prisma",
  "typeorm",
  "mongoose",
  "drizzle",
  "sequelize",
  "jest",
  "vitest",
  "mocha",
  "bun",
  "zod",
  "typescript",
  "graphql",
  "trpc",
  "bull",
  "ioredis",
];

/**
 * Read package.json from workdir and extract project name + key deps.
 */
async function readPackageJson(workdir: string): Promise<{ name?: string; dependencies: string[] }> {
  const pkgPath = join(workdir, "package.json");
  if (!existsSync(pkgPath)) {
    return { dependencies: [] };
  }

  try {
    const file = Bun.file(pkgPath);
    const pkg = await file.json();

    const allDeps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };

    const notable = Object.keys(allDeps).filter((dep) =>
      NOTABLE_DEPS.some((keyword) => dep === keyword || dep.startsWith(`${keyword}/`) || dep.includes(keyword)),
    );

    // Deduplicate and take top 10 to keep output concise
    const unique = [...new Set(notable)].slice(0, 10);

    return { name: pkg.name, dependencies: unique };
  } catch {
    return { dependencies: [] };
  }
}

/**
 * Build auto-injected project metadata from package.json + nax config.
 */
export async function buildProjectMetadata(workdir: string, config: NaxConfig): Promise<ProjectMetadata> {
  const { name, dependencies } = await readPackageJson(workdir);

  return {
    name,
    dependencies,
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
