/**
 * Import specifiers in TypeScript source, found and rewritten by regex.
 *
 * Used by the package-boundary gates and the S1-5 move script. Matches run on
 * comment-stripped text (stripComments keeps every offset), so a specifier
 * inside a comment is never reported or rewritten.
 *
 * Covered forms: `import ... from "x"` and `export ... from "x"` (type-only and
 * multi-line included), side-effect `import "x"`, dynamic `import("x")` and
 * inline type references `import("x").T`.
 */
import { stripComments } from "../check-import-cycles";

const STATIC_RE = /^[ \t]*(?:import|export)\s+(?:type\s+)?[A-Za-z0-9_$*,{}\s]*?from\s+["']([^"']+)["']/gm;
const SIDE_EFFECT_RE = /^[ \t]*import\s+["']([^"']+)["']/gm;
const DYNAMIC_RE = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

/** One specifier occurrence. `prelude` is the statement text before the quote (empty for `import("x")`). */
export interface SpecifierSite {
  readonly spec: string;
  /** Offset of the first character of the specifier (inside the quotes). */
  readonly start: number;
  readonly kind: "static" | "side-effect" | "dynamic";
  readonly prelude: string;
}

export function specifierSites(source: string): SpecifierSite[] {
  const text = stripComments(source);
  const sites: SpecifierSite[] = [];
  const add = (re: RegExp, kind: SpecifierSite["kind"]) => {
    for (const m of text.matchAll(re)) {
      const spec = m[1];
      if (spec === undefined || m.index === undefined) continue;
      const at = m[0].lastIndexOf(spec);
      sites.push({ spec, start: m.index + at, kind, prelude: kind === "dynamic" ? "" : m[0].slice(0, at - 1) });
    }
  };
  add(STATIC_RE, "static");
  add(SIDE_EFFECT_RE, "side-effect");
  add(DYNAMIC_RE, "dynamic");
  return sites.sort((a, b) => a.start - b.start);
}

export function specifiersOf(source: string): string[] {
  return specifierSites(source).map((s) => s.spec);
}

/** A rewrite of one site: a new specifier, or a replacement for the whole statement up to the closing quote. */
export type SiteRewrite = string | { readonly statement: string } | null;

function statementStart(site: SpecifierSite): number {
  return site.start - 1 - site.prelude.length;
}

/**
 * Replaces specifiers. `map` returns the new specifier, a whole-statement
 * replacement (static sites only), or `null` to keep the site unchanged.
 * Offsets are applied back to front, so earlier ones stay valid.
 */
export function rewriteSpecifiers(source: string, map: (site: SpecifierSite) => SiteRewrite): string {
  let out = source;
  for (const site of [...specifierSites(source)].reverse()) {
    const next = map(site);
    if (next === null || next === site.spec) continue;
    if (typeof next === "string") {
      out = out.slice(0, site.start) + next + out.slice(site.start + site.spec.length);
      continue;
    }
    if (site.kind !== "static") {
      throw new Error(
        `rewriteSpecifiers: a whole-statement replacement is only valid for a static import, not this ${site.kind} site ("${site.spec}"); return a string to rewrite only the specifier`,
      );
    }
    const indent = site.prelude.match(/^[ \t]*/)?.[0] ?? "";
    out = out.slice(0, statementStart(site)) + indent + next.statement + out.slice(site.start + site.spec.length + 1);
  }
  return out;
}
