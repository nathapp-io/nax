/**
 * Resolves a specifier written in a packages/nax file to the file it names, as
 * a path relative to the package root. Covers the tsconfig aliases (`@/`,
 * `@test/`, `@scripts/`) and relative specifiers; a bare package specifier
 * resolves to null.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
// Alias, not `../../`: Biome's noRestrictedImports bans a relative import that climbs two levels.
import { stripComments } from "@scripts/check-import-cycles";
import { type SpecifierSite, specifierSites } from "@scripts/lib/import-specifiers";

const SUFFIXES = ["/index.ts", ".ts", ".tsx", "/index.tsx"] as const;
const ALIASES: Readonly<Record<string, string>> = { "@/": "src", "@test/": "test", "@scripts/": "scripts" };

/** True for a specifier that must resolve inside the package (alias or relative). */
export function isLocalSpecifier(spec: string): boolean {
  return spec.startsWith(".") || Object.keys(ALIASES).some((a) => spec.startsWith(a));
}

/** The source with comments stripped, so a match never fires on commented-out code. Offsets are preserved. */
export function strippedText(source: string): string {
  return stripComments(source);
}

/** The specifiers this file names, in source order, comments already stripped. */
export function markersOf(source: string): SpecifierSite[] {
  return specifierSites(stripComments(source));
}

function baseFor(root: string, fromRel: string, spec: string): string | null {
  for (const [alias, dir] of Object.entries(ALIASES)) {
    if (spec.startsWith(alias)) return join(root, dir, spec.slice(alias.length));
  }
  if (spec.startsWith("./") || spec.startsWith("../")) return resolve(dirname(join(root, fromRel)), spec);
  return null;
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

export function toRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

export function resolveInPackage(root: string, fromRel: string, spec: string): string | null {
  const based = baseFor(root, fromRel, spec);
  if (based === null) return null;
  const base = based.replace(/\.js$/, "");
  for (const suffix of SUFFIXES) {
    if (isFile(`${base}${suffix}`)) return toRel(root, `${base}${suffix}`);
  }
  return isFile(base) ? toRel(root, base) : null;
}
