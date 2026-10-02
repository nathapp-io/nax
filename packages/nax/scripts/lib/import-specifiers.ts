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
import { createScanner, formatSyntaxKind, LanguageVariant } from "typescript/unstable/ast";

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

const REGEX_PREDECESSORS = new Set([
  "OpenParenToken",
  "OpenBracketToken",
  "OpenBraceToken",
  "CommaToken",
  "ColonToken",
  "QuestionToken",
  "SemicolonToken",
  "EqualsToken",
  "EqualsGreaterThanToken",
  "ExclamationToken",
  "TildeToken",
  "PlusToken",
  "MinusToken",
  "AsteriskToken",
  "PercentToken",
  "AmpersandToken",
  "BarToken",
  "CaretToken",
  "AmpersandAmpersandToken",
  "BarBarToken",
  "QuestionQuestionToken",
  "ReturnKeyword",
  "ThrowKeyword",
  "CaseKeyword",
  "DeleteKeyword",
  "VoidKeyword",
  "TypeOfKeyword",
  "InstanceOfKeyword",
  "InKeyword",
  "OfKeyword",
  "AwaitKeyword",
  "YieldKeyword",
  "BlockCloseBraceToken",
]);
const CONTROL_PAREN_PREDECESSORS = new Set([
  "IfKeyword",
  "WhileKeyword",
  "ForKeyword",
  "WithKeyword",
  "SwitchKeyword",
  "CatchKeyword",
]);

interface ScannerState {
  readonly templateExpressionBraces: number[];
  readonly controlParens: boolean[];
  readonly blockBraces: boolean[];
  previous: string;
}

function isRegexStart(previous: string): boolean {
  return previous === "" || previous === "ControlCloseParenToken" || REGEX_PREDECESSORS.has(previous);
}

function scanCodeToken(scanner: ReturnType<typeof createScanner>, state: ScannerState): string {
  let kind = formatSyntaxKind(scanner.scan());
  if (kind === "SlashToken" && isRegexStart(state.previous)) {
    kind = formatSyntaxKind(scanner.reScanSlashToken());
  } else if (kind === "OpenParenToken") {
    state.controlParens.push(CONTROL_PAREN_PREDECESSORS.has(state.previous));
  } else if (kind === "CloseParenToken" && state.controlParens.pop()) {
    kind = "ControlCloseParenToken";
  }
  kind = trackBlock(kind, state);
  kind = trackTemplateExpression(scanner, kind, state.templateExpressionBraces);
  state.previous = kind;
  return kind;
}

function trackBlock(kind: string, state: ScannerState): string {
  if (kind === "OpenBraceToken") {
    state.blockBraces.push(
      state.previous === "ControlCloseParenToken" ||
        ["ElseKeyword", "TryKeyword", "FinallyKeyword", "DoKeyword"].includes(state.previous),
    );
  }
  if (kind !== "CloseBraceToken") return kind;
  if (state.templateExpressionBraces.at(-1) === 0) return kind;
  if (state.blockBraces.pop()) return "BlockCloseBraceToken";
  return kind;
}

function trackTemplateExpression(
  scanner: ReturnType<typeof createScanner>,
  kind: string,
  expressions: number[],
): string {
  let nextKind = kind;
  if (kind === "OpenBraceToken" && expressions.length > 0) expressions[expressions.length - 1] += 1;
  if (kind === "BlockCloseBraceToken" && expressions.length > 0) expressions[expressions.length - 1] -= 1;
  if (kind === "CloseBraceToken" && expressions.length > 0) {
    const last = expressions.length - 1;
    if (expressions[last] === 0) nextKind = formatSyntaxKind(scanner.reScanTemplateToken(false));
    else expressions[last] -= 1;
  }
  if (nextKind === "TemplateHead") expressions.push(0);
  if (nextKind === "TemplateTail") expressions.pop();
  return nextKind;
}

function isExecutableToken(kind: string): boolean {
  return ![
    "StringLiteral",
    "NoSubstitutionTemplateLiteral",
    "TemplateHead",
    "TemplateMiddle",
    "TemplateTail",
    "RegularExpressionLiteral",
    "NumericLiteral",
    "BigIntLiteral",
  ].includes(kind);
}

/** Token starts that are executable code, including code inside template expressions. */
function codeTokenStarts(text: string): Set<number> {
  const scanner = createScanner(true, LanguageVariant.Standard, text);
  const starts = new Set<number>();
  const state: ScannerState = { templateExpressionBraces: [], controlParens: [], blockBraces: [], previous: "" };
  while (scanner.getTokenEnd() < text.length) {
    const kind = scanCodeToken(scanner, state);
    if (isExecutableToken(kind)) starts.add(scanner.getTokenStart());
  }
  return starts;
}

export function specifierSites(source: string): SpecifierSite[] {
  const text = stripComments(source);
  const codeStarts = codeTokenStarts(text);
  const sites: SpecifierSite[] = [];
  const add = (re: RegExp, kind: SpecifierSite["kind"]) => {
    for (const m of text.matchAll(re)) {
      const spec = m[1];
      if (spec === undefined || m.index === undefined) continue;
      // Static patterns begin at line indentation; all others begin at their
      // import/require token. Template raw text and quoted fixtures have no
      // executable token at that position.
      const staticKeyword = kind === "static" || kind === "side-effect";
      const keywordOffset = staticKeyword ? m.index + (m[0].match(/\b(?:import|export)\b/)?.index ?? 0) : m.index;
      if (!codeStarts.has(keywordOffset)) continue;
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
