/**
 * Import specifiers in TypeScript source, found and rewritten by regex.
 *
 * Used by check-package-boundaries (and, until it ran, the S1-5 move script).
 * Matches run on comment-stripped text (stripComments keeps every offset), so a
 * specifier inside a comment is never reported or rewritten. A match that
 * STARTS inside a string literal is dropped too: fixture text such as
 * `'await import("@scope/pkg");'` is data, not an import, while a real
 * `await import("@scope/pkg")` starts at `import`, which is code.
 *
 * Covered forms: `import ... from "x"` and `export ... from "x"` (type-only and
 * multi-line included), side-effect `import "x"`, dynamic `import("x")`, inline
 * type references `import("x").T`, and CommonJS `require("x")`. The require
 * form is here because a boundary rule that cannot see it is a boundary rule
 * that reports green on `require("@nathapp/nax")`.
 */
import { stripComments } from "@nathapp/nax-repo-tooling/scripts/check-import-cycles";

const STATIC_RE = /^[ \t]*(?:import|export)\s+(?:type\s+)?[A-Za-z0-9_$*,{}\s]*?from\s+["']([^"']+)["']/gm;
const SIDE_EFFECT_RE = /^[ \t]*import\s+["']([^"']+)["']/gm;
const DYNAMIC_RE = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE_RE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

/**
 * One specifier occurrence. `prelude` is the statement text before the quote
 * (empty for `import("x")`, the `require` call head for `require("x")`).
 */
export interface SpecifierSite {
  readonly spec: string;
  /** Offset of the first character of the specifier (inside the quotes). */
  readonly start: number;
  readonly kind: "static" | "side-effect" | "dynamic" | "require";
  readonly prelude: string;
}

/**
 * [start, end) spans of string literals in `text` (the comment-stripped source),
 * tracking backslash escapes. A single/double-quoted string cannot span a raw
 * newline, so an unmatched quote — for example one inside a regex literal — is
 * not a span; that keeps the scan from swallowing real imports that follow it.
 */
function stringSpans(text: string): Array<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];
  let i = 0;
  while (i < text.length) {
    const open = text[i];
    if (open !== '"' && open !== "'" && open !== "`") {
      i++;
      continue;
    }
    let j = i + 1;
    let closed = false;
    while (j < text.length) {
      const c = text[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === open) {
        j++;
        closed = true;
        break;
      }
      if (c === "\n" && open !== "`") break;
      j++;
    }
    if (closed) {
      spans.push([i, j]);
      i = j;
    } else {
      i++;
    }
  }
  return spans;
}

function startsInsideString(spans: ReadonlyArray<readonly [number, number]>, offset: number): boolean {
  return spans.some(([start, end]) => offset >= start && offset < end);
}

export function specifierSites(source: string): SpecifierSite[] {
  const text = stripComments(source);
  const strings = stringSpans(text);
  const sites: SpecifierSite[] = [];
  const add = (re: RegExp, kind: SpecifierSite["kind"]) => {
    for (const m of text.matchAll(re)) {
      const spec = m[1];
      if (spec === undefined || m.index === undefined) continue;
      // A match that starts inside a string is fixture text, not code. A real
      // import's match starts at `import` / `export` / `require` (code), even
      // though its specifier sits between quotes.
      if (startsInsideString(strings, m.index)) continue;
      const at = m[0].lastIndexOf(spec);
      sites.push({ spec, start: m.index + at, kind, prelude: kind === "dynamic" ? "" : m[0].slice(0, at - 1) });
    }
  };
  add(STATIC_RE, "static");
  add(SIDE_EFFECT_RE, "side-effect");
  add(DYNAMIC_RE, "dynamic");
  add(REQUIRE_RE, "require");
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
 *
 * A `require` site takes the specifier-string form only: `require("x")` is a
 * call inside an expression, so splicing a statement in its place would write
 * `const { a } = import { a } from "..."`. It therefore throws, like the other
 * non-static kinds.
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
