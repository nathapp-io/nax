# Cross-phase review P0-P5 remaining findings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close review findings #8, #9, #10, #14, #17, #19, #20, #21, #22 and the five composite test gaps on `feat/xreview-remaining`.

**Architecture:** Mostly local fixes at the seams the review found. New logic lives in new small modules (`permissions/secret-spans.ts`, `tools/ask-request.ts`, `config/root-only-keys.ts`, `loop-events/payload-guard.ts`, `session/turn-end-event.ts`) because several touched files sit at or near the 600-line gate. Docs carry two decisions: ADR-031 (new) and amendments to ADR-030 / D18.

**Tech Stack:** TypeScript on Bun, `bun:test`, zod config schemas.

**Spec:** `docs/superpowers/specs/2026-09-24-xreview-remaining-design.md` (rev 2, commit `dbc9e29da`). Read it before any task; section numbers below (§1-§9) refer to it.

## Handover (read first)

- **Start state:** branch `feat/xreview-remaining` in `projects/nax/repos/nax`, off `main` @ `3b7834208`; spec and plan committed on it (5 `docs(spec|plan)` commits from `71fa58573`), nothing pushed. Before Task 1: `git status` must be clean and `git log --oneline -1` must show `docs(plan): final review fixes and handover notes`. Other sessions share this checkout: if the branch or HEAD is not what you expect, stop and ask; never assume you moved it.
- **Execution:** superpowers:subagent-driven-development. The user asked that **every subagent (implementer and reviewer) runs on `model: sonnet`**.
- **Task order is fixed:** 3 depends on 1-2; 5 edits the function 3 changed; 9's tests use the `ended` field added in 8. Otherwise tasks are independent.
- **Rulings are settled; do not re-open them** (spec "Rulings" table). In particular: the raw screen stays advisory (#8, wording only); masking a span that contains shell syntax is refused, never shown (#9); per-stage `permissions.<stage>.bashApproval` and `permissionProfile` stay per-package (#10); #14 needs no code; #11 is out of scope.
- **Stop and report** (do not work around) when a test that the plan says should already pass fails (Task 10), or when a step's anchor text is not found at the cited location.
- **Done means:** Task 12's gates green, commits on the branch, no push, no PR, no `nax run`.

## Global Constraints

- File-size gate: 600 lines for `src/**/*.ts`, 800 for `test/**/*.test.ts` (`scripts/check-file-sizes.ts`). `src/config/loader.ts` is at 600: its net growth must be <= 0. `src/tools/runtime.ts` is at 582.
- Run ONE test file: `timeout 60 bun test <path> --timeout=5000` (prefix `AGENT=1` for errors-only output). Never run bare, uncapped `bun test`; `bun run test -- <path>` ignores the path and runs everything.
- Gates before every commit touching `src/`: `bun run typecheck` and `bun run check:all` (typecheck is NOT part of `check:all`). The pre-commit hook runs both; do not bypass it.
- Final gate (Task 12): `bun run test`, `bun run typecheck`, `bun run check:all` and `bun run test:coverage` (CI's per-file coverage floor; not part of the pipeline) all green.
- `test/` has a ratchet of 0 `as unknown as` casts; `src/` forbids silent-fail `NaxConfig` casts. Do not add either.
- No emojis in code, comments or docs. Immutable updates (spread), except the documented in-place restore in Task 9.
- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`); no attribution trailer.
- No billed runs; never run `nax run` / `nax plan` for this work.

## Review Focus

1. **A command with no secret must produce the exact prompt it produces today** (byte-identical `detail`, no footer). Pinned in Task 3.
2. **A secret in an Exec argv** (no `command` field; the summary is the only text shown) must be masked or the ask denied as `unshowable`. Pinned in Task 2.
3. **A secret in a Write/Edit path field** (e.g. a path containing `ghp_...`) must be masked in the summary. Pinned in Task 2.
4. **A command whose masked form plus the footer exceeds 3500 chars** must deny `unavailable`, not truncate. Pinned in Task 3.
5. **A package's `permissions.<stage>.bashApproval` must still apply** after the root-only change (it is the documented exception). Pinned in Task 6.

---

### Task 1: Secret span finder (§1)

**Files:**
- Modify: `src/logger/redact.ts:32-107` (pattern table gains kinds; export it)
- Create: `src/permissions/secret-spans.ts`
- Modify: `src/permissions/index.ts` (export the new module)
- Test: `test/unit/permissions/secret-spans.test.ts` (new)

**Interfaces:**
- Produces: `SECRET_VALUE_PATTERNS: readonly SecretValuePattern[]` from `@/logger/redact`, `interface SecretValuePattern { readonly kind: string; readonly re: RegExp }`.
- Produces from `@/permissions`: `interface SecretSpan { readonly start: number; readonly end: number; readonly kind: string }`, `type MaskResult = { readonly ok: true; readonly masked: string; readonly count: number } | { readonly ok: false; readonly reason: string }`, `findSecretSpans(text: string): readonly SecretSpan[]`, `maskForPrompt(text: string): MaskResult`, `redactForRow(text: string): string`, `redactRowStrings<T>(value: T): T`.

- [ ] **Step 1: Write the failing test** — `test/unit/permissions/secret-spans.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { findSecretSpans, maskForPrompt, redactForRow, redactRowStrings } from "@/permissions";

const SK = "sk-abcdefghijklmnop1234";
const GHP = "ghp_abcdefghijklmnop1234";

describe("maskForPrompt", () => {
  test("masks an inert Bearer token with its kind", () => {
    const r = maskForPrompt("curl -H Authorization:Bearer abc123def456 https://x");
    expect(r).toEqual({ ok: true, masked: "curl -H Authorization:[REDACTED:bearer] https://x", count: 1 });
  });

  test("masks sk- and ghp_ values", () => {
    const r = maskForPrompt(`OPENAI=${SK} gh auth ${GHP}`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.masked).not.toContain(SK);
    expect(r.masked).not.toContain(GHP);
    expect(r.masked).toContain("[REDACTED:github]");
    expect(r.count).toBe(2);
  });

  test("overlapping patterns merge into one span (TOKEN=ghp_...)", () => {
    expect(findSecretSpans(`TOKEN=${GHP}`)).toHaveLength(1);
  });

  test("a value that references a variable is not a secret", () => {
    expect(findSecretSpans("GH_TOKEN=$(gh auth token) gh pr list")).toHaveLength(0);
    expect(findSecretSpans("TOKEN=${X} run")).toHaveLength(0);
  });

  test("a span containing shell syntax is not showable", () => {
    expect(maskForPrompt("curl -H 'Cookie: a=b'; rm -rf ~").ok).toBe(false);
    expect(maskForPrompt("TOKEN=abc;rm x").ok).toBe(false);
    const pem = "echo '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----'";
    expect(maskForPrompt(pem).ok).toBe(false);
  });

  test("text with no secret is returned unchanged", () => {
    expect(maskForPrompt("bun run test 2>&1 | tail -n 40")).toEqual({
      ok: true,
      masked: "bun run test 2>&1 | tail -n 40",
      count: 0,
    });
  });

  test("repeated calls give identical results (no shared lastIndex state)", () => {
    const text = `a ${SK} b ${SK}`;
    expect(maskForPrompt(text)).toEqual(maskForPrompt(text));
    expect(findSecretSpans(text)).toHaveLength(2);
  });
});

describe("redactForRow", () => {
  test("keeps the shell syntax after a secret visible", () => {
    const out = redactForRow("curl -H 'Cookie: a=b'; rm -rf ~");
    expect(out).toContain("'; rm -rf ~");
    expect(out).not.toContain("a=b");
  });

  test("a PEM block is redacted whole", () => {
    const out = redactForRow("-----BEGIN PRIVATE KEY-----\nMIIBSECRET\n-----END PRIVATE KEY-----");
    expect(out).not.toContain("MIIBSECRET");
  });
});

describe("redactRowStrings", () => {
  test("walks nested objects and arrays, keeping keys and non-strings", () => {
    const row = { request: { command: `echo ${SK}`, argv: ["x", GHP] }, latencyMs: 3, api_key: "plain" };
    const out = redactRowStrings(row);
    expect(out.request.command).not.toContain(SK);
    expect(out.request.argv[1]).not.toContain(GHP);
    expect(out.latencyMs).toBe(3);
    expect(out.api_key).toBe("plain");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 60 bun test test/unit/permissions/secret-spans.test.ts --timeout=5000`
Expected: FAIL — `findSecretSpans` is not exported from `@/permissions`.

- [ ] **Step 3: Give the pattern table kinds** — in `src/logger/redact.ts`, replace the declaration at `:32` and wrap every existing entry, keeping every existing comment above its entry:

```ts
/** One secret-value pattern and the kind label a masked span shows. */
export interface SecretValuePattern {
  readonly kind: string;
  readonly re: RegExp;
}

export const SECRET_VALUE_PATTERNS: readonly SecretValuePattern[] = [
  { kind: "openai", re: /sk-[A-Za-z0-9_-]{16,}/g },
  { kind: "github", re: /ghp_[A-Za-z0-9]{16,}/g },
  { kind: "github", re: /gh[opsu]_[A-Za-z0-9]{16,}/g },
  { kind: "github-pat", re: /github_pat_[A-Za-z0-9_]{20,}/g },
  { kind: "npm", re: /npm_[A-Za-z0-9]{8,}/g },
  { kind: "aws", re: /AKIA[0-9A-Z]{16}/g },
  { kind: "slack", re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "telegram", re: /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g },
  { kind: "assignment", re: /(?:SECRET|TOKEN|API_?KEY|PASSWORD|PRIVATE_?KEY|ACCESS_?KEY|WEBHOOK)=[^\s"',]+/gi },
  // (keep the PEM comment block here)
  { kind: "pem", re: /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)(?: BLOCK)?-----[\s\S]{0,65536}?-----END [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)(?: BLOCK)?-----/g },
  { kind: "jwt", re: /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g },
  { kind: "bearer", re: /\bBearer\s+(?=[A-Za-z0-9\-._~+/]*[0-9+/_-])[A-Za-z0-9\-._~+/]{8,}={0,2}/gi },
  { kind: "basic", re: /\b[Bb][Aa][Ss][Ii][Cc]\s+(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])[A-Za-z0-9+/]{8,}={0,2}/g },
  { kind: "api-key-header", re: /(?:x-api-key|api[_-]?key)\s*[:=]\s*[^\s"',]+/gi },
  { kind: "cookie", re: /\b(?:Set-)?Cookie\s*:\s*[^\r\n]+/gi },
  { kind: "url-credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/(?:[^/\s@]*:[^/\s@]+)@/gi },
];
```

Copy each regex literal from the current file verbatim (the list above must match it; if one differs, the file wins). Then change `redactString`'s loop to `for (const { re } of SECRET_VALUE_PATTERNS) {`. Nothing else in the file changes.

- [ ] **Step 4: Write `src/permissions/secret-spans.ts`**

```ts
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
import { SECRET_VALUE_PATTERNS } from "@/logger/redact";

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
  return sep >= 0 && match.slice(sep + 1).trimStart().startsWith("$");
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
  return sorted.reduce<readonly SecretSpan[]>((acc, span) => {
    const last = acc.at(-1);
    if (last !== undefined && span.start <= last.end) {
      return [...acc.slice(0, -1), { ...last, end: Math.max(last.end, span.end) }];
    }
    return [...acc, span];
  }, []);
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
```

Add to `src/permissions/index.ts`: `export * from "./secret-spans";`

- [ ] **Step 5: Run the new test and the existing redact test**

Run: `timeout 60 bun test test/unit/permissions/secret-spans.test.ts test/unit/logger/redact.test.ts --timeout=5000`
Expected: PASS (both files). If the Bearer case fails on the `Authorization:` prefix, check whether the `api-key-header` or `bearer` pattern matched first and adjust the test's expected kind to what the merged span reports — do not change the patterns.

- [ ] **Step 6: Typecheck, static checks, commit**

Run: `bun run typecheck && bun run check:all`
Expected: both green (watch `check-import-cycles`: permissions -> logger is an existing edge).

```bash
git add src/logger/redact.ts src/permissions/secret-spans.ts src/permissions/index.ts test/unit/permissions/secret-spans.test.ts
git commit -m "feat(permissions): secret span finder for prompts and audit rows (#9)"
```

---

### Task 2: Masked ask summary and the `unshowable` outcome (§1)

**Files:**
- Create: `src/tools/ask-request.ts`
- Modify: `src/tools/runtime.ts:48` (remove `MAX_ASK_SUMMARY_CHARS`), `:135-167` (remove `askSummary`, `askDenyReason`), `:493-514` (call site), imports
- Modify: `src/permissions/types.ts:12-33` (`AskRequest.unshowable`)
- Modify: `src/permissions/ask-chain.ts:19` (`AskDecidedBy` gains `"unshowable"`)
- Modify: `src/permissions/ask.ts` (new `ASK_UNSHOWABLE_REASON`; export it from `src/permissions/index.ts:12` next to the others)
- Test: `test/unit/tools/ask-request.test.ts` (new)

**Interfaces:**
- Consumes: `maskForPrompt` (Task 1).
- Produces: `askSummary(tool: string, scope: ToolScope, input: Record<string, unknown>): AskSummary`, `interface AskSummary { readonly summary: string; readonly unshowable: boolean }`, `askDenyReason(decidedBy: AskVerdict["decidedBy"]): string`, `MAX_ASK_SUMMARY_CHARS = 200` — all from `src/tools/ask-request.ts`. `AskRequest.unshowable?: true`. `AskDecidedBy` includes `"unshowable"`. `ASK_UNSHOWABLE_REASON: string`.

- [ ] **Step 1: Write the failing test** — `test/unit/tools/ask-request.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { ASK_NO_CHANNEL_REASON, ASK_UNSHOWABLE_REASON } from "@/permissions";
import { askDenyReason, askSummary, MAX_ASK_SUMMARY_CHARS } from "@/tools/ask-request";

const GHP = "ghp_abcdefghijklmnop1234";

describe("askSummary", () => {
  test("a plain command is unchanged", () => {
    expect(askSummary("Bash", { pathFields: [], commandField: "command" }, { command: "bun run test" })).toEqual({
      summary: "Bash command=bun run test",
      unshowable: false,
    });
  });

  test("a secret straddling the 200-char cut is masked BEFORE the cut", () => {
    const command = `${"x".repeat(185)} ${GHP}`;
    const s = askSummary("Bash", { pathFields: [], commandField: "command" }, { command });
    expect(s.unshowable).toBe(false);
    expect(s.summary.length).toBeLessThanOrEqual(MAX_ASK_SUMMARY_CHARS);
    expect(s.summary).not.toContain("ghp_abc");
  });

  test("Review Focus 2: a secret in an Exec argv is masked", () => {
    const s = askSummary("Exec", { pathFields: [], argvField: "argv" }, { argv: ["gh", "auth", GHP] });
    expect(s.summary).toContain("[REDACTED:github]");
    expect(s.summary).not.toContain(GHP);
  });

  test("Review Focus 3: a secret in a Write path field is masked", () => {
    const s = askSummary("Write", { pathFields: ["path"] }, { path: `notes/${GHP}.txt` });
    expect(s.summary).not.toContain(GHP);
  });

  test("a secret spanning shell syntax withholds the arguments", () => {
    const s = askSummary("Bash", { pathFields: [], commandField: "command" }, { command: "curl -H 'Cookie: a=b'" });
    expect(s).toEqual({ summary: "Bash [arguments withheld: contains a secret]", unshowable: true });
  });
});

describe("askDenyReason", () => {
  test("unshowable has its own reason", () => {
    expect(askDenyReason("unshowable")).toBe(ASK_UNSHOWABLE_REASON);
    expect(askDenyReason("unavailable")).toBe(ASK_NO_CHANNEL_REASON);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `timeout 60 bun test test/unit/tools/ask-request.test.ts --timeout=5000`
Expected: FAIL — cannot resolve `@/tools/ask-request`.

- [ ] **Step 3: Extend the permission types**

`src/permissions/ask-chain.ts:19`:
```ts
export type AskDecidedBy = "cache" | "model" | "human" | "timeout" | "unavailable" | "cancelled" | "unshowable";
```

`src/permissions/types.ts`, inside `AskRequest` after `command`:
```ts
  /**
   * Set when the call's arguments contain a secret whose masked form could
   * hide shell syntax (review #9). The human link denies without prompting.
   */
  readonly unshowable?: true;
```

`src/permissions/ask.ts`, after `ASK_CANCELLED_REASON`:
```ts
export const ASK_UNSHOWABLE_REASON =
  "Not run: the command contains a secret that cannot be shown to the approver safely; pass it through an environment variable instead.";
```
and add `ASK_UNSHOWABLE_REASON` to the named export list at `src/permissions/index.ts:12`.

- [ ] **Step 4: Create `src/tools/ask-request.ts`** by MOVING `askSummary`, `askDenyReason` and `MAX_ASK_SUMMARY_CHARS` out of `runtime.ts` (keep their docblocks), with these bodies:

```ts
import {
  ASK_CANCELLED_REASON,
  ASK_DENIED_REASON,
  ASK_NO_CHANNEL_REASON,
  ASK_TIMEOUT_REASON,
  ASK_UNSHOWABLE_REASON,
  type AskVerdict,
  maskForPrompt,
} from "@/permissions";
import type { ToolScope } from "./types";

/** Ceiling for the one-line call description an AskResolver receives. */
export const MAX_ASK_SUMMARY_CHARS = 200;

export interface AskSummary {
  readonly summary: string;
  /** True when a secret in the arguments could hide shell syntax if masked (review #9). */
  readonly unshowable: boolean;
}

export function askSummary(tool: string, scope: ToolScope, input: Record<string, unknown>): AskSummary {
  const fields = [scope.commandField, scope.argvField, scope.verbField, ...scope.pathFields];
  const parts = fields.flatMap((field) => {
    if (field === undefined) return [];
    const value = input[field];
    if (typeof value === "string") return [`${field}=${value}`];
    if (Array.isArray(value)) return [`${field}=${value.filter((v) => typeof v === "string").join(" ")}`];
    return [];
  });
  // Mask the FULL line, then cut: cutting first can split a secret so no
  // pattern matches what is left, and the partial secret would go out.
  const masked = maskForPrompt(`${tool} ${parts.join(" ")}`.trim());
  if (!masked.ok) return { summary: `${tool} [arguments withheld: contains a secret]`, unshowable: true };
  return { summary: masked.masked.slice(0, MAX_ASK_SUMMARY_CHARS), unshowable: false };
}

export function askDenyReason(decidedBy: AskVerdict["decidedBy"]): string {
  if (decidedBy === "timeout") return ASK_TIMEOUT_REASON;
  if (decidedBy === "human") return ASK_DENIED_REASON;
  if (decidedBy === "cancelled") return ASK_CANCELLED_REASON;
  if (decidedBy === "unshowable") return ASK_UNSHOWABLE_REASON;
  return ASK_NO_CHANNEL_REASON;
}
```

In `runtime.ts`: delete the moved code, and remove `ASK_DENIED_REASON`, `ASK_NO_CHANNEL_REASON` and `ASK_TIMEOUT_REASON` from its imports (now unused). **Keep `ASK_CANCELLED_REASON`**: it is still used directly in the AC11 branch (`runtime.ts:535`, `` `${verdict.reason} -- ${ASK_CANCELLED_REASON}` ``). Then add `import { askDenyReason, askSummary } from "./ask-request";`, and change the call site (the `askResolver.resolve(` block, `:493-514`) to:

```ts
        const ask = askSummary(policyIdentity, tool.scope, input);
        let askVerdict: AskVerdict;
        try {
          askVerdict = await askResolver.resolve(
            {
              tool: policyIdentity,
              stage: opts.pipelineStage ?? "unknown",
              rule: verdict.rule ?? verdict.reason,
              summary: ask.summary,
              ...(ask.unshowable ? { unshowable: true as const } : {}),
```
(the rest of the object literal is unchanged).

- [ ] **Step 5: Run the new test and the runtime/ask suites**

Run: `timeout 60 bun test test/unit/tools/ask-request.test.ts test/unit/tools/runtime.test.ts test/unit/interaction/ask-link.test.ts --timeout=5000`
Expected: PASS. If an existing runtime test asserts a summary containing a secret-shaped string, it now sees the masked form — update that assertion to the masked text and say so in the commit body.

- [ ] **Step 6: Gates and commit**

Run: `bun run typecheck && bun run check:all` (check `check-file-sizes`: `runtime.ts` must shrink).

```bash
git add src/tools/ask-request.ts src/tools/runtime.ts src/permissions test/unit/tools/ask-request.test.ts
git commit -m "feat(permissions): mask secrets in ask summaries; add the unshowable outcome (#9)"
```

---

### Task 3: Human ask link masks or denies (§1)

**Files:**
- Modify: `src/interaction/ask-link.ts` (header comment `:6-8`, import `:15`, `deny` `:93`, `runSession` `:271` + detail `:310-320`, `resolve` `:424-462`)
- Test: `test/unit/interaction/ask-link.test.ts`

**Interfaces:**
- Consumes: `maskForPrompt` (Task 1), `AskRequest.unshowable`, `AskDecidedBy` `"unshowable"` (Task 2).
- Produces: nothing new for later tasks. Task 5 edits the same `resolve` function next.

- [ ] **Step 1: Write the failing tests** — append to `test/unit/interaction/ask-link.test.ts`, reusing its `fakeChain`, `REQ` and `sent` pattern:

```ts
describe("review #9: secrets in the prompt", () => {
  const GHP = "ghp_abcdefghijklmnop1234";

  test("Review Focus 1: a command with no secret produces the same detail as before", async () => {
    const sent: InteractionRequest[] = [];
    const link = createHumanAskLink({ chain: fakeChain({ reply: "allow", sent }), timeoutMs: 1000 });
    await link.resolve(REQ);
    expect(sent[0]?.detail).toContain(["```", REQ.command, "```"].join("\n"));
    expect(sent[0]?.detail).not.toContain("secret value");
  });

  test("an inert secret is masked in the detail, with a footer; onRemember gets the raw command", async () => {
    const sent: InteractionRequest[] = [];
    const remembered: string[] = [];
    const link = createHumanAskLink({
      chain: fakeChain({ reply: "allow-remember", sent }),
      timeoutMs: 1000,
      onRemember: async (req) => void remembered.push(req.command ?? ""),
    });
    const command = `gh api -H x-token ${GHP}`;
    const outcome = await link.resolve({ ...REQ, command });
    expect(outcome.decision).toBe("allow");
    expect(sent[0]?.detail).not.toContain(GHP);
    expect(sent[0]?.detail).toContain("[REDACTED:github]");
    expect(sent[0]?.detail).toContain("1 secret value(s) masked; the approved command contains them");
    expect(remembered).toEqual([command]);
  });

  test("a secret spanning shell syntax denies unshowable without prompting", async () => {
    const sent: InteractionRequest[] = [];
    const link = createHumanAskLink({ chain: fakeChain({ reply: "allow", sent }), timeoutMs: 1000 });
    const outcome = await link.resolve({ ...REQ, command: "curl -H 'Cookie: a=b'; rm -rf ~" });
    expect(outcome).toEqual({ decision: "deny", decidedBy: "unshowable" });
    expect(sent).toHaveLength(0);
  });

  test("a request flagged unshowable upstream (Exec) denies without prompting", async () => {
    const sent: InteractionRequest[] = [];
    const link = createHumanAskLink({ chain: fakeChain({ reply: "allow", sent }), timeoutMs: 1000 });
    const { command: _command, ...execReq } = REQ;
    const outcome = await link.resolve({ ...execReq, tool: "Exec", unshowable: true });
    expect(outcome.decidedBy).toBe("unshowable");
    expect(sent).toHaveLength(0);
  });

  test("Review Focus 4: masked command plus footer over the limit denies unavailable", async () => {
    const sent: InteractionRequest[] = [];
    const link = createHumanAskLink({ chain: fakeChain({ reply: "allow", sent }), timeoutMs: 1000 });
    // Raw length 3475 passes the old check; masked (3468) + footer line pushes it over 3500.
    const command = `${"x".repeat(3450)} ${GHP}`;
    const outcome = await link.resolve({ ...REQ, command });
    expect(outcome.decidedBy).toBe("unavailable");
    expect(sent).toHaveLength(0);
  });
});
```


- [ ] **Step 2: Run to verify they fail**

Run: `timeout 60 bun test test/unit/interaction/ask-link.test.ts --timeout=5000`
Expected: the new tests FAIL (secret visible in detail; unshowable prompts).

- [ ] **Step 3: Implement**

Import (`:15`): `import { type AskControl, type AskLink, type AskLinkOutcome, type AskRequest, maskForPrompt } from "@/permissions";` and update the header comment (`:6-8`) to say the `@/permissions` import is now a runtime import (`maskForPrompt`).

`deny` (`:93`):
```ts
  const deny = (decidedBy: "human" | "timeout" | "unavailable" | "cancelled" | "unshowable"): AskLinkOutcome => ({
```

Near `MAX_COMMAND_CHARS` (`:20`):
```ts
/** What the prompt shows: the command with inert secret spans masked (review #9, D18). */
interface PromptView {
  readonly command: string;
  readonly maskedCount: number;
}

const maskedFooter = (count: number): string => `${count} secret value(s) masked; the approved command contains them`;
```

`runSession` signature (`:271`): `async function runSession(req: AskRequest, session: Session, view: PromptView): Promise<void> {` and the detail lines (`:315`):
```ts
              ...(view.command.length > 0 ? ["```", view.command, "```"] : []),
              ...(view.maskedCount > 0 ? [maskedFooter(view.maskedCount)] : []),
```

`resolve` — replace `:430-433` with:
```ts
    if (req.unshowable === true) {
      return Promise.resolve(deny("unshowable"));
    }
    const command = req.command ?? "";
    const masked = maskForPrompt(command);
    if (!masked.ok) {
      return Promise.resolve(deny("unshowable"));
    }
    const footerChars = masked.count > 0 ? maskedFooter(masked.count).length + 1 : 0;
    if (masked.masked.length + footerChars > MAX_COMMAND_CHARS) {
      return Promise.resolve(deny("unavailable"));
    }
    const view: PromptView = { command: masked.masked, maskedCount: masked.count };
```
and the scheduling call (`:462`): `.then(() => runSession(req, session, view))`. The dedupe key keeps using the raw `command`.

- [ ] **Step 4: Run the ask-link suite**

Run: `timeout 60 bun test test/unit/interaction/ask-link.test.ts --timeout=5000`
Expected: PASS (new and existing, including the 3500/3501 length pins).

- [ ] **Step 5: Gates and commit**

```bash
bun run typecheck && bun run check:all
git add src/interaction/ask-link.ts test/unit/interaction/ask-link.test.ts
git commit -m "feat(interaction): mask-or-deny secrets in approval prompts (#9)"
```

---

### Task 4: Redact local audit rows (§1)

**Files:**
- Modify: `src/permissions/approval-audit.ts:5-6` (header comment lists `unshowable`), `:29`
- Modify: `src/command-safety/row.ts:12`
- Modify: `src/tools/tool-audit.ts:177` (the `calls,` entry inside `flush`'s `JSON.stringify`)
- Test: `test/unit/permissions/approval-audit.test.ts`, `test/unit/command-safety/row.test.ts`, `test/unit/tools/tool-audit.test.ts`

**Interfaces:**
- Consumes: `redactRowStrings` (Task 1).

- [ ] **Step 1: Write the failing tests** (one per file, each using that file's existing fixture)

`approval-audit.test.ts` (uses `makeTempDir`/`cleanupTempDir`, `tempDir`, reads `run-1.jsonl`):
```ts
test("review #9: a secret in the request command is redacted in the row", async () => {
  tempDir = makeTempDir("approval-audit-");
  const secret = "ghp_abcdefghijklmnop1234";
  await appendApprovalAudit(tempDir, "run-1", {
    request: { tool: "Bash", stage: "run", rule: "Bash(*)", summary: "Bash", command: `gh auth ${secret}` },
    decision: "deny",
    decidedBy: "human",
    latencyMs: 1,
    at: "2026-09-24T00:00:00.000Z",
  });
  const text = readFileSync(join(tempDir, "run-1.jsonl"), "utf8");
  expect(text).not.toContain(secret);
  expect(text).toContain("[REDACTED:github]");
});
```

`row.test.ts` (uses `withTempDir` and its `row(command)` builder):
```ts
test("review #9: the command is redacted, shell syntax after it kept", async () => {
  await withTempDir(async (dir) => {
    await appendCommandSafetyRow(join(dir, "command-safety"), "run-1", row("curl -H 'Cookie: a=b'; rm -rf ~"));
    const text = readFileSync(join(dir, "command-safety", "run-1.jsonl"), "utf8");
    expect(text).not.toContain("a=b");
    expect(text).toContain("rm -rf ~");
  });
});
```

`tool-audit.test.ts` (uses `mkdtemp`, `createToolAuditSink`, `sink.record`, `sink.flush`, then reads the one JSON file). Build the record exactly like the nearest existing `sink.record({...})` in that file, with `input: { command: "gh auth ghp_abcdefghijklmnop1234" }` and `executed: ["gh", "auth", "ghp_abcdefghijklmnop1234"]`, then:
```ts
const body = await readFile(join(dir, (await readdir(dir))[0] ?? ""), "utf8");
expect(body).not.toContain("ghp_abcdefghijklmnop1234");
expect(JSON.parse(body).calls[0].input.command).toContain("[REDACTED:github]");
```

- [ ] **Step 2: Run to verify they fail**

Run: `timeout 60 bun test test/unit/permissions/approval-audit.test.ts test/unit/command-safety/row.test.ts test/unit/tools/tool-audit.test.ts --timeout=5000`
Expected: the three new tests FAIL.

- [ ] **Step 3: Implement**

`approval-audit.ts:29`: `${JSON.stringify(redactRowStrings(row))}\n` with `import { redactRowStrings } from "./secret-spans";`. Add `unshowable` to the decidedBy values listed in the header comment.

`row.ts:12`: same, with `import { redactRowStrings } from "@/permissions";`.

`tool-audit.ts:177`: in the object passed to `JSON.stringify`, replace `calls` with `calls: redactRowStrings(calls)`; import from `@/permissions`.

Do NOT touch `approvals-store.ts`: `approvals.json` must stay byte-exact (D17).

- [ ] **Step 4: Run the three files again**

Expected: PASS.

- [ ] **Step 5: Gates and commit**

```bash
bun run typecheck && bun run check:all
git add src/permissions/approval-audit.ts src/command-safety/row.ts src/tools/tool-audit.ts test/unit/permissions/approval-audit.test.ts test/unit/command-safety/row.test.ts test/unit/tools/tool-audit.test.ts
git commit -m "feat(audit): redact secrets in approval, command-safety and tool-audit rows (#9)"
```

---

### Task 5: Ask dedupe key (§7, #21)

**Files:**
- Modify: `src/interaction/ask-link.ts` (`resolve`, the key/lookup/insert block after Task 3's edits; the comment at `:419`)
- Test: `test/unit/interaction/ask-link.test.ts`

**Interfaces:**
- Consumes: Task 3's `resolve` shape.

- [ ] **Step 1: Write the failing tests** — append to `test/unit/interaction/ask-link.test.ts`. The holding chain mirrors the existing "identical concurrent asks join the pending prompt" test (`:194-216`): prompts are serialized, so a second session only prompts after the first settles.

```ts
describe("review #21: dedupe key", () => {
  function holdingChain() {
    const state = { promptCalls: 0, releases: [] as ((r: AskChannelResponse) => void)[] };
    const chain: AskChannel = {
      prompt: () => {
        state.promptCalls++;
        return new Promise<AskChannelResponse>((resolve) => {
          state.releases.push(resolve);
        });
      },
      cancel: () => Promise.resolve(),
    };
    const allowNext = (): void => {
      state.releases.shift()?.({ action: "allow", respondedAt: Date.now() });
    };
    return { chain, state, allowNext };
  }
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
  const { command: _command, ...NO_COMMAND } = REQ;

  test("two concurrent command-less asks get two prompts", async () => {
    const { chain, state, allowNext } = holdingChain();
    const link = createHumanAskLink({ chain, timeoutMs: 1000 });
    const a = link.resolve({ ...NO_COMMAND, tool: "Write", summary: "Write path=a.txt" });
    const b = link.resolve({ ...NO_COMMAND, tool: "Write", summary: "Write path=b.txt" });
    await tick();
    expect(state.promptCalls).toBe(1);
    allowNext();
    expect((await a).decision).toBe("allow");
    await tick();
    expect(state.promptCalls).toBe(2);
    allowNext();
    expect((await b).decision).toBe("allow");
  });

  test("the same command under two tools gets two prompts", async () => {
    const { chain, state, allowNext } = holdingChain();
    const link = createHumanAskLink({ chain, timeoutMs: 1000 });
    const a = link.resolve(REQ);
    const b = link.resolve({ ...REQ, tool: "Exec" });
    await tick();
    allowNext();
    await a;
    await tick();
    expect(state.promptCalls).toBe(2);
    allowNext();
    await b;
  });

  test("two identical Bash asks still share one prompt", async () => {
    const { chain, state, allowNext } = holdingChain();
    const link = createHumanAskLink({ chain, timeoutMs: 1000 });
    const a = link.resolve(REQ);
    const b = link.resolve(REQ);
    await tick();
    allowNext();
    expect(await a).toEqual({ decision: "allow", decidedBy: "human" });
    expect(await b).toEqual({ decision: "allow", decidedBy: "human" });
    expect(state.promptCalls).toBe(1);
  });

  test("cancel() settles a pending command-less ask", async () => {
    const { chain } = holdingChain();
    const link = createHumanAskLink({ chain, timeoutMs: 1000 });
    const pending = link.resolve({ ...NO_COMMAND, tool: "Write", summary: "Write path=a.txt" });
    await tick();
    await link.cancel();
    expect((await pending).decision).toBe("deny");
  });
});
```

- [ ] **Step 2: Run to verify the first two fail**

Run: `timeout 60 bun test test/unit/interaction/ask-link.test.ts --timeout=5000`
Expected: "two command-less asks" and "two tools" FAIL (one shared prompt). The other two pass already.

- [ ] **Step 3: Implement** — replace the key/lookup/insert block in `resolve`:

```ts
    // Review #21: the tool is part of the key, and a command-less ask (Write,
    // Edit, argv-only Exec) is never joined: two different writes must not
    // share one answer. It still enters liveSessions under a unique key so
    // cancel() and settle-time cleanup reach it.
    const key = command === "" ? undefined : `${req.stage}\u0000${req.tool}\u0000${command}`;
    const existing = key === undefined ? undefined : liveSessions.get(key);
    if (existing !== undefined && !existing.settled) {
      notifyWaiting(control, req);
      return attachWaiter(existing, control).done;
    }
    const session: Session = {
      id: `ask-${Math.random().toString(16).slice(2, 10)}`,
      waiters: new Set(),
      settled: false,
      cancelledOnChain: false,
    };
    liveSessions.set(key ?? `\u0001${session.id}`, session);
```
Update the comment at `:419` ("keyed by `${stage}\0${command}`") to the new key.

- [ ] **Step 4: Run the suite**

Expected: PASS.

- [ ] **Step 5: Gates and commit**

```bash
bun run typecheck && bun run check:all
git add src/interaction/ask-link.ts test/unit/interaction/ask-link.test.ts
git commit -m "fix(interaction): key ask dedupe on tool; never join command-less asks (#21)"
```

---

### Task 6: Root-scoped safety config and ADR-031 (§2, #10)

**Files:**
- Create: `src/config/root-only-keys.ts`
- Modify: `src/config/index.ts:7` (export next to `mergePackageConfig`)
- Modify: `src/config/loader.ts` (import; one call after the profile loop ends at `:555`; delete the `#574` comment `:579-581`)
- Modify: `src/runtime/packages.ts:3,190`
- Modify: `src/execution/lifecycle/acceptance-fix-scope.ts:46`
- Modify: `src/finish/phase.ts:286`, `src/execution/lifecycle/run-regression.ts:452` (comment only), `src/agents/coding-tool-support.ts:538` (comment only)
- Create: `docs/adr/ADR-031-root-scoped-command-safety-config.md`; Modify: `docs/adr/ADR-030-bash-approval-modes.md` (See also line)
- Test: `test/unit/config/root-only-keys.test.ts` (new), `test/unit/config/loader-workdir.test.ts`, `test/unit/runtime/packages.test.ts`, `test/unit/execution/lifecycle/acceptance-fix-scope.test.ts`

**Interfaces:**
- Produces: `ROOT_ONLY_EXECUTION_KEYS: readonly ["bashApproval", "approvalTimeout", "sandbox", "commandSafety"]`, `pinRootOnlyKeys(merged: NaxConfig, root: NaxConfig): NaxConfig`, `pinRootOnlyKeysRaw(raw: Record<string, unknown>, root: NaxConfig, packageDir: string, onIgnored: (msg: string) => void): Record<string, unknown>` — from `@/config`.

- [ ] **Step 1: Write the failing unit test** — `test/unit/config/root-only-keys.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { pinRootOnlyKeys, pinRootOnlyKeysRaw } from "@/config";

const root = makeNaxConfig({ execution: { bashApproval: "escalate", approvalTimeout: 120_000 } });

describe("pinRootOnlyKeys", () => {
  test("takes the four keys from root and leaves permissions alone", () => {
    const pkg = makeNaxConfig({
      execution: {
        bashApproval: "raw",
        approvalTimeout: 60_000,
        sandbox: { enabled: true },
        permissions: { run: { bashApproval: "gated", allow: ["Bash(ls *)"] } },
      },
    });
    const out = pinRootOnlyKeys(pkg, root);
    expect(out.execution.bashApproval).toBe("escalate");
    expect(out.execution.approvalTimeout).toBe(120_000);
    expect(out.execution.sandbox).toEqual(root.execution.sandbox);
    expect(out.execution.permissions).toEqual(pkg.execution.permissions);
  });
});

describe("pinRootOnlyKeysRaw", () => {
  test("warns once per differing key, naming the package", () => {
    const warnings: string[] = [];
    const raw = { execution: { ...root.execution, bashApproval: "raw", commandSafety: { shadow: {} } } };
    const out = pinRootOnlyKeysRaw(raw, root, "packages/api", (m) => warnings.push(m));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("execution.bashApproval is root-only (ADR-031)");
    expect(warnings[0]).toContain('"packages/api"');
    expect((out.execution as Record<string, unknown>).bashApproval).toBe("escalate");
    expect("commandSafety" in (out.execution as Record<string, unknown>)).toBe(false);
  });

  test("no warning when the values equal root's", () => {
    const warnings: string[] = [];
    pinRootOnlyKeysRaw({ execution: { ...root.execution } }, root, "packages/api", (m) => warnings.push(m));
    expect(warnings).toHaveLength(0);
  });
});
```

If `makeNaxConfig` rejects a partial `sandbox`/`commandSafety`, build those fields with `DEFAULT_SANDBOX_CONFIG` spread (`@/config/schemas-sandbox`).

- [ ] **Step 2: Run to verify it fails**

Run: `timeout 60 bun test test/unit/config/root-only-keys.test.ts --timeout=5000`
Expected: FAIL — `pinRootOnlyKeys` not exported.

- [ ] **Step 3: Write `src/config/root-only-keys.ts`**

```ts
/**
 * ADR-031: the agent-command safety knobs are root-scoped. A package config or
 * package profile that sets one is warned about and ignored. The permissions
 * map (including per-stage bashApproval) and permissionProfile stay
 * per-package: a package's permissions map REPLACES root's, and a stage's
 * rules resolve through that map, so pinning a per-stage mode would change
 * which block a stage's allow/deny come from.
 */
import type { NaxConfig } from "./schema";

export const ROOT_ONLY_EXECUTION_KEYS = ["bashApproval", "approvalTimeout", "sandbox", "commandSafety"] as const;

const ROOT_ONLY = new Set<string>(ROOT_ONLY_EXECUTION_KEYS);

/** Typed form, for callers holding a parsed config (runtime/packages.ts). Silent. */
export function pinRootOnlyKeys(merged: NaxConfig, root: NaxConfig): NaxConfig {
  return {
    ...merged,
    execution: {
      ...merged.execution,
      bashApproval: root.execution.bashApproval,
      approvalTimeout: root.execution.approvalTimeout,
      sandbox: root.execution.sandbox,
      commandSafety: root.execution.commandSafety,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Raw form, for loadConfigForWorkdir before safeParse. Warns per differing key. */
export function pinRootOnlyKeysRaw(
  raw: Record<string, unknown>,
  root: NaxConfig,
  packageDir: string,
  onIgnored: (msg: string) => void,
): Record<string, unknown> {
  const execution = isRecord(raw.execution) ? raw.execution : {};
  const rootExecution: Record<string, unknown> = { ...root.execution };
  for (const key of ROOT_ONLY_EXECUTION_KEYS) {
    if (key in execution && !Bun.deepEquals(execution[key], rootExecution[key])) {
      onIgnored(`execution.${key} is root-only (ADR-031); the value set for package "${packageDir}" is ignored`);
    }
  }
  const rest = Object.fromEntries(Object.entries(execution).filter(([k]) => !ROOT_ONLY.has(k)));
  const pinned = Object.fromEntries(
    ROOT_ONLY_EXECUTION_KEYS.flatMap((k) => (rootExecution[k] === undefined ? [] : [[k, rootExecution[k]]])),
  );
  return { ...raw, execution: { ...rest, ...pinned } };
}
```

`src/config/index.ts`: `export { pinRootOnlyKeys, pinRootOnlyKeysRaw, ROOT_ONLY_EXECUTION_KEYS } from "./root-only-keys";`

- [ ] **Step 4: Run the unit test**

Expected: PASS.

- [ ] **Step 5: Write the failing integration tests**

`test/unit/config/loader-workdir.test.ts`, inside the existing `describe` (its `beforeEach` makes `tempDir` and `.nax`):
```ts
  test("ADR-031: a package config cannot override the root-only safety keys", async () => {
    writeFileSync(join(tempDir, ".nax", "config.json"), JSON.stringify({ execution: { bashApproval: "escalate" } }));
    mkdirSync(join(tempDir, ".nax", "mono", "packages", "api"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "mono", "packages", "api", "config.json"),
      JSON.stringify({ execution: { bashApproval: "raw", permissions: { run: { bashApproval: "gated" } } } }),
    );
    const captured: string[] = [];
    resetLogger();
    initLogger({ level: "warn" });
    const removeSink = addSink((entry) => captured.push(entry.message));
    try {
      const cfg = await loadConfigForWorkdir(join(tempDir, ".nax", "config.json"), "packages/api");
      expect(cfg.execution.bashApproval).toBe("escalate");
      // Review Focus 5: the per-stage mode in the package's permissions map still applies.
      expect(cfg.execution.permissions?.run?.bashApproval).toBe("gated");
    } finally {
      removeSink();
      resetLogger();
    }
    expect(captured.some((m) => m.includes("execution.bashApproval is root-only"))).toBe(true);
  });

  test("ADR-031: a package profile cannot override a root-only key", async () => {
    writeFileSync(join(tempDir, ".nax", "config.json"), JSON.stringify({ execution: { bashApproval: "escalate" } }));
    mkdirSync(join(tempDir, ".nax", "mono", "packages", "api"), { recursive: true });
    writeFileSync(join(tempDir, ".nax", "mono", "packages", "api", "config.json"), JSON.stringify({ profile: "loose" }));
    mkdirSync(join(tempDir, "packages", "api", ".nax", "profiles"), { recursive: true });
    writeFileSync(
      join(tempDir, "packages", "api", ".nax", "profiles", "loose.json"),
      JSON.stringify({ execution: { bashApproval: "raw" } }),
    );
    const cfg = await loadConfigForWorkdir(join(tempDir, ".nax", "config.json"), "packages/api");
    expect(cfg.execution.bashApproval).toBe("escalate");
  });
```
(Check the existing package-profile test near `:323-327` for the exact profile path and copy it if it differs.)

`test/unit/runtime/packages.test.ts`, in `describe("PackageRegistry.hydrate — per-package merge")`:
```ts
  test("ADR-031: a hydrated package view carries root's root-only keys", async () => {
    const loader = createConfigLoader(makeNaxConfig({ execution: { bashApproval: "escalate" } }));
    const registry = createPackageRegistry(loader, "/repo");
    await registry.hydrate(["packages/agent"], async (_root, dir) =>
      dir === "packages/agent" ? makeNaxConfig({ execution: { bashApproval: "raw" } }) : null,
    );
    expect(registry.resolve("packages/agent").config.execution.bashApproval).toBe("escalate");
  });
```

`test/unit/execution/lifecycle/acceptance-fix-scope.test.ts`, in `describe("openAcceptanceFixScope")`:
```ts
  test("ADR-031: the dispatch wiring gets the root config; the fix cycle keeps the package config", async () => {
    const built: RunDispatchAskOptions[] = [];
    _acceptanceFixScopeDeps.buildRunDispatchAskWiring = async (opts) => {
      built.push(opts);
      return fakeWiring().wiring;
    };
    const base = makeMockRuntime();
    const pkgConfig = makeNaxConfig({ quality: { commands: { lint: "pkg-lint" } } });
    const pkgView = { ...base.packages.resolve("packages/api"), hasOverride: true, config: pkgConfig };
    const runtime = { ...base, packages: { ...base.packages, resolve: () => pkgView } };
    const source = makeSource();
    const scope = await openAcceptanceFixScope(source, runtime, "US-002", "packages/api");
    expect(built[0]?.config).toBe(source.config);
    expect(scope.cycleCtx.config).toBe(pkgConfig);
    await scope.dispose();
  });
```
If the spread `runtime` does not satisfy the parameter type, build it with the helper's override parameter if `makeMockRuntime` accepts one (check `test/helpers`), rather than casting.

- [ ] **Step 6: Run to verify they fail**

Run: `timeout 60 bun test test/unit/config/loader-workdir.test.ts test/unit/runtime/packages.test.ts test/unit/execution/lifecycle/acceptance-fix-scope.test.ts --timeout=5000`
Expected: the four new tests FAIL.

- [ ] **Step 7: Wire the call sites**

`loader.ts`: add `import { pinRootOnlyKeysRaw } from "./root-only-keys";` after the `./merge` import (`:28`). Right after the closing `}` of the `if (packageChain.length > 0) { ... }` block (`:555`), add:
```ts
  rawMerged = pinRootOnlyKeysRaw(rawMerged, rootConfig, packageDir, warnDedupe.warn);
```
Delete the three-line historical comment beginning `// #574's single-shim patch here` (`:579-581`). Verify: `wc -l src/config/loader.ts` prints 599. There is exactly one line of margin: add no blank line or extra comment.

`runtime/packages.ts`: import `pinRootOnlyKeys` alongside `mergePackageConfig` (`:3`), and at `:190`:
```ts
        mergedConfigs.set(dir, pinRootOnlyKeys(mergePackageConfig(loader.current(), override), loader.current()));
```

`acceptance-fix-scope.ts:46`: `config: ctx.config,` (keep `effectiveConfig` for `cycleCtx.config`), with a one-line comment: `// ADR-031: the wiring reads only root-scoped keys.`

- [ ] **Step 8: Comments that ADR-031 makes true**

- `finish/phase.ts` above `:286`: `// ADR-031: a whole-feature op uses root config, including root's permissions map.`
- `run-regression.ts` above the `buildRunDispatchAskWiring` call (`:452`): same comment.
- `coding-tool-support.ts:538`: reword to `// execution.sandbox is root-scoped (ADR-031): package configs cannot override it.`

- [ ] **Step 9: Write ADR-031** — `docs/adr/ADR-031-root-scoped-command-safety-config.md`, following ADR-030's heading style (read its first 40 lines for the template). Sections and required content:

- **Status:** Accepted, 2026-09-24.
- **Context:** review #10; `mergePackageConfig` spread leaks `execution.bashApproval`, `approvalTimeout`, `sandbox`, `commandSafety` into package configs, undocumented; package profiles deep-merge after the merge; finish, run-regression and acceptance-fix are whole-feature ops that can span packages; `interaction` (the approval channel) is already root-only.
- **Decision:** the four keys are root-only; a package config or package profile that sets one gets a warning (`execution.<key> is root-only (ADR-031)...`) and root's value applies. Enforced in `loadConfigForWorkdir` (after package profiles) and `packages.hydrate`.
- **Exception:** `execution.permissions` (including per-stage `bashApproval`) and `permissionProfile` stay per-package. A package's permissions map replaces root's; a stage's rules resolve block -> `inherit` -> `default` through it; pinning a per-stage mode would change which block supplies allow/deny.
- **Alternatives rejected:** strictest-merge across a feature's packages (still guesses for one multi-package agent); one dispatch per package group (restructures finish); a hard validation error (nax exits 0 on validation errors, so scripts would not notice); pinning per-stage modes (above).
- **Consequences:** no per-package stricter top-level mode: tighten root, or set a per-stage mode in the package's permissions map. `collectEffectiveRunStageModes` stays correct; simplifying it is deferred. Existing package configs that set these keys change behaviour (warned).
- **See also:** ADR-030, D18/D20 (native coding agent master plan), review #10.

ADR-030: add under its existing "See also"/references area (or at the end if none): `- ADR-031: the bash approval mode, approval timeout, sandbox and command-safety keys are root-scoped.`

- [ ] **Step 10: Run the tests**

Run: `timeout 60 bun test test/unit/config/root-only-keys.test.ts test/unit/config/loader-workdir.test.ts test/unit/runtime/packages.test.ts test/unit/execution/lifecycle/acceptance-fix-scope.test.ts test/unit/config/merge.test.ts --timeout=5000`
Expected: PASS.

- [ ] **Step 11: Gates and commit**

Run: `bun run typecheck && bun run check:all` (`check-file-sizes` must pass with `loader.ts` <= 600; `check-bash-dispatch-ask` must still pass).

```bash
git add src/config/root-only-keys.ts src/config/index.ts src/config/loader.ts src/runtime/packages.ts src/execution/lifecycle/acceptance-fix-scope.ts src/finish/phase.ts src/execution/lifecycle/run-regression.ts src/agents/coding-tool-support.ts docs/adr/ADR-031-root-scoped-command-safety-config.md docs/adr/ADR-030-bash-approval-modes.md test/unit/config/root-only-keys.test.ts test/unit/config/loader-workdir.test.ts test/unit/runtime/packages.test.ts test/unit/execution/lifecycle/acceptance-fix-scope.test.ts
git commit -m "feat(config): root-scope the agent-command safety keys (ADR-031, #10)"
```

---

### Task 7: Sandbox policy pre-check at session start (§3, #17)

**Files:**
- Modify: `src/agents/coding-tool-sandbox.ts:41-83`
- Test: `test/unit/agents/coding-tool-sandbox.test.ts`

- [ ] **Step 1: Write the failing tests** — inside `describe("resolveSessionSandbox")` (it already has `withDepsRestore(_sessionSandboxDeps)`, `root`, `enabled`):

```ts
  test("#17: a glob character in the root makes the sandbox unavailable at session start", async () => {
    const globRoot = join(root, "re[x]po");
    mkdirSync(globRoot);
    _sessionSandboxDeps.backendFor = () => makeFakeSandboxBackend();
    _sessionSandboxDeps.probe = async () => ({ available: true });
    _sessionSandboxDeps.gitLayout = async () => ({ kind: "main", gitDir: `${globRoot}/.git` });
    _sessionSandboxDeps.gitGuardFiles = async () => [];
    const l = await resolveSessionSandbox({ config: enabled, root: globRoot, needsLauncher: true });
    expect(l.state.kind).toBe("unavailable");
    expect(l.state.kind === "unavailable" ? l.state.reason : "").toContain("re[x]po");
    expect(rawRefusalFor(l)).toBeDefined();
  });

  test("#17: a policy error that is not a glob still propagates", async () => {
    _sessionSandboxDeps.backendFor = () => makeFakeSandboxBackend();
    _sessionSandboxDeps.probe = async () => ({ available: true });
    _sessionSandboxDeps.gitLayout = async () => ({ kind: "main", gitDir: `${root}/.git` });
    _sessionSandboxDeps.featurePrds = async () => {
      throw new Error("boom");
    };
    await expect(resolveSessionSandbox({ config: enabled, root, needsLauncher: true })).rejects.toThrow("boom");
  });
```
Add `import { mkdirSync } from "node:fs"; import { join } from "node:path";`.

- [ ] **Step 2: Run to verify the first fails**

Run: `timeout 60 bun test test/unit/agents/coding-tool-sandbox.test.ts --timeout=5000`
Expected: test 1 FAILS (`available`); test 2 FAILS (no error at session start).

- [ ] **Step 3: Implement** — after `policyFor` is defined and before `commonDirTripwire`:

```ts
  // Review #17: literal() refuses a glob character in any policy path, and the
  // probe builds its own policy, so a repo path like `re[x]po` passed the probe
  // and then failed every command. Build the policy once here instead.
  // Residual: a feature directory created mid-run with a glob character still
  // fails per command.
  const policyError = await literalPolicyError(policyFor, args.root);
  if (policyError !== undefined) {
    warnSandboxUnavailableOnce(policyError, args.storyId);
    return createCommandLauncher({ state: { kind: "unavailable", backend: backend.name, reason: policyError } });
  }
```
and at module level:
```ts
async function literalPolicyError(
  policyFor: (root: string) => Promise<unknown>,
  root: string,
): Promise<string | undefined> {
  try {
    await policyFor(root);
    return undefined;
  } catch (err) {
    if (err instanceof NaxError && err.code === "SANDBOX_POLICY_NOT_LITERAL") {
      return `[sandbox] a path in the sandbox policy contains a glob character: ${String(err.context?.path ?? "")}`;
    }
    throw err;
  }
}
```
with `import { NaxError } from "@/errors";`.

- [ ] **Step 4: Run the file**

Expected: PASS (new and existing).

- [ ] **Step 5: Gates and commit**

```bash
bun run typecheck && bun run check:all
git add src/agents/coding-tool-sandbox.ts test/unit/agents/coding-tool-sandbox.test.ts
git commit -m "fix(sandbox): refuse a non-literal policy path at session start (#17)"
```

---

### Task 8: `before_turn_end` on the error path (§6, #20)

**Files:**
- Modify: `src/agents/native/session/loop-events/types.ts:176-183`
- Create: `src/agents/native/session/turn-end-event.ts`
- Modify: `src/agents/native/session/turn-loop.ts:386-391` (payload) and the `catch` at `:414`
- Test: `test/unit/agents/native/session/loop-events/before-turn-end.test.ts`

**Interfaces:**
- Produces: `BeforeTurnEndPayload.ended: "completed" | "aborted" | "errored"`; `dispatchTurnEndOnError(loopEvents: LoopEventRegistry, payload: Omit<BeforeTurnEndPayload, "ended">, signal?: AbortSignal): Promise<void>`. Task 9's tests build a `before_turn_end` payload with `ended`.

- [ ] **Step 1: Write the failing tests** — append to `before-turn-end.test.ts` (it has `handle`, `baseOpts`, `reply`, `createLoopEventRegistry`, `runNativeTurn`):

```ts
describe("review #20: before_turn_end on the error path", () => {
  test("a normal ending reports ended=completed", async () => {
    const registry = createLoopEventRegistry();
    const ended: string[] = [];
    registry.register("before_turn_end", (p) => {
      ended.push(p.ended);
      return {};
    });
    await runNativeTurn(handle, "hi", baseOpts(), { loopEvents: registry, complete: async () => reply({ text: "done" }) });
    expect(ended).toEqual(["completed"]);
  });

  test("a throwing turn fires once with ended=errored and rethrows the same error", async () => {
    const registry = createLoopEventRegistry();
    const ended: string[] = [];
    registry.register("before_turn_end", (p) => {
      ended.push(p.ended);
      return { followUp: "ignored" };
    });
    const boom = new Error("provider down");
    const err = await runNativeTurn(handle, "hi", baseOpts(), {
      loopEvents: registry,
      complete: async () => {
        throw boom;
      },
    }).catch((e: unknown) => e);
    expect(err).toBe(boom);
    expect(ended).toEqual(["errored"]);
  });

  test("an aborted turn reports ended=aborted", async () => {
    const registry = createLoopEventRegistry();
    const ended: string[] = [];
    registry.register("before_turn_end", (p) => {
      ended.push(p.ended);
      return {};
    });
    const ac = new AbortController();
    // deps.signal (4th argument) is what the catch reads; opts.signal alone is not threaded into it.
    await runNativeTurn(handle, "hi", baseOpts({ signal: ac.signal }), {
      loopEvents: registry,
      signal: ac.signal,
      complete: async () => {
        ac.abort();
        throw new DOMException("aborted", "AbortError");
      },
    }).catch(() => undefined);
    expect(ended).toEqual(["aborted"]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `timeout 60 bun test test/unit/agents/native/session/loop-events/before-turn-end.test.ts --timeout=5000`
Expected: typecheck-level failure or `ended` undefined / empty arrays.

- [ ] **Step 3: Implement**

`types.ts`, in `BeforeTurnEndPayload`:
```ts
  /**
   * How the turn ended. "completed" includes a stop (spin, invalid-call budget,
   * deadline) -- see `stopped`. "aborted" means the turn signal fired (caller,
   * idle watchdog or whole-turn deadline); "errored" is any other throw.
   * On "aborted"/"errored" the result is ignored (review #20).
   */
  readonly ended: "completed" | "aborted" | "errored";
```

`turn-end-event.ts`:
```ts
/**
 * Review #20: `before_turn_end` also fires when a turn throws, so a handler
 * sees every ending. The result is ignored on this path -- there is no turn
 * left to continue. Handlers are awaited without a timeout; only built-ins
 * register today.
 */
import { getSafeLogger } from "@/logger";
import type { LoopEventRegistry } from "./loop-events";
import type { BeforeTurnEndPayload } from "./loop-events/types";

export async function dispatchTurnEndOnError(
  loopEvents: LoopEventRegistry,
  payload: Omit<BeforeTurnEndPayload, "ended">,
  signal?: AbortSignal,
): Promise<void> {
  const patch = await loopEvents.dispatch("before_turn_end", {
    ...payload,
    ended: signal?.aborted === true ? "aborted" : "errored",
  });
  if (patch.followUp !== undefined) {
    getSafeLogger()?.warn("native-loop-events", "before_turn_end followUp ignored on error path", {});
  }
}
```
(If `LoopEventRegistry` is not exported from `./loop-events`, import it from `./loop-events/registry`.)

`turn-loop.ts`: add `ended: "completed",` to the in-try dispatch payload (`:386-391`). At the top of the `catch (err) {` block:
```ts
    await dispatchTurnEndOnError(
      loopEvents,
      { messages, roundTrips, stopped: spinStopped || invalidCallBudget.exceeded || timedOut, followUpsSoFar },
      deps.signal,
    );
```
Import `dispatchTurnEndOnError` from `./turn-end-event`.

Then find every other construction of a `before_turn_end` payload: `grep -rn "before_turn_end" src test | grep -v register`; add `ended` wherever a payload literal is built (typecheck will list them).

- [ ] **Step 4: Run the loop-event suites**

Run: `timeout 60 bun test test/unit/agents/native/session/loop-events/ --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Gates and commit**

```bash
bun run typecheck && bun run check:all
git add src/agents/native/session test/unit/agents/native/session/loop-events/before-turn-end.test.ts
git commit -m "fix(native): fire before_turn_end when a turn throws (#20)"
```

---

### Task 9: Detect and undo in-place payload mutation (§5, #19)

**Files:**
- Create: `src/agents/native/session/loop-events/payload-guard.ts`
- Modify: `src/agents/native/session/loop-events/registry.ts:123-158` (`dispatchBeforeTool`), `:165-218` (`dispatchChain`)
- Test: `test/unit/agents/native/session/loop-events/payload-guard.test.ts` (new)

**Interfaces:**
- Consumes: `BeforeTurnEndPayload` with `ended` (Task 8).
- Produces: `snapshotArrays(payload: object): ArraySnapshot`, `restoreMutated(snapshot: ArraySnapshot, event: string, handlerIndex: number): void`.

- [ ] **Step 1: Write the failing test** — `payload-guard.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { createLoopEventRegistry } from "@/agents/native/session/loop-events";
import type { BeforeTurnEndPayload } from "@/agents/native/session/loop-events/types";
import { addSink, initLogger, resetLogger } from "@/logger";
import type { LogEntry } from "@/logger/types";

async function captureWarnings(run: () => Promise<unknown>): Promise<LogEntry[]> {
  const logCalls: LogEntry[] = [];
  resetLogger();
  initLogger({ level: "info", suppressConsole: true });
  addSink((entry) => logCalls.push(entry));
  try {
    await run();
  } finally {
    resetLogger();
  }
  return logCalls.filter((e) => e.level === "warn");
}

function turnEnd(messages: BeforeTurnEndPayload["messages"]): BeforeTurnEndPayload {
  return { messages, roundTrips: 1, stopped: false, followUpsSoFar: 0, ended: "completed" };
}

const pushInto = (arr: readonly unknown[], item: unknown): void => {
  Reflect.apply(Array.prototype.push, arr, [item]);
};

describe("review #19: in-place payload mutation", () => {
  test("a push is detected, warned and undone on the same array", async () => {
    const registry = createLoopEventRegistry();
    registry.register("before_turn_end", (p) => {
      pushInto(p.messages, { role: "user", content: "sneaky" });
      return {};
    });
    const messages: BeforeTurnEndPayload["messages"] = [{ role: "user", content: "hi" }];
    const warnings = await captureWarnings(() => registry.dispatch("before_turn_end", turnEnd(messages)));
    expect(messages).toHaveLength(1);
    expect(warnings.some((w) => w.message.includes("mutated payload in place"))).toBe(true);
  });

  test("a splice is undone and the original element references come back", async () => {
    const registry = createLoopEventRegistry();
    registry.register("before_turn_end", (p) => {
      Reflect.apply(Array.prototype.splice, p.messages, [0, 1]);
      return {};
    });
    const first = { role: "user" as const, content: "hi" };
    const messages: BeforeTurnEndPayload["messages"] = [first];
    await captureWarnings(() => registry.dispatch("before_turn_end", turnEnd(messages)));
    expect(messages[0]).toBe(first);
  });

  test("a handler that mutates and returns nothing never changes the dispatch result", async () => {
    const registry = createLoopEventRegistry();
    registry.register("before_turn_end", () => ({ followUp: "next" }));
    const messages: BeforeTurnEndPayload["messages"] = [{ role: "user", content: "hi" }];
    const patch = await registry.dispatch("before_turn_end", turnEnd(messages));
    expect(patch.followUp).toBe("next");
  });

  test("before_tool: a tools.push is undone", async () => {
    const registry = createLoopEventRegistry();
    registry.register("before_tool", (p) => {
      pushInto(p.tools, { name: "Evil", description: "", inputSchema: {} });
      return { kind: "allow" };
    });
    const tools = [{ name: "Read", description: "read", inputSchema: {} }];
    await captureWarnings(() =>
      registry.dispatch("before_tool", { call: { id: "c1", name: "Read", input: {} }, tools }),
    );
    expect(tools).toHaveLength(1);
  });
});
```
Match the message shape and `ToolDefinition` shape to `types.ts` if these literals do not typecheck (e.g. `inputSchema` may need `{ type: "object" }`).

- [ ] **Step 2: Run to verify it fails**

Run: `timeout 60 bun test test/unit/agents/native/session/loop-events/payload-guard.test.ts --timeout=5000`
Expected: FAIL (arrays grew / shrank; no warning).

- [ ] **Step 3: Write `payload-guard.ts`**

```ts
/**
 * Review #19: the cache boundary judges only RETURNED patches, but handlers
 * receive the loop's live arrays (history, messages, tools). A handler that
 * edits one in place would rewrite the transcript and the prompt-cache
 * prefix unseen. Dispatch snapshots every array field before each handler and
 * undoes an in-place change afterwards, keeping the SAME array object with
 * its original elements.
 *
 * Not detected: edits INSIDE an element (a message's fields). Deep-freezing
 * is not an option: the payload is live, and the loop itself pushes onto
 * `messages` after a follow-up; freezing a clone would break the reference
 * identity checkPrefixStable relies on.
 */
import { getSafeLogger } from "@/logger";

interface ArrayRecord {
  readonly field: string;
  readonly array: unknown[];
  readonly saved: readonly unknown[];
}

export type ArraySnapshot = readonly ArrayRecord[];

export function snapshotArrays(payload: object): ArraySnapshot {
  return Object.entries(payload).flatMap(([field, value]) =>
    Array.isArray(value) ? [{ field, array: value, saved: [...value] }] : [],
  );
}

export function restoreMutated(snapshot: ArraySnapshot, event: string, handlerIndex: number): void {
  for (const { field, array, saved } of snapshot) {
    const changed = array.length !== saved.length || saved.some((item, i) => array[i] !== item);
    if (!changed) continue;
    getSafeLogger()?.warn("native-loop-events", "handler mutated payload in place; restored", {
      event,
      handler: handlerIndex,
      field,
    });
    // Deliberate in-place restore: the caller holds this exact array object.
    array.splice(0, array.length, ...saved);
  }
}
```

- [ ] **Step 4: Wire it into both dispatchers** (`registry.ts`; import from `./payload-guard`)

`dispatchChain`, after the empty fast path — change the loop header and wrap the handler call:
```ts
  for (const [index, handler] of handlers.entries()) {
    const snapshot = snapshotArrays(current);
    let returned: unknown;
    try {
      returned = await handler(current);
    } catch (err) {
      // ...existing warn, unchanged...
      continue;
    } finally {
      restoreMutated(snapshot, event, index);
    }
```

`dispatchBeforeTool`:
```ts
  for (const [index, handler] of handlers.entries()) {
    let outcome: BeforeToolOutcome;
    const snapshot = snapshotArrays({ tools });
    try {
      outcome = await (handler as HandlerOf<"before_tool">)({
        call: { ...call, input: input ?? call.input },
        tools,
      });
    } catch (err) {
      // ...existing warn, unchanged...
      continue;
    } finally {
      restoreMutated(snapshot, "before_tool", index);
    }
```

- [ ] **Step 5: Run the loop-event suites**

Run: `timeout 60 bun test test/unit/agents/native/session/loop-events/ test/unit/agents/native/session/ --timeout=5000`
Expected: PASS. If an existing test relied on a handler mutating in place, it now fails by design — report it rather than weakening the guard.

- [ ] **Step 6: Gates and commit**

```bash
bun run typecheck && bun run check:all
git add src/agents/native/session/loop-events test/unit/agents/native/session/loop-events/payload-guard.test.ts
git commit -m "fix(native): undo in-place loop-event payload mutation (#19)"
```

---

### Task 10: Composite tests (§9)

**Files (test only):**
- Modify: `test/integration/permissions/bash-deny-suite.test.ts` (`session()` `:59-82` gains `launcher?` and `commandShadow?`)
- Modify: `test/integration/sandbox/sandbox-live.test.ts` (`bash()` `:70-93` gains `bashApproval?` and `askResolver?`)
- Modify: `test/integration/permissions/approval-gate.test.ts`
- Modify: `test/unit/agents/native/session/loop-events/turn-lifecycle.test.ts`
- Modify: `test/unit/tools/runtime-sandbox-argv.test.ts`

These pin behaviour that already exists; each should PASS on first run. If one fails, stop and report it — it is a finding, not a test to adjust.

- [ ] **Step 1: escalate + sandbox + shadow, one command, same bytes** — `bash-deny-suite.test.ts`. Extend `session()` options with `launcher?: CommandLauncher` and `commandShadow?: CommandShadow`, spreading them into `buildCodingToolSupport`. Put `...(options?.commandShadow !== undefined ? { commandShadow: options.commandShadow } : {})` AFTER the existing `suiteShadow` spread (`:80`) so the explicit shadow wins. Add imports `makeCommandShadowRecorder, makeFakeSandboxBackend` from `@test/helpers` and `createCommandLauncher, type CommandLauncher` from `@/sandbox`. Add, OUTSIDE the `describe.each`:

```ts
describe("composite: escalate + sandbox + shadow (review test gap 1)", () => {
  test("the prompt, the shadow and the wrapped launch all see the same command bytes", async () => {
    const command = `printf '%s\\n' "a  b" > out.txt`;
    const asked: string[] = [];
    const askResolver = chainAskLinks([
      {
        name: "rec",
        resolve: async (req) => {
          asked.push(req.command ?? "");
          return { decision: "allow" as const, decidedBy: "human" as const };
        },
      },
    ]);
    const backend = makeFakeSandboxBackend("enforce");
    const launcher = createCommandLauncher({
      state: { kind: "available", backend: "srt", network: "open" },
      backend,
      policyFor: async (r: string) => ({ writeRoots: [r], denyWrite: [], denyRead: [], network: {} }),
    });
    const { shadow, observed } = makeCommandShadowRecorder();
    const outcome = await call(
      session({ allow: [], bashApproval: "escalate", askResolver, launcher, commandShadow: shadow }),
      command,
    );
    expect(outcome.kind).toBe("ok");
    expect(asked).toEqual([command]);
    expect(observed[0]?.[1].command).toBe(command);
    expect(JSON.stringify(backend.calls[0]?.spec)).toContain(JSON.stringify(command).slice(1, -1));
  });
});
```
(Check `Observation`'s field name in `src/command-safety/types.ts` — use it if it is not `command`.)

- [ ] **Step 2: human-approved then sandbox-denied** — `sandbox-live.test.ts`. Extend `bash()` opts with `bashApproval?: BashApprovalMode` and `askResolver?: AskResolver`, passing `bashApproval: opts.bashApproval ?? "raw"` and spreading `askResolver`. Add inside the `describe.skipIf`:

```ts
  test("review test gap 2: escalate + human approval does not let a write past the sandbox's protected path", async () => {
    const run = await bash({
      bashApproval: "escalate",
      askResolver: chainAskLinks([
        { name: "yes", resolve: async () => ({ decision: "allow" as const, decidedBy: "human" as const }) },
      ]),
    });
    await run("cd -P .nax && echo PWNED > config.json");
    expect(readFileSync(join(root, ".nax", "config.json"), "utf8")).toBe("{}\n");
  }, 30_000);
```

- [ ] **Step 3: cache hit under sandbox runs wrapped** — `approval-gate.test.ts`, inside the `describe`, after the existing cache-hit test. Add imports `makeFakeSandboxBackend` (`@test/helpers`) and `createCommandLauncher` (`@/sandbox`).

```ts
  test("review test gap 3: a cache hit under the sandbox still runs wrapped", async () => {
    const root = repo();
    const outside = makeTempDir("approvals-out-");
    const approvalsFile = approvalsPath(outside);
    const command = "echo cached";
    await appendApproval(approvalsFile, {
      stage: "run",
      command,
      root,
      origin: "escalate",
      matchedRule: null,
      approvedAt: "2026-09-22T10:00:00.000Z",
      approvedBy: "telegram:123",
      naxCommit: "7b37dbf74",
    });
    let consulted = 0;
    const humanSpy = {
      name: "human-spy",
      resolve: async () => {
        consulted++;
        return { decision: "allow" as const, decidedBy: "human" as const };
      },
    };
    const backend = makeFakeSandboxBackend("enforce");
    const launcher = createCommandLauncher({
      state: { kind: "available", backend: "srt", network: "open" },
      backend,
      policyFor: async (r: string) => ({ writeRoots: [r], denyWrite: [], denyRead: [], network: {} }),
    });
    const support = buildCodingToolSupport({
      root,
      declared: ["Bash"],
      grants: [{ tool: "Bash", patterns: ["echo *"] }],
      bashApproval: "escalate",
      pipelineStage: "run",
      launcher,
      askResolver: chainAskLinks([
        createApprovalsLink({
          approvalsFile,
          repoRoot: root,
          projectRoot: root,
          stageModes: ["escalate"],
          sandboxEnabled: true,
        }),
        humanSpy,
      ]),
    });
    const outcome = await support?.runtime.callTool("Bash", { command });
    expect(outcome?.kind).toBe("ok");
    expect(consulted).toBe(0);
    expect(backend.calls).toHaveLength(1);
    cleanupTempDir(root);
    cleanupTempDir(outside);
  });
```
(With `stageModes: ["escalate"]` no stage is forge-capable, so the link is enabled and trusts the hand-written entry; the fixture needs no extra field.)

- [ ] **Step 4: loop events around a permission ask** — `turn-lifecycle.test.ts`. The coding-tool call goes through `interactionHandler.onInteraction`, where the permission ask happens:

```ts
test("review test gap 4: before_tool fires before the ask, after_tool only after it settles", async () => {
  const order: string[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  const registry = createLoopEventRegistry();
  registry.register("before_tool", () => {
    order.push("before_tool");
    return { kind: "allow" };
  });
  registry.register("after_tool", () => {
    order.push("after_tool");
    return {};
  });
  let calls = 0;
  const turn = runNativeTurn(
    handle,
    "hi",
    opts({
      interactionHandler: {
        onInteraction: async () => {
          order.push("ask-open");
          await held;
          order.push("ask-settled");
          return { answer: "ok" };
        },
      },
    }),
    {
      loopEvents: registry,
      complete: async () => {
        calls += 1;
        return calls === 1
          ? { text: "", toolCalls: [{ id: "c1", name: "Read", input: { path: "a.ts" } }], usage, costUsd: 0 }
          : reply();
      },
    },
  );
  await waitForCondition(() => order.includes("ask-open"));
  expect(order).toEqual(["before_tool", "ask-open"]);
  release();
  await turn;
  expect(order).toEqual(["before_tool", "ask-open", "ask-settled", "after_tool"]);
});
```
Add `import { waitForCondition } from "@test/helpers";`. If `Read` needs a declared coding tool in this fixture, pass `codingTools` the way `before-turn-end.test.ts` does (`fakeRead`, `:61-69`) — copy that tool definition.

- [ ] **Step 5: sandbox wrap throw through `runtime.callTool`** — `runtime-sandbox-argv.test.ts`:

```ts
describe("review test gap 5: a throwing sandbox wrap through runtime.callTool", () => {
  test("error result, no execution, and an audit row", async () => {
    const backend = makeFakeSandboxBackend("throw");
    const launcher = createCommandLauncher({
      state: { kind: "available", backend: "srt", network: "open" },
      backend,
      policyFor: async (r: string) => ({ writeRoots: [r], denyWrite: [], denyRead: [], network: {} }),
    });
    const support = buildCodingToolSupport({
      root,
      declared: ["Bash"],
      grants: [{ tool: "Bash", patterns: ["*"] }],
      bashApproval: "raw",
      launcher,
      auditDir: join(root, "audit"),
      sessionName: "gap5",
    });
    const out = await support?.runtime.callTool("Bash", { command: "touch made.txt" });
    expect(out?.kind).toBe("error");
    expect(String(out && "content" in out ? out.content : "")).toContain("[sandbox] could not wrap the command");
    expect(existsSync(join(root, "made.txt"))).toBe(false);
    await support?.auditSink.flush();
    expect(readdirSync(join(root, "audit"))).toHaveLength(1);
  });
});
```
Imports: `existsSync, readdirSync` (`node:fs`), `join` (`node:path`), `makeFakeSandboxBackend` (`@test/helpers`), `buildCodingToolSupport` (`@/agents/coding-tool-support`), `createCommandLauncher` (`@/sandbox`). If `out.kind` is `"ok"` with the error text in `content`, assert on the content and file only, and note it in the commit body.

- [ ] **Step 6: Run the five files**

Run: `timeout 120 bun test test/integration/permissions/bash-deny-suite.test.ts test/integration/sandbox/sandbox-live.test.ts test/integration/permissions/approval-gate.test.ts test/unit/agents/native/session/loop-events/turn-lifecycle.test.ts test/unit/tools/runtime-sandbox-argv.test.ts --timeout=30000`
Expected: PASS (the live-sandbox test may SKIP with its reason in the title on a machine without a backend; on macOS it runs).

- [ ] **Step 7: Commit**

```bash
bun run typecheck && bun run check:all
git add test/integration/permissions test/integration/sandbox/sandbox-live.test.ts test/unit/agents/native/session/loop-events/turn-lifecycle.test.ts test/unit/tools/runtime-sandbox-argv.test.ts
git commit -m "test: composite coverage for ask, sandbox, shadow and loop-event seams"
```

---

### Task 11: Wording and docs (§4, §8; #8, #22)

**Files:**
- Modify: `src/tools/bash.ts:159-163`; `docs/adr/ADR-030-bash-approval-modes.md:136-151` (gaps) and `:242-252` (AskResolver chain prose)
- Modify: `src/cli/config-descriptions.ts`; `docs/guides/configuration.md`; `docs/guides/permissions.md` (See also, `:218`)
- Test: `test/unit/agents/coding-tool-bash.test.ts:84-100`, `test/unit/cli/config-descriptions.test.ts`

- [ ] **Step 1: Write the failing tests**

`coding-tool-bash.test.ts`, next to the raw-description assertions (`:95-100`), using the same description accessor:
```ts
    expect(description).toContain("exact file paths");
    expect(description).toContain("directory");
    expect(description).toContain("sh -c");
```

`config-descriptions.test.ts`:
```ts
import { ExecutionConfigSchema } from "@/config";
import { FIELD_DESCRIPTIONS } from "@/cli/config-descriptions";
import type { z } from "zod";

/** Unwraps optional/default/prefault/effects wrappers down to the inner schema. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  const inner = (schema as { _def?: { innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny } })._def;
  if (inner?.innerType !== undefined) return unwrap(inner.innerType);
  if (inner?.schema !== undefined) return unwrap(inner.schema);
  return schema;
}

function keyPaths(prefix: string, schema: z.ZodTypeAny): string[] {
  const s = unwrap(schema);
  const shape = (s as { shape?: Record<string, z.ZodTypeAny> }).shape;
  if (shape === undefined) return [prefix];
  return [prefix, ...Object.entries(shape).flatMap(([k, v]) => keyPaths(`${prefix}.${k}`, v))];
}

describe("review #22: execution safety keys are described", () => {
  const shape = ExecutionConfigSchema.shape;
  const required = [
    "execution.bashApproval",
    "execution.approvalTimeout",
    "execution.permissions.<stage>.bashApproval",
    ...keyPaths("execution.sandbox", shape.sandbox),
    ...keyPaths("execution.commandSafety", shape.commandSafety),
  ];
  test.each(required)("%s has a description", (key) => {
    expect(FIELD_DESCRIPTIONS[key]?.length ?? 0).toBeGreaterThan(0);
  });
});
```
If zod v4 exposes wrappers differently (e.g. `def` instead of `_def`), adjust `unwrap` to that API — check how `schemas-sandbox.ts` builds `SandboxConfigSchema` (`.prefault`) — and make sure `keyPaths("execution.sandbox", ...)` returns the nested keys (`.enabled`, `.backend`, `.filesystem.allowWrite`, ...). Print `required` once while developing to confirm. `test/` forbids `as unknown as`; the single `as { ... }` narrowings above are fine.

- [ ] **Step 2: Run to verify they fail**

Run: `timeout 60 bun test test/unit/agents/coding-tool-bash.test.ts test/unit/cli/config-descriptions.test.ts --timeout=5000`
Expected: FAIL (missing phrases; missing descriptions).

- [ ] **Step 3: Bash description** — replace `bash.ts:159-163` with (the trailing `nax-feature-dir-allow` comment must stay on the line that names `.nax/features/**/prd.json`; `scripts/check-feature-dir-ssot.ts` requires it):

```ts
    "The only refusal is a command the lexer CAN parse that names or redirects into one of the exact file " +
    "paths nax owns -- .nax/config.json, .nax/mono/*/config.json, " +
    ".nax/features/**/prd.json, or the root queue-control files -- change those through nax rather than by " + // nax-feature-dir-allow: prose naming the raw-mode protected-path screen, not a path construction
    "writing them directly. That screen is advisory, not a boundary: it matches exact file paths only, so a " +
    "command using command substitution, a directory target (cp x .nax/), a glob, a nested shell (sh -c '...'), " +
    "tar -C or dd of=, or a symlink alias all skip it; use the sandbox for a boundary. " +
```

- [ ] **Step 4: Descriptions** — add to `FIELD_DESCRIPTIONS` in `src/cli/config-descriptions.ts`, near the other `execution.*` entries:

```ts
  "execution.bashApproval":
    "How agent Bash commands are approved: raw (screened only), gated (policy decides), escalate (a human decides on ask). Root-only (ADR-031)",
  "execution.approvalTimeout":
    "Milliseconds an interactive permission prompt waits before denying (30000-3600000). Root-only (ADR-031)",
  "execution.permissions.<stage>.bashApproval": "Per-stage override of execution.bashApproval; stays per-package",
  "execution.sandbox": "OS sandbox for agent-authored commands. Root-only (ADR-031)",
  "execution.sandbox.enabled": "Run agent Bash/Exec commands inside the OS sandbox",
  "execution.sandbox.backend": "Sandbox backend implementation",
  "execution.sandbox.filesystem": "Filesystem policy additions for the sandbox",
  "execution.sandbox.filesystem.allowWrite": "Extra literal paths the sandbox may write (no glob characters)",
  "execution.sandbox.filesystem.denyRead": "Extra literal paths the sandbox may not read (no glob characters)",
  "execution.sandbox.network": "Network policy for sandboxed commands",
  "execution.sandbox.network.allowedDomains": "Domains sandboxed commands may reach; absent means open",
  "execution.commandSafety": "Shadow command classifier; observes every command, decides nothing. Root-only (ADR-031)",
  "execution.commandSafety.shadow": "Classifier endpoint settings; absent means off",
  "execution.commandSafety.shadow.url": "Classifier URL (loopback unless allowRemote)",
  "execution.commandSafety.shadow.timeoutMs": "Per-command classifier timeout in milliseconds",
  "execution.commandSafety.shadow.authEnv": "Name of the environment variable holding the classifier auth token",
  "execution.commandSafety.shadow.allowRemote":
    "Allow a non-loopback classifier URL. Sends every agent command verbatim off-host",
```
If the ratchet's `required` list contains keys not in this list (schema drift), add descriptions for them too.

- [ ] **Step 5: ADR-030 and guides**

ADR-030 `:136`: "Three gaps" -> "Six gaps". After gap 3 add:
```
4. The screen matches exact file paths. A directory target (`cp evil/config.json .nax/`,
   `cp -R evil/ .nax`) or a glob (`.nax/confi?.json`) names no protected file and passes.
5. Writers that take the target as an option or a nested script are not modelled:
   `tar -C .nax -xf x.tar`, `dd of=.nax/config.json`, `sh -c 'echo x > .nax/config.json'`.
6. A symlink alias (`ln -s .nax n && echo x > n/config.json`) passes: the screen does not
   resolve links.
```
ADR-030 `:242-252` describes the AskResolver chain in prose (not a literal list). Add one sentence there: "Before prompting, the human link masks inert secret spans in the command; when a secret span would contain shell syntax it denies without prompting, attributed `unshowable` (review #9)." (D18 itself lives only in the master plan; Task 12 amends it.)

`docs/guides/configuration.md`: add a section `## Bash Approval, Sandbox and Command Safety` listing the four root-only keys with one sentence each, the per-stage `permissions.<stage>.bashApproval` exception, and the `allowRemote` warning; link `../adr/ADR-031-root-scoped-command-safety-config.md` and `permissions.md`.

`docs/guides/permissions.md` See also: add links to that section and ADR-031.

- [ ] **Step 6: Run the two test files**

Expected: PASS.

- [ ] **Step 7: Gates and commit**

```bash
bun run typecheck && bun run check:all
git add src/tools/bash.ts src/cli/config-descriptions.ts docs/adr/ADR-030-bash-approval-modes.md docs/guides/configuration.md docs/guides/permissions.md test/unit/agents/coding-tool-bash.test.ts test/unit/cli/config-descriptions.test.ts
git commit -m "docs: honest raw-screen wording, safety-key descriptions and guide (#8, #22)"
```

---

### Task 12: Close-out and full verification

**Files:**
- Modify (outside the repo, not committed on this branch): `/Users/williamkhoo/workspace/subrina-coder/projects/nax/nax-native-agent-cross-phase-review-p0-p5-2026-09-24.md` (status table), `/Users/williamkhoo/workspace/subrina-coder/projects/nax/nax-native-coding-agent-master-plan.md` (D18 wording)

- [ ] **Step 1: Full gates**

Run: `bun run test && bun run typecheck && bun run check:all && bun run test:coverage`
Expected: all green. `test:coverage` gates per-file coverage; a new `src` module below the floor needs more tests in its owning task, never a baseline bump. Paste the summary lines into the task report. If anything fails, fix it in the task that owns the file, then re-run.

- [ ] **Step 2: Spec coverage check** — for each spec section §1-§9, name the commit that implements it (`git log --oneline main..HEAD`). Any gap: stop and report.

- [ ] **Step 3: Update the review status doc** — in the status table, mark #8, #9, #10, #17, #19, #20, #21, #22 as "FIXED on `feat/xreview-remaining` (unmerged)" with the commit ids; #14 "CLOSED, non-issue: single process, `fs/promises.appendFile` opens O_APPEND, one write per row"; #11 unchanged (OPEN).

- [ ] **Step 4: Amend D18 in the master plan** — replace the D18 heading line's "verbatim, or the gate denies" with "verbatim except inert secret spans, or the gate denies", and add one sentence: "Masking is refused when a masked span would contain shell syntax (review #9); the ask then denies as `unshowable`."

- [ ] **Step 5: Report** — list commits, test/gate results, and anything that deviated from this plan. Do not push or open a PR.
