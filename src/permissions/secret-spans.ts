/**
 * Secret spans in agent-authored command text (review #9, spec section 1).
 *
 * Two consumers with different stakes:
 *  - `maskForPrompt` feeds an approval prompt. A masked span must never hide
 *    code from the human approving it, so any span containing shell syntax
 *    makes the whole text unshowable and the ask is denied instead (D18).
 *  - `redactForRow` feeds local audit rows. Nothing is approved from them but
 *    forensic content matters, so each span is masked only up to its first
 *    shell-active character: `Cookie: a=b'; rm -rf ~` keeps `'; rm -rf ~`.
 *    Accepted residual: secret characters after a shell-active character stay
 *    visible in the row.
 */
import { SECRET_VALUE_PATTERNS } from "@/logger";

export interface SecretSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: string;
}

export type MaskResult =
  | { readonly ok: true; readonly masked: string; readonly count: number }
  | { readonly ok: false; readonly reason: string };

const SHELL_ACTIVE = /[$`;|&<>()'"\n]/;
/** A PEM body is newline-separated by construction; only real shell syntax cuts it. */
const SHELL_ACTIVE_IN_PEM = /[$`;|&<>()'"]/;
/** Kinds whose match is `NAME=value` / `name: value`; a `$` value is a reference, not a secret. */
const VALUE_KINDS = new Set(["assignment", "api-key-header"]);

function referencesVariable(kind: string, match: string): boolean {
  if (!VALUE_KINDS.has(kind)) return false;
  const sep = match.search(/[=:]/);
  return (
    sep >= 0 &&
    match
      .slice(sep + 1)
      .trimStart()
      .startsWith("$")
  );
}

function rawSpans(text: string): readonly SecretSpan[] {
  return SECRET_VALUE_PATTERNS.flatMap(({ kind, re }) => {
    // A private copy: the shared /g regex carries lastIndex between callers.
    const scan = new RegExp(re.source, re.flags);
    const found: SecretSpan[] = [];
    for (let m = scan.exec(text); m !== null; m = scan.exec(text)) {
      if (!referencesVariable(kind, m[0])) found.push({ start: m.index, end: m.index + m[0].length, kind });
    }
    return found;
  });
}

/** Non-overlapping spans, sorted; overlapping or touching matches merge (earliest kind wins). */
export function findSecretSpans(text: string): readonly SecretSpan[] {
  const sorted = [...rawSpans(text)].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: SecretSpan[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && span.start <= last.end) {
      merged[merged.length - 1] = { ...last, end: Math.max(last.end, span.end) };
    } else {
      merged.push(span);
    }
  }
  return merged;
}

function replaceSpans(
  text: string,
  spans: readonly SecretSpan[],
  render: (span: SecretSpan, body: string) => string,
): string {
  const parts = spans.map((span, i) => {
    const gapStart = i === 0 ? 0 : (spans[i - 1]?.end ?? 0);
    return text.slice(gapStart, span.start) + render(span, text.slice(span.start, span.end));
  });
  return parts.join("") + text.slice(spans.at(-1)?.end ?? 0);
}

export function maskForPrompt(text: string): MaskResult {
  const spans = findSecretSpans(text);
  const unsafe = spans.find((span) => SHELL_ACTIVE.test(text.slice(span.start, span.end)));
  if (unsafe !== undefined) {
    return { ok: false, reason: `a ${unsafe.kind} secret spans shell syntax` };
  }
  return { ok: true, masked: replaceSpans(text, spans, (span) => `[REDACTED:${span.kind}]`), count: spans.length };
}

export function redactForRow(text: string): string {
  return replaceSpans(text, findSecretSpans(text), (span, body) => {
    const cut = body.search(span.kind === "pem" ? SHELL_ACTIVE_IN_PEM : SHELL_ACTIVE);
    return cut === -1 ? `[REDACTED:${span.kind}]` : `[REDACTED:${span.kind}]${body.slice(cut)}`;
  });
}

/** Apply `redactForRow` to every string leaf. Keys and non-string values are kept as-is. */
export function redactRowStrings<T>(value: T): T {
  if (typeof value === "string") return redactForRow(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => redactRowStrings(item)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactRowStrings(v)])) as T;
  }
  return value;
}
