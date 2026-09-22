# Interactive Approval Gate (P2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human approve or deny an escalated shell command from Telegram (or the terminal), by connecting the permission system's dormant `ask` tier to nax's existing interaction subsystem through a chain of adjudicator links.

**Architecture:** The `ask` tier already exists end to end (`src/tools/runtime.ts:379`) but always denies, because `askResolver` defaults to `headlessAskResolver()`. We replace that default with a **chain of `AskLink`s** — an approvals cache, a reserved slot for P5's classifier, and a human link that dispatches through the existing `InteractionChain` — terminating in deny. `src/interaction/` remains the only channel; the chain is the only permission decision point. No new interaction plugin is written.

**Tech Stack:** TypeScript on Bun. Zod for config schemas. `bun:test` for tests. Existing subsystems: `src/permissions/`, `src/tools/`, `src/interaction/` (chain + telegram/cli/webhook plugins), `src/config/`.

**Spec:** `docs/superpowers/specs/2026-09-22-p2-interactive-approval-gate-design.md` — **read it before Task 1.** The plan argues from it; where they disagree, the spec wins and you should stop and say so.

**Context for a fresh session:** This is phase 2 of the native-coding-agent arc. The arc's SSOT master plan lives OUTSIDE this repo at `../../nax-native-coding-agent-master-plan.md` (workspace `projects/nax/`), and its decisions D15–D20 govern this work. ADR-030 (`docs/adr/ADR-030-bash-approval-modes.md`) is phase 1 and is merged.

## Global Constraints

- **Branch:** `feat/p2-interactive-approval-gate`, already created, spec already committed on it.
- **Baseline:** `main` @ `7b37dbf74` (PR #2184 merge). All spec citations verified at that commit.
- **600-line limit on every file in `src/`.** Enforced by `scripts/check-file-sizes.ts`. `src/tools/runtime.ts`, `src/agents/coding-tool-support.ts` (582) and `src/tools/policy.ts` (583) are near it — put new code in NEW files.
- **Tests:** `bun run test` for the whole suite. NEVER `bun test` bare, NEVER `bun run nax`. Targeted: `bun test test/unit/permissions/ask-chain.test.ts --timeout=60000`.
- **Every commit runs a pre-commit hook** doing typecheck + 31 static checks. Expect ~60s. Do not bypass it.
- **`~/.nax` paths must use the approved helpers** — `scripts/check-no-real-global-nax.ts` fails the build on open-coded home paths. Use `projectOutputDir`/the `outputDir` already threaded on `AgentRunOptions`.
- **Single-gate rule:** gating lives in the policy/resolver only. Never add a "safe enough" check inside a tool.
- **Fail-closed everywhere:** anything unexpected denies. `abstain` is legal ONLY for a link followed by a stricter one.
- **Conventional commits** (`feat:`, `fix:`, `test:`, `docs:`). No attribution footers.
- **No emojis in code, comments or docs.**
- **Do not change any default.** `bashApproval` stays `raw`. Task 9 covers the corpus flip, which is config in a separate fixture repo, not in `src/`.

---

## File Structure

**New files (all small, one responsibility each):**

| File | Responsibility |
|---|---|
| `src/permissions/ask-chain.ts` | `AskDecision`/`AskLink`/`AskVerdict` types, `chainAskLinks()`, terminal deny |
| `src/permissions/approvals-store.ts` | read/append `approvals.json`, byte-exact lookup, file locking |
| `src/permissions/approvals-link.ts` | the cache `AskLink` + its two fail-closed preconditions |
| `src/interaction/ask-link.ts` | the human `AskLink`: render, prompt, map reply, serialize, cancel |
| `src/permissions/approval-audit.ts` | corpus JSONL writer |
| `test/unit/permissions/ask-chain.test.ts` | chain semantics |
| `test/unit/permissions/approvals-store.test.ts` | store + locking + malformed file |
| `test/unit/permissions/approvals-link.test.ts` | cache link + preconditions |
| `test/unit/interaction/ask-link.test.ts` | human link, incl. timeout/throw/cancel |
| `test/integration/permissions/approval-gate.test.ts` | end-to-end through `buildCodingToolSupport` |

**Modified files:**

| File | Change |
|---|---|
| `src/permissions/types.ts` | **DELETE** its `AskResolver` (it moves to `ask-chain.ts`); keep `AskRequest` and widen it |
| `src/permissions/ask.ts` | `headlessAskResolver()` becomes `chainAskLinks([])`; split `ASK_UNAVAILABLE_REASON` |
| `src/permissions/index.ts` | barrel exports |
| `src/tools/runtime.ts:379-395` | consume `AskVerdict`; populate the richer `AskRequest`; record `approval` in the audit object |
| `src/config/schemas-execution.ts` | new `approvalTimeout` key |
| `src/config/runtime-types.ts` | mirror the key |
| `src/agents/coding-tool-support.ts` | add `askResolver` to the `Pick` and pass it through |
| `src/agents/types.ts` | `askResolver?` on `AgentRunOptions` |
| `src/pipeline/stages/execution.ts` | build the chain beside `buildInteractionBridge` |
| `test/unit/permissions/ask.test.ts` | assertion shape only (`verdict.decision`) |
| `test/integration/permissions/bash-deny-suite.test.ts` | add mode/gate rows |
| `docs/adr/ADR-030-bash-approval-modes.md` | amendment |

---

## Task 1: The ask chain and its contract

**Files:**
- Create: `src/permissions/ask-chain.ts`
- Modify: `src/permissions/types.ts`, `src/permissions/ask.ts`, `src/permissions/index.ts`, `src/tools/runtime.ts:379-395`
- Modify (assertion shape only): `test/unit/permissions/ask.test.ts`
- Test: `test/unit/permissions/ask-chain.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `AskDecision`, `AskDecidedBy`, `AskLinkOutcome`, `AskLink`, `AskVerdict`, `AskResolver`, `chainAskLinks(links: readonly AskLink[]): AskResolver`. Every later task builds an `AskLink`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/permissions/ask-chain.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { type AskLink, chainAskLinks } from "@/permissions";

const REQ = { tool: "Bash", stage: "implementer", rule: "Bash", summary: "Bash command=x" };

function link(name: string, decision: "allow" | "deny" | "abstain", decidedBy: "cache" | "human"): AskLink {
  return { name, resolve: () => Promise.resolve({ decision, decidedBy }) };
}

describe("chainAskLinks", () => {
  test("an empty chain denies, attributed to unavailable", async () => {
    const verdict = await chainAskLinks([]).resolve(REQ);
    expect(verdict.decision).toBe("deny");
    expect(verdict.decidedBy).toBe("unavailable");
  });

  test("the first non-abstain link wins and names itself", async () => {
    const verdict = await chainAskLinks([
      link("cache", "abstain", "cache"),
      link("human", "allow", "human"),
    ]).resolve(REQ);
    expect(verdict.decision).toBe("allow");
    expect(verdict.decidedBy).toBe("human");
  });

  test("a later link is never consulted once one decides", async () => {
    let reached = false;
    const spy: AskLink = {
      name: "human",
      resolve: () => {
        reached = true;
        return Promise.resolve({ decision: "allow" as const, decidedBy: "human" as const });
      },
    };
    await chainAskLinks([link("cache", "allow", "cache"), spy]).resolve(REQ);
    expect(reached).toBe(false);
  });

  test("all-abstain denies: the terminal link cannot abstain", async () => {
    const verdict = await chainAskLinks([
      link("cache", "abstain", "cache"),
      link("human", "abstain", "human"),
    ]).resolve(REQ);
    expect(verdict.decision).toBe("deny");
    expect(verdict.decidedBy).toBe("unavailable");
  });

  test("a throwing link denies rather than escaping", async () => {
    const boom: AskLink = { name: "human", resolve: () => Promise.reject(new Error("transport down")) };
    const verdict = await chainAskLinks([boom]).resolve(REQ);
    expect(verdict.decision).toBe("deny");
    expect(verdict.decidedBy).toBe("unavailable");
  });

  test("latency is reported", async () => {
    const verdict = await chainAskLinks([link("cache", "allow", "cache")]).resolve(REQ);
    expect(verdict.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/permissions/ask-chain.test.ts --timeout=60000`
Expected: FAIL — `chainAskLinks` is not exported from `@/permissions`.

- [ ] **Step 3: Write the implementation**

Create `src/permissions/ask-chain.ts`:

```ts
/**
 * The ask-tier resolver chain (P2 design section 4).
 *
 * One decision point for every permission adjudicator: the approvals cache,
 * a future classifier (P5) and the human gate are all LINKS here. The channel
 * that asks a human lives in src/interaction/ and is not a peer of this chain
 * -- it is what the human link talks to.
 *
 * Fail-closed by construction: the chain appends its own terminal deny, so an
 * exhausted or all-abstaining chain denies whether or not the last link is
 * total. A link that throws is treated as no answer, never as permission.
 */
import type { AskRequest } from "./types";

/** A link's answer. `abstain` means "no opinion, try the next link". */
export type AskDecision = "allow" | "deny" | "abstain";

/** Who actually decided. Carried into the ledger so it never has to be inferred. */
export type AskDecidedBy = "cache" | "model" | "human" | "timeout" | "unavailable";

export interface AskLinkOutcome {
  readonly decision: AskDecision;
  readonly decidedBy: AskDecidedBy;
}

/**
 * One adjudicator. A link ALWAYS names who decided, because a single link can
 * answer for more than one reason -- the human link resolves as `human` when
 * someone taps and as `timeout` when nobody does.
 */
export interface AskLink {
  readonly name: string;
  resolve(req: AskRequest): Promise<AskLinkOutcome>;
}

/** What the runtime consumes. Never `abstain`. */
export interface AskVerdict {
  readonly decision: "allow" | "deny";
  readonly decidedBy: AskDecidedBy;
  readonly latencyMs: number;
}

export interface AskResolver {
  resolve(req: AskRequest): Promise<AskVerdict>;
}

/**
 * Compose links into a resolver. First non-abstain wins.
 *
 * A throwing link abstains rather than propagating: `runtime.callTool` turns an
 * exception out of the resolver into a TOOL ERROR surfaced to the model, not a
 * denial, which would lose the `denied:ask` ledger row and hand the agent
 * something it may retry around.
 */
export function chainAskLinks(links: readonly AskLink[]): AskResolver {
  return {
    async resolve(req: AskRequest): Promise<AskVerdict> {
      const started = Date.now();
      for (const link of links) {
        let outcome: AskLinkOutcome;
        try {
          outcome = await link.resolve(req);
        } catch {
          continue;
        }
        if (outcome.decision === "abstain") continue;
        return { decision: outcome.decision, decidedBy: outcome.decidedBy, latencyMs: Date.now() - started };
      }
      return { decision: "deny", decidedBy: "unavailable", latencyMs: Date.now() - started };
    },
  };
}
```

- [ ] **Step 4: Rewrite `src/permissions/ask.ts` on top of the chain**

```ts
import { type AskResolver, chainAskLinks } from "./ask-chain";

/**
 * Why an ask-matched call was refused. One string per CASE: the previous single
 * message asserted "this run is headless" for situations that are not, and the
 * three are materially different facts for anyone reading the ledger.
 */
export const ASK_NO_CHANNEL_REASON =
  "matched an ask rule requiring human approval; no approval channel is configured for this run, so the call is refused";
export const ASK_TIMEOUT_REASON =
  "matched an ask rule requiring human approval; no answer arrived before the approval timeout, so the call is refused";
export const ASK_DENIED_REASON =
  "matched an ask rule requiring human approval; the operator denied it";

/** Kept for compatibility with existing callers and tests. */
export const ASK_UNAVAILABLE_REASON = ASK_NO_CHANNEL_REASON;

/**
 * The resolver a run gets when no channel is available: a chain with zero
 * links, whose terminal deny supplies the answer. TOTAL -- never abstains.
 */
export function headlessAskResolver(): AskResolver {
  return chainAskLinks([]);
}
```

- [ ] **Step 5: MOVE `AskResolver` out of `types.ts`, then fix the barrel**

🔴 **This step is load-bearing and silent if you get it wrong.** `src/permissions/types.ts`
currently declares its OWN `AskResolver`:

```ts
export interface AskResolver {
  resolve(req: AskRequest): Promise<"allow" | "deny">;
}
```

and `src/permissions/index.ts:5` re-exports it explicitly:

```ts
export type { AskRequest, AskResolver } from "./types";
```

`ask-chain.ts` now declares a DIFFERENT, structurally incompatible `AskResolver` (returning
`AskVerdict`). If you simply add `export * from "./ask-chain";`, **an explicit named export
wins over a colliding star re-export — with no error.** `@/permissions`'s `AskResolver` would
keep resolving to the stale string-returning type, and every later task would then fail to
assign `chainAskLinks(...)` to it, with an error pointing at the wrong file.

Do this instead:

1. **Delete** the `AskResolver` interface from `src/permissions/types.ts`. It now lives in
   `ask-chain.ts` and nowhere else. Leave `AskRequest` in `types.ts` — `ask-chain.ts` imports
   it, so moving it would close a cycle.
2. Change the barrel line to export only what still lives in `types.ts`, and star-export the
   chain:

```ts
export type { AskRequest } from "./types";
export * from "./ask-chain";
```

3. Confirm there is exactly ONE `AskResolver` in the package:

```bash
grep -rn "interface AskResolver" src/
```

Expected: one hit, in `src/permissions/ask-chain.ts`.

- [ ] **Step 6: Update `src/tools/runtime.ts` to consume `AskVerdict`**

Replace the ask-tier block at `src/tools/runtime.ts:379-395`. The `let decision: "allow" | "deny";` declaration at `:380` no longer typechecks.

```ts
      if (!verdict.allowed && verdict.outcome === "ask") {
        let askVerdict: AskVerdict;
        try {
          askVerdict = await askResolver.resolve({
            tool: policyIdentity,
            stage: opts.pipelineStage ?? "unknown",
            rule: verdict.rule ?? verdict.reason,
            summary: askSummary(policyIdentity, tool.scope, input),
          });
        } catch (err) {
          const content = errorMessage(err);
          log(policyIdentity, "error", content.length, input, context, false, content);
          return { kind: "error", content };
        }
        if (askVerdict.decision === "allow") {
          return runTool(tool, input, verdict.resolvedPaths ?? []);
        }
        const reason = `${verdict.reason} -- ${ASK_UNAVAILABLE_REASON}`;
        log(policyIdentity, "denied:ask", reason.length, input, context, false, reason);
        return { kind: "denied", reason, breach: false };
      }
```

Add `import type { AskVerdict } from "@/permissions";` to the existing permissions import. Leave the richer `AskRequest` fields and the `approval` audit record to Tasks 3 and 7 — this step only restores the typecheck.

- [ ] **Step 7: Update the existing pinned test's assertion shape**

In `test/unit/permissions/ask.test.ts`, the headless case asserts the resolved value directly. The behaviour is unchanged — a headless run still denies — but the value is now an `AskVerdict`:

```ts
  test("always resolves to deny", async () => {
    const resolver = headlessAskResolver();
    const verdict = await resolver.resolve({
      tool: "Write",
      stage: "run",
      rule: "Write(src/**)",
      summary: "Write src/x.ts",
    });
    expect(verdict.decision).toBe("deny");
    expect(verdict.decidedBy).toBe("unavailable");
  });
```

- [ ] **Step 8: Run the tests**

Run: `bun test test/unit/permissions/ --timeout=60000 && bun x tsc --noEmit`
Expected: PASS, and a clean typecheck.

- [ ] **Step 9: Run the regression spine**

Run: `bun test test/integration/permissions/bash-deny-suite.test.ts --timeout=60000`
Expected: PASS — all 21 rows still refuse. This suite is the acceptance spine of the bash feature and must stay green at EVERY task boundary in this plan.

- [ ] **Step 10: Commit**

```bash
git add src/permissions/ask-chain.ts src/permissions/ask.ts src/permissions/index.ts \
        src/tools/runtime.ts test/unit/permissions/ask-chain.test.ts test/unit/permissions/ask.test.ts
git commit -m "feat(permissions): add the ask-tier resolver chain

One decision point for every permission adjudicator. Links answer
allow/deny/abstain and name who decided; the chain appends its own
terminal deny, so an exhausted or all-abstaining chain denies by
construction rather than by the last link remembering to be total.

A throwing link abstains rather than propagating: an exception out of
the resolver would reach runtime.callTool's catch and become a TOOL
ERROR surfaced to the model instead of a denial, losing the denied:ask
row.

headlessAskResolver() becomes chainAskLinks([]) -- same behaviour, and
still total. AskResolver now returns an AskVerdict so decidedBy can
reach the ledger on the allow path as well as the deny path."
```

---

## Task 2: `execution.approvalTimeout`

**Files:**
- Modify: `src/config/schemas-execution.ts:264` (beside `bashApproval`), `src/config/runtime-types.ts:136-137`
- Test: `test/unit/config/approval-timeout.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `config.execution.approvalTimeout: number` (milliseconds), default `600000`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/config/approval-timeout.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ExecutionConfigSchema } from "@/config/schemas-execution";

describe("execution.approvalTimeout", () => {
  test("defaults to 10 minutes", () => {
    expect(ExecutionConfigSchema.parse({}).approvalTimeout).toBe(600_000);
  });

  test("accepts an explicit value", () => {
    expect(ExecutionConfigSchema.parse({ approvalTimeout: 90_000 }).approvalTimeout).toBe(90_000);
  });

  test("rejects a value below the 30s floor", () => {
    expect(() => ExecutionConfigSchema.parse({ approvalTimeout: 1_000 })).toThrow();
  });

  test("rejects a value above the 1h ceiling", () => {
    expect(() => ExecutionConfigSchema.parse({ approvalTimeout: 3_700_000 })).toThrow();
  });
});
```

If `ExecutionConfigSchema` is not the exported name in `src/config/schemas-execution.ts`, open that file and use the schema that carries `bashApproval` at line 264 — the test must parse the same object that owns `bashApproval`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/config/approval-timeout.test.ts --timeout=60000`
Expected: FAIL — `approvalTimeout` is `undefined`.

- [ ] **Step 3: Add the schema field**

In `src/config/schemas-execution.ts`, immediately after the `bashApproval` line:

```ts
  /**
   * How long an interactive permission prompt waits before DENYING (P2 design
   * section 6.5). Deliberately separate from `interaction.defaults.timeout`:
   * a permission prompt's timeout denies -- costing a turn or a story -- so its
   * patience must not be coupled to a value an operator tunes for merge gates
   * and cost warnings. Reuse the channel's transport, not its timing.
   */
  approvalTimeout: z.number().int().min(30_000).max(3_600_000).default(600_000),
```

- [ ] **Step 4: Mirror it in the runtime types**

In `src/config/runtime-types.ts`, beside the existing `bashApproval?: "raw" | "gated" | "escalate";` at `:136-137`:

```ts
  /** P2. Milliseconds a permission prompt waits before denying. */
  approvalTimeout?: number;
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/unit/config/ --timeout=60000 && bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config/schemas-execution.ts src/config/runtime-types.ts test/unit/config/approval-timeout.test.ts
git commit -m "feat(config): add execution.approvalTimeout, defaulting to 10 minutes

A permission prompt's timeout DENIES, so its patience gets its own knob
rather than inheriting interaction.defaults.timeout, which operators tune
for merge gates and cost warnings."
```

---

## Task 3: The richer `AskRequest`, verbatim or deny

**Files:**
- Modify: `src/permissions/types.ts` (the `AskRequest` interface), `src/tools/runtime.ts:118-128` (`askSummary`) and `:379-395` (populate the new fields)
- Test: `test/unit/tools/ask-request-payload.test.ts`

**Interfaces:**
- Consumes: `AskVerdict` from Task 1.
- Produces: `AskRequest` gains `command?`, `root?`, `reason?`, `storyId?`, `featureName?`. Tasks 5 and 6 read these.

**Why:** `askSummary()` truncates at `MAX_ASK_SUMMARY_CHARS = 200` (`src/tools/runtime.ts:37`), and escalated commands are precisely the long ones. Left as-is, an operator approves a silently truncated command and the cache keys on a string they never read.

- [ ] **Step 1: Write the failing test**

Create `test/unit/tools/ask-request-payload.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";
import type { AskRequest } from "@/permissions";

const LONG = `echo ${"x".repeat(400)}`;

function capturingResolver(sink: AskRequest[]) {
  return {
    resolve: (req: AskRequest) => {
      sink.push(req);
      return Promise.resolve({ decision: "deny" as const, decidedBy: "human" as const, latencyMs: 0 });
    },
  };
}

describe("AskRequest payload", () => {
  test("carries the command VERBATIM, not the 200-char summary", async () => {
    const root = makeTempDir("ask-payload-");
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "config"), "[core]\n");
    const seen: AskRequest[] = [];
    const support = buildCodingToolSupport({
      root,
      declared: ["Bash"],
      grants: [{ tool: "Bash", patterns: ["echo *"] }],
      askRules: [{ tool: "Bash", patterns: ["echo *"] }],
      bashApproval: "gated",
      askResolver: capturingResolver(seen),
    });
    await support?.runtime.callTool("Bash", { command: LONG });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.command).toBe(LONG);
    expect(seen[0]?.command?.length).toBeGreaterThan(200);
    expect(seen[0]?.root).toBe(root);
    cleanupTempDir(root);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/tools/ask-request-payload.test.ts --timeout=60000`
Expected: FAIL — `buildCodingToolSupport` does not accept `askResolver`, and `AskRequest` has no `command`.

- [ ] **Step 3: Widen `AskRequest`**

In `src/permissions/types.ts`, extend the interface:

```ts
export interface AskRequest {
  readonly tool: string;
  readonly stage: string;
  readonly rule: string;
  readonly summary: string;
  /**
   * The command string VERBATIM, never truncated. `summary` is capped at 200
   * chars for logs; a human deciding whether to permit a command must see all
   * of it, or they are approving a string they never read.
   */
  readonly command?: string;
  /** The permitted root -- where the shell actually starts (src/tools/bash.ts:165). */
  readonly root?: string;
  /** The verdict's original reason, NOT rewritten as `matched ask rule "..."`. */
  readonly reason?: string;
  readonly storyId?: string;
  readonly featureName?: string;
}
```

- [ ] **Step 4: Accept `askResolver` in `buildCodingToolSupport` and populate the fields**

In `src/agents/coding-tool-support.ts`, add `askResolver?: AskResolver;` to the `CodingToolSupport` args interface (beside `bashApproval` at `:131`), importing the type from `@/permissions` — which, after Task 1 Step 5, is the chain's `AskResolver` returning `AskVerdict`, not the deleted one from `types.ts`. Forward it in the `createCodingToolRuntime` call at `:201`:

```ts
    ...(args.askResolver !== undefined ? { askResolver: args.askResolver } : {}),
```

In `src/tools/runtime.ts`, populate the new `AskRequest` fields in the ask-tier block:

```ts
          askVerdict = await askResolver.resolve({
            tool: policyIdentity,
            stage: opts.pipelineStage ?? "unknown",
            rule: verdict.rule ?? verdict.reason,
            summary: askSummary(policyIdentity, tool.scope, input),
            ...(typeof input[tool.scope.commandField ?? ""] === "string"
              ? { command: input[tool.scope.commandField as string] as string }
              : {}),
            root: opts.policy.root,
            reason: verdict.reason,
            ...(opts.storyId !== undefined ? { storyId: opts.storyId } : {}),
          });
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/unit/tools/ask-request-payload.test.ts test/integration/permissions/bash-deny-suite.test.ts --timeout=60000 && bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/permissions/types.ts src/tools/runtime.ts src/agents/coding-tool-support.ts \
        test/unit/tools/ask-request-payload.test.ts
git commit -m "feat(permissions): carry the command verbatim into AskRequest

askSummary truncates at 200 chars, and escalated commands are precisely
the long ones. An operator approving a silently truncated command is
approving a string they never read, and the cache would key on it.

AskRequest gains command, root, reason and story identity. reason is the
verdict's own text rather than a rewrite, because escalate deliberately
preserves the original denial wording and that is the operator's whole
basis for judging."
```

---

## Task 4: The approvals store

**Files:**
- Create: `src/permissions/approvals-store.ts`
- Test: `test/unit/permissions/approvals-store.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface ApprovalEntry { stage: string; command: string; root: string; origin: "escalate" | "askRule"; matchedRule: string | null; approvedAt: string; approvedBy: string; naxCommit: string }`
  - `approvalsPath(outputDir: string): string`
  - `readApprovals(path: string): Promise<readonly ApprovalEntry[]>` — returns `[]` on missing/malformed
  - `appendApproval(path: string, entry: ApprovalEntry): Promise<void>` — lock-protected read-modify-write
  - `findApproval(entries, stage, command): ApprovalEntry | undefined` — BYTE-EXACT

- [ ] **Step 1: Write the failing test**

Create `test/unit/permissions/approvals-store.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { appendApproval, findApproval, readApprovals } from "@/permissions";

const entry = (command: string, stage = "implementer") => ({
  stage,
  command,
  root: "/repo",
  origin: "escalate" as const,
  matchedRule: null,
  approvedAt: "2026-09-22T10:00:00.000Z",
  approvedBy: "telegram:123",
  naxCommit: "7b37dbf74",
});

describe("approvals store", () => {
  test("a missing file reads as empty, not an error", async () => {
    const dir = makeTempDir("approvals-");
    expect(await readApprovals(join(dir, "approvals.json"))).toEqual([]);
    cleanupTempDir(dir);
  });

  test("a malformed file reads as empty rather than throwing", async () => {
    const dir = makeTempDir("approvals-");
    const path = join(dir, "approvals.json");
    writeFileSync(path, "{ this is not json");
    expect(await readApprovals(path)).toEqual([]);
    cleanupTempDir(dir);
  });

  test("append then read round-trips", async () => {
    const dir = makeTempDir("approvals-");
    const path = join(dir, "approvals.json");
    await appendApproval(path, entry("bun run test"));
    const entries = await readApprovals(path);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.command).toBe("bun run test");
  });

  test("lookup is BYTE-EXACT: a prefix does not match a longer command", () => {
    const entries = [entry("bun run test")];
    expect(findApproval(entries, "implementer", "bun run test")).toBeDefined();
    expect(findApproval(entries, "implementer", "bun run test --reporter=./x")).toBeUndefined();
    expect(findApproval(entries, "implementer", "bun run test ")).toBeUndefined();
    expect(findApproval(entries, "implementer", "bun  run test")).toBeUndefined();
  });

  test("lookup is stage-scoped", () => {
    const entries = [entry("bun run test", "implementer")];
    expect(findApproval(entries, "verifier", "bun run test")).toBeUndefined();
  });

  test("concurrent appends keep both entries and valid JSON", async () => {
    const dir = makeTempDir("approvals-");
    const path = join(dir, "approvals.json");
    await Promise.all([appendApproval(path, entry("cmd-a")), appendApproval(path, entry("cmd-b"))]);
    const commands = (await readApprovals(path)).map((e) => e.command).sort();
    expect(commands).toEqual(["cmd-a", "cmd-b"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/permissions/approvals-store.test.ts --timeout=60000`
Expected: FAIL — none of the functions exist.

- [ ] **Step 3: Write the implementation**

Create `src/permissions/approvals-store.ts`:

```ts
/**
 * Durable store for remembered approvals (P2 design section 6.6).
 *
 * A remembered approval is a CACHED HUMAN DECISION, not a rule. Lookup is
 * BYTE-EXACT on (stage, command) with no normalization of any kind -- not
 * trimming, not whitespace collapsing, not quote folding. Any normalization is
 * a place where the string that was approved and the string that runs can
 * diverge, and the whole value of the cache is that they cannot.
 *
 * Synthesizing a `Bash(...)` rule instead would be materially broader than what
 * the operator approved: rule matching is a token-wise PREFIX match with no
 * length ceiling (src/tools/policy-bash.ts:72-83), so a rule made from
 * `bun run test` would also grant `bun run test --reporter=./x`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withPathFileLock } from "../utils/path-file-lock";

export interface ApprovalEntry {
  readonly stage: string;
  readonly command: string;
  readonly root: string;
  readonly origin: "escalate" | "askRule";
  readonly matchedRule: string | null;
  readonly approvedAt: string;
  readonly approvedBy: string;
  readonly naxCommit: string;
}

/**
 * The run's output dir, NOT the tool root. `root` is storyExecRoot -- the repo
 * OR WORKTREE root -- so a root-relative file is deleted by the
 * `git worktree remove --force` that ends the run. That is the exact defect
 * recorded in toolAuditDir's docblock (src/config/paths/index.ts:138-150).
 */
export function approvalsPath(outputDir: string): string {
  return join(outputDir, "approvals.json");
}

/** Missing or malformed reads as empty: the CACHE fails, the chain does not. */
export async function readApprovals(path: string): Promise<readonly ApprovalEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { entries?: unknown };
    return Array.isArray(parsed.entries) ? (parsed.entries as ApprovalEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * Lock the read-modify-write. Worktree-isolated parallel stories share one
 * project-scoped file BY DESIGN (that is why `root` is not part of the key), so
 * two "Allow + remember" taps can race and drop one. `withPathFileLock` is the
 * shared primitive for exactly this shape; it fails closed on timeout rather
 * than entering over a possible holder.
 */
export async function appendApproval(path: string, entry: ApprovalEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await withPathFileLock(path, async () => {
    const existing = await readApprovals(path);
    await writeFile(path, `${JSON.stringify({ entries: [...existing, entry] }, null, 2)}\n`, "utf8");
  });
}

/** BYTE-EXACT. No normalization. See the module docblock. */
export function findApproval(
  entries: readonly ApprovalEntry[],
  stage: string,
  command: string,
): ApprovalEntry | undefined {
  return entries.find((e) => e.stage === stage && e.command === command);
}
```

Replace the commented body of `appendApproval` with the real implementation using the helper from Step 3. The comment names exactly what it must do; do not leave it as a comment.

- [ ] **Step 4: Export from the barrel**

Add `export * from "./approvals-store";` to `src/permissions/index.ts`.

- [ ] **Step 5: Run the tests**

Run: `bun test test/unit/permissions/approvals-store.test.ts --timeout=60000 && bun x tsc --noEmit`
Expected: PASS, including the concurrent-append case.

- [ ] **Step 6: Commit**

```bash
git add src/permissions/approvals-store.ts src/permissions/index.ts test/unit/permissions/approvals-store.test.ts
git commit -m "feat(permissions): add the approvals store

Byte-exact (stage, command) lookup with no normalization: any
normalization step is a place where the approved string and the executed
string can diverge.

Lives under the run's outputDir, never the tool root -- root is
storyExecRoot, so a root-relative file is deleted by the worktree removal
that ends the run, which is the defect toolAuditDir's docblock records.

Appends take a file lock: parallel worktree-isolated stories share one
project-scoped file by design."
```

---

## Task 5: The cache link and its preconditions

**Files:**
- Create: `src/permissions/approvals-link.ts`
- Test: `test/unit/permissions/approvals-link.test.ts`

**Interfaces:**
- Consumes: `AskLink`, `AskLinkOutcome` (Task 1); `readApprovals`, `findApproval`, `approvalsPath` (Task 4).
- Produces: `createApprovalsLink(opts: { approvalsFile: string; repoRoot: string; stageModes: readonly string[] }): AskLink`.

**Why the preconditions:** the location does NOT make the file unreachable to Bash. `nax-owned-writes.ts:52-58` excludes Bash by design, and under `raw` mode `screenRawBashCommand`'s `protectedHit` skips every path outside the root (`policy-bash-raw.ts:84`). A `raw` stage can therefore forge entries that an `escalate` stage later trusts — a cross-stage escalation. Read spec section 6.6 in full before implementing.

- [ ] **Step 1: Write the failing test**

Create `test/unit/permissions/approvals-link.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { appendApproval, createApprovalsLink } from "@/permissions";

const REQ = {
  tool: "Bash",
  stage: "implementer",
  rule: "Bash",
  summary: "Bash command=bun run test",
  command: "bun run test",
};

async function seeded(dir: string) {
  const file = join(dir, "approvals.json");
  await appendApproval(file, {
    stage: "implementer",
    command: "bun run test",
    root: "/repo",
    origin: "escalate",
    matchedRule: null,
    approvedAt: "2026-09-22T10:00:00.000Z",
    approvedBy: "telegram:123",
    naxCommit: "7b37dbf74",
  });
  return file;
}

describe("approvals link", () => {
  test("an exact hit allows and attributes to cache", async () => {
    const dir = makeTempDir("link-");
    const link = createApprovalsLink({
      approvalsFile: await seeded(dir),
      repoRoot: "/repo",
      stageModes: ["gated", "escalate"],
    });
    expect(await link.resolve(REQ)).toEqual({ decision: "allow", decidedBy: "cache" });
    cleanupTempDir(dir);
  });

  test("a miss ABSTAINS so the human is still asked", async () => {
    const dir = makeTempDir("link-");
    const link = createApprovalsLink({
      approvalsFile: await seeded(dir),
      repoRoot: "/repo",
      stageModes: ["escalate"],
    });
    const out = await link.resolve({ ...REQ, command: "bun run test --x" });
    expect(out.decision).toBe("abstain");
    cleanupTempDir(dir);
  });

  test("PRECONDITION 1: any raw stage disables the cache entirely", async () => {
    const dir = makeTempDir("link-");
    const link = createApprovalsLink({
      approvalsFile: await seeded(dir),
      repoRoot: "/repo",
      stageModes: ["escalate", "raw"],
    });
    // The entry matches exactly, and it is STILL not honoured.
    expect((await link.resolve(REQ)).decision).toBe("abstain");
    cleanupTempDir(dir);
  });

  test("PRECONDITION 2: an approvals file inside repoRoot disables the cache", async () => {
    const repoRoot = makeTempDir("repo-");
    const link = createApprovalsLink({
      approvalsFile: await seeded(repoRoot),
      repoRoot,
      stageModes: ["escalate"],
    });
    expect((await link.resolve(REQ)).decision).toBe("abstain");
    cleanupTempDir(repoRoot);
  });

  test("a request with no command abstains", async () => {
    const dir = makeTempDir("link-");
    const link = createApprovalsLink({
      approvalsFile: await seeded(dir),
      repoRoot: "/repo",
      stageModes: ["escalate"],
    });
    const { command: _omit, ...noCommand } = REQ;
    expect((await link.resolve(noCommand)).decision).toBe("abstain");
    cleanupTempDir(dir);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/permissions/approvals-link.test.ts --timeout=60000`
Expected: FAIL — `createApprovalsLink` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/permissions/approvals-link.ts`:

```ts
/**
 * The approvals cache as the FIRST link of the ask chain (P2 design 4.3, 6.6).
 *
 * TRUST BOUNDARY. Living outside repoRoot protects this file from the TYPED
 * path-bearing tools, but NOT from Bash: nax-owned-writes.ts:52-58 excludes
 * Bash by design, and under `raw` mode screenRawBashCommand's protectedHit
 * skips every path outside the root (policy-bash-raw.ts:84), so the file is
 * never screened. A raw shell can forge entries.
 *
 * That is not a new vulnerability -- a raw shell needs no forged permission to
 * run a command -- but it IS a cross-stage escalation in a MIXED-mode run,
 * where a raw stage poisons the cache an escalate stage later trusts. Hence
 * precondition 1. P4's sandbox is what closes the underlying hole.
 *
 * Both preconditions fail by ABSTAINING, which escalates to the human, so a
 * failure costs prompts rather than safety.
 */
import { relative, resolve } from "node:path";
import { getSafeLogger } from "../logger";
import type { AskLink, AskLinkOutcome } from "./ask-chain";
import { findApproval, readApprovals } from "./approvals-store";
import type { AskRequest } from "./types";

const ABSTAIN: AskLinkOutcome = { decision: "abstain", decidedBy: "cache" };

function insideRepo(repoRoot: string, file: string): boolean {
  const rel = relative(resolve(repoRoot), resolve(file));
  return rel !== "" && !rel.startsWith("..");
}

export function createApprovalsLink(opts: {
  readonly approvalsFile: string;
  readonly repoRoot: string;
  /** Every stage's resolved bashApproval mode in this run. */
  readonly stageModes: readonly string[];
}): AskLink {
  const rawStage = opts.stageModes.includes("raw");
  const inRepo = insideRepo(opts.repoRoot, opts.approvalsFile);
  const disabled = rawStage || inRepo;

  if (disabled) {
    getSafeLogger()?.warn("permissions", "[approvals] cache disabled; every ask reaches the human", {
      reason: rawStage ? "a stage resolves to bashApproval:raw, which can forge this file" : "approvals file is inside repoRoot",
      approvalsFile: opts.approvalsFile,
    });
  }

  return {
    name: "approvals-cache",
    async resolve(req: AskRequest): Promise<AskLinkOutcome> {
      if (disabled) return ABSTAIN;
      if (req.command === undefined) return ABSTAIN;
      const hit = findApproval(await readApprovals(opts.approvalsFile), req.stage, req.command);
      return hit === undefined ? ABSTAIN : { decision: "allow", decidedBy: "cache" };
    },
  };
}
```

- [ ] **Step 4: Export from the barrel**

Add `export * from "./approvals-link";` to `src/permissions/index.ts`.

- [ ] **Step 5: Run the tests**

Run: `bun test test/unit/permissions/ --timeout=60000 && bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/permissions/approvals-link.ts src/permissions/index.ts test/unit/permissions/approvals-link.test.ts
git commit -m "feat(permissions): add the approvals cache link, fail-closed

Two preconditions, both checked once at construction and both abstaining
rather than allowing: no stage may resolve to bashApproval raw, and the
approvals file must lie outside repoRoot.

The first exists because the file's location does NOT protect it from
Bash. nax-owned-writes excludes Bash by design, and under raw mode
protectedHit skips every path outside the root, so a raw stage can forge
entries an escalate stage would then trust without a human. The second
exists because an outputDir override can place the file inside the repo,
handing it back to the typed tools too.

Abstaining escalates to the human, so both failures cost prompts, not
safety."
```

---

## Task 6: The human link

**Files:**
- Create: `src/interaction/ask-link.ts`
- Modify: `src/interaction/index.ts`
- Test: `test/unit/interaction/ask-link.test.ts`

**Interfaces:**
- Consumes: `AskLink`, `AskLinkOutcome` (Task 1); the richer `AskRequest` (Task 3); `InteractionChain` (existing).
- Produces: `createHumanAskLink(opts: { chain: InteractionChain | null; timeoutMs: number; featureName?: string; storyId?: string; onRemember?: (req: AskRequest) => Promise<void> }): AskLink` and `disposeHumanAskLink(link): Promise<void>`.

**Read first:** spec sections 3.1, 5.4, 5.5, 6.5a. Three rules here are easy to get wrong and are the reason this task exists as its own unit.

- [ ] **Step 1: Write the failing test**

Create `test/unit/interaction/ask-link.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { InteractionRequest, InteractionResponse } from "@/interaction";
import { cancelPendingAsk, createHumanAskLink } from "@/interaction";
import type { AskRequest } from "@/permissions";

const REQ: AskRequest = {
  tool: "Bash",
  stage: "implementer",
  rule: "Bash",
  summary: "Bash command=bun run test",
  command: "bun run test 2>&1 | tail -n 40",
  root: "/repo",
  reason: "segment 2 (`tail`) matched no allow rule",
};

/** A chain double that reproduces production's FAILURE modes, not just success. */
/**
 * NOTE ON TYPES: InteractionResponse["action"] is the narrow InteractionAction
 * union and does NOT include our option keys -- prompt() puts them there via a
 * cast. Test doubles therefore take a plain string and cast at the boundary,
 * exactly as production does.
 */
function fakeChain(behaviour: { reply?: string; throws?: boolean; sent?: InteractionRequest[] }) {
  return {
    prompt: (request: InteractionRequest) => {
      behaviour.sent?.push(request);
      if (behaviour.throws) return Promise.reject(new Error("all interaction plugins failed"));
      return Promise.resolve({
        requestId: request.id,
        action: (behaviour.reply ?? "deny") as InteractionResponse["action"],
        respondedAt: Date.now(),
      } as InteractionResponse);
    },
    cancel: () => Promise.resolve(),
  } as unknown as Parameters<typeof createHumanAskLink>[0]["chain"];
}

describe("human ask link", () => {
  test("dispatches type 'choose' carrying the command verbatim", async () => {
    const sent: InteractionRequest[] = [];
    const link = createHumanAskLink({ chain: fakeChain({ reply: "allow", sent }), timeoutMs: 1000 });
    await link.resolve(REQ);
    expect(sent[0]?.type).toBe("choose");
    expect(sent[0]?.options?.map((o) => o.key)).toEqual(["allow", "allow-remember", "deny"]);
    expect(JSON.stringify(sent[0])).toContain("bun run test 2>&1 | tail -n 40");
  });

  test("'allow' permits, attributed to human", async () => {
    const link = createHumanAskLink({ chain: fakeChain({ reply: "allow" }), timeoutMs: 1000 });
    expect(await link.resolve(REQ)).toEqual({ decision: "allow", decidedBy: "human" });
  });

  test("'allow-remember' permits and calls onRemember", async () => {
    let remembered = false;
    const link = createHumanAskLink({
      chain: fakeChain({ reply: "allow-remember" }),
      timeoutMs: 1000,
      onRemember: async () => {
        remembered = true;
      },
    });
    expect((await link.resolve(REQ)).decision).toBe("allow");
    expect(remembered).toBe(true);
  });

  test.each([["deny"], ["skip"], ["abort"], ["approve"], ["continue"], ["anything-else"]])(
    "ALLOWLIST: action %s denies",
    async (action) => {
      const link = createHumanAskLink({ chain: fakeChain({ reply: action }), timeoutMs: 1000 });
      expect((await link.resolve(REQ)).decision).toBe("deny");
    },
  );

  test("no chain denies, attributed to unavailable", async () => {
    const link = createHumanAskLink({ chain: null, timeoutMs: 1000 });
    expect(await link.resolve(REQ)).toEqual({ decision: "deny", decidedBy: "unavailable" });
  });

  test("a throwing chain denies rather than escaping", async () => {
    const link = createHumanAskLink({ chain: fakeChain({ throws: true }), timeoutMs: 1000 });
    expect((await link.resolve(REQ)).decision).toBe("deny");
  });

  test("a command too long to display denies rather than truncating", async () => {
    const sent: InteractionRequest[] = [];
    const link = createHumanAskLink({ chain: fakeChain({ reply: "allow", sent }), timeoutMs: 1000 });
    const out = await link.resolve({ ...REQ, command: "echo " + "x".repeat(5000) });
    expect(out.decision).toBe("deny");
    expect(sent).toHaveLength(0);
  });

  // SPEC CASE 3 -- the single most important regression test in this design.
  // applyFallback maps BOTH "continue" and "escalate" to "approve"
  // (src/interaction/chain.ts:186-193), and this author's global config sets
  // "escalate". A link built on applyFallback auto-approves every escalated
  // command on timeout. This test MUST fail against such an implementation.
  test.each([["continue"], ["escalate"], ["skip"], ["abort"]])(
    "a timeout DENIES even when interaction fallback is %s",
    async (fallback) => {
      const timingOutChain = {
        prompt: (request: InteractionRequest) =>
          Promise.resolve({
            requestId: request.id,
            action: "approve",
            respondedBy: "timeout",
            respondedAt: Date.now(),
          } as InteractionResponse),
        cancel: () => Promise.resolve(),
        // Present so an implementation that reaches for it compiles and then
        // fails this assertion, rather than failing to compile and being
        // "fixed" by deleting the test.
        applyFallback: () => (fallback === "continue" || fallback === "escalate" ? "approve" : fallback),
      } as unknown as Parameters<typeof createHumanAskLink>[0]["chain"];
      const link = createHumanAskLink({ chain: timingOutChain, timeoutMs: 1000 });
      expect(await link.resolve(REQ)).toEqual({ decision: "deny", decidedBy: "timeout" });
    },
  );

  // SPEC CASE 3b
  test("the prompt carries execution.approvalTimeout, not the interaction default", async () => {
    const sent: InteractionRequest[] = [];
    const link = createHumanAskLink({ chain: fakeChain({ reply: "allow", sent }), timeoutMs: 600_000 });
    await link.resolve(REQ);
    expect(sent[0]?.timeout).toBe(600_000);
  });

  // SPEC CASE 15
  test("run-end cancellation settles a pending prompt as deny", async () => {
    let cancelled: string | undefined;
    let release: ((r: InteractionResponse) => void) | undefined;
    const hangingChain = {
      prompt: (request: InteractionRequest) =>
        new Promise<InteractionResponse>((resolve) => {
          release = resolve;
        }),
      cancel: (id: string) => {
        cancelled = id;
        release?.({ requestId: id, action: "abort", respondedBy: "system", respondedAt: Date.now() });
        return Promise.resolve();
      },
    } as unknown as Parameters<typeof createHumanAskLink>[0]["chain"];

    const link = createHumanAskLink({ chain: hangingChain, timeoutMs: 3_600_000 });
    const inFlight = link.resolve(REQ);
    await new Promise((r) => setTimeout(r, 10));
    expect(link.pending()).toBeDefined();

    await cancelPendingAsk(hangingChain, link.pending());
    const outcome = await Promise.race([
      inFlight,
      new Promise((r) => setTimeout(() => r("HUNG"), 2000)),
    ]);
    expect(cancelled).toBeDefined();
    expect(outcome).not.toBe("HUNG");
    expect((outcome as { decision: string }).decision).toBe("deny");
  });

  test("a throw in one ask does not deadlock the next (mutex releases)", async () => {
    const link = createHumanAskLink({ chain: fakeChain({ throws: true }), timeoutMs: 1000 });
    await link.resolve(REQ);
    const second = await Promise.race([
      link.resolve(REQ),
      new Promise((r) => setTimeout(() => r("HUNG"), 2000)),
    ]);
    expect(second).not.toBe("HUNG");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/interaction/ask-link.test.ts --timeout=60000`
Expected: FAIL — `createHumanAskLink` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/interaction/ask-link.ts`. Three rules that must hold:

1. **NEVER call `chain.applyFallback`.** It maps BOTH `"continue"` and `"escalate"` to `"approve"` (`src/interaction/chain.ts:186-193`), and the author's own global config sets `"escalate"` — so a link built on it auto-approves every escalated command on timeout. Timeout denies, unconditionally.
2. **Allowlist the reply**, do not denylist `skip`/`abort`. `prompt()` passes an unrecognised `action` through verbatim (`chain.ts:130-137`).
3. **Verbatim or deny.** `MAX_MESSAGE_CHARS` is 4000 (`plugins/telegram-format.ts:13`); budget ~3500 for the command and deny above it rather than truncating.

```ts
/**
 * The human link of the ask chain (P2 design 5, 6.5a).
 *
 * An ADAPTER, not a channel: it renders an AskRequest into the interaction
 * subsystem's existing vocabulary and dispatches through the chain every other
 * consumer uses. It adds no plugin and no second prompt path. The import of
 * @/permissions is TYPE-ONLY, so `interaction -> permissions` stays a
 * compile-time edge and permissions remains extractable (master plan D8).
 */
import type { AskLink, AskLinkOutcome, AskRequest } from "@/permissions";
import type { InteractionChain } from "./chain";

/** Headroom under MAX_MESSAGE_CHARS (4000) for the header, reason and footer. */
const MAX_COMMAND_CHARS = 3500;

const OPTIONS = [
  { key: "allow", label: "Allow once" },
  { key: "allow-remember", label: "Allow + remember" },
  { key: "deny", label: "Deny" },
];

/** ONLY these permit. Everything else -- including unrecognised strings from a
 * future or malformed plugin -- denies. An allowlist, never a denylist. */
const PERMITS = new Set(["allow", "allow-remember"]);

export function createHumanAskLink(opts: {
  /**
   * `PipelineContext.interaction` is declared OPTIONAL (`src/pipeline/types.ts:142`), so it is
   * `InteractionChain | undefined`, while a chain built directly is `| null`. Accept both
   * rather than making every call site remember a `?? null` under `strict`.
   */
  readonly chain: InteractionChain | null | undefined;
  readonly timeoutMs: number;
  readonly featureName?: string;
  readonly storyId?: string;
  readonly onRemember?: (req: AskRequest) => Promise<void>;
}): AskLink {
  // One prompt in flight per run. CLI's readline is single-in-flight
  // (plugins/cli.ts:150-160) while Telegram is concurrent, so serializing HERE
  // makes gate behaviour independent of which channel is configured.
  let queue: Promise<unknown> = Promise.resolve();
  let pendingRequestId: string | undefined;

  const deny = (decidedBy: "human" | "timeout" | "unavailable"): AskLinkOutcome => ({ decision: "deny", decidedBy });

  async function ask(req: AskRequest): Promise<AskLinkOutcome> {
    const chain = opts.chain;
    if (chain === null || chain === undefined) return deny("unavailable");
    const command = req.command ?? "";
    if (command.length > MAX_COMMAND_CHARS) return deny("unavailable");

    const id = `ask-${Math.random().toString(16).slice(2, 10)}`;
    pendingRequestId = id;
    try {
      const response = await chain.prompt({
        id,
        type: "choose",
        featureName: opts.featureName ?? "unknown",
        ...(opts.storyId !== undefined ? { storyId: opts.storyId } : {}),
        stage: "execution",
        summary: `${req.tool} - approval required`,
        detail: [
          "```",
          command,
          "```",
          `runs in: ${req.root ?? "unknown"}`,
          `reason:  ${req.reason ?? req.rule}`,
          `stage:   ${req.stage}`,
        ].join("\n"),
        options: OPTIONS,
        timeout: opts.timeoutMs,
        // Recorded for the message footer only. This link NEVER consults
        // applyFallback: it maps "continue" AND "escalate" to approve.
        fallback: "abort",
        createdAt: Date.now(),
      });
      if (response.respondedBy === "timeout") return deny("timeout");
      // `action` is declared as InteractionAction ("approve" | "reject" |
      // "choose" | "input" | "skip" | "abort"), but prompt() remaps a choose
      // reply to the OPTION KEY through a cast (src/interaction/chain.ts:135),
      // so at runtime it carries our keys. Widen to string once, here: a direct
      // `response.action === "allow-remember"` is a TS2367 "no overlap" error.
      const action: string = response.action;
      if (!PERMITS.has(action)) return deny("human");
      if (action === "allow-remember" && opts.onRemember) await opts.onRemember(req);
      return { decision: "allow", decidedBy: "human" };
    } catch {
      return deny("unavailable");
    } finally {
      pendingRequestId = undefined;
    }
  }

  return {
    name: "human",
    resolve(req: AskRequest): Promise<AskLinkOutcome> {
      // Chain onto the queue and ALWAYS clear it, so a throw cannot leave the
      // mutex held and deadlock every later ask in the run.
      const result = queue.then(() => ask(req));
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
```

- [ ] **Step 4: Add the cancellation path**

Still in `src/interaction/ask-link.ts`, export a disposer. `InteractionChain.cancel()` has NO caller in `src/` today — run cleanup calls only `destroy()` (`src/execution/lifecycle/run-cleanup.ts:286-289`) — so without this a prompt in flight at run end can hang until `approvalTimeout` (up to an hour) after the run has finished.

```ts
/**
 * Settle a prompt that is still in flight when the run ends or aborts.
 * DENY, not abstain: this is the terminal link, and a run that is ending must
 * not execute a command nobody approved.
 */
export async function cancelPendingAsk(
  chain: InteractionChain | null | undefined,
  requestId: string | undefined,
): Promise<void> {
  if (chain === null || chain === undefined || requestId === undefined) return;
  await chain.cancel(requestId).catch(() => undefined);
}
```

Give the link a concrete exported type so the execution stage can reach the in-flight id:

```ts
/** An AskLink that also exposes the prompt currently awaiting a human. */
export interface HumanAskLink extends AskLink {
  pending(): string | undefined;
}
```

`createHumanAskLink` returns `HumanAskLink`, adding `pending: () => pendingRequestId` to the object it already returns. Task 7 calls `cancelPendingAsk(chain, link.pending())` on teardown.

- [ ] **Step 5: Export from the barrel**

Add to `src/interaction/index.ts`:

```ts
export { cancelPendingAsk, createHumanAskLink } from "./ask-link";
```

- [ ] **Step 6: Run the tests**

Run: `bun test test/unit/interaction/ask-link.test.ts --timeout=60000 && bun x tsc --noEmit`
Expected: PASS, all cases including the allowlist table and the mutex-release case.

- [ ] **Step 7: Verify the rendered message by eye, not by reading the code**

Run a one-off script that constructs an `AskRequest` and prints the `detail` string the operator would see. Confirm the command appears in full and unaltered. A rendered message is reviewed by rendering it.

- [ ] **Step 8: Commit**

```bash
git add src/interaction/ask-link.ts src/interaction/index.ts test/unit/interaction/ask-link.test.ts
git commit -m "feat(interaction): add the human ask link

An adapter, not a channel: renders an AskRequest as type 'choose' with
request-declared options, so telegram-format.ts stays permission-blind
and no plugin changes.

Never calls applyFallback, which maps BOTH continue and escalate to
approve -- a link built on it would auto-approve every escalated command
on timeout. Timeout denies unconditionally.

Replies are allowlisted, not denylisted: prompt() passes an unrecognised
action through verbatim, so only 'allow' and 'allow-remember' permit.

A command too long to display in one message denies rather than being
truncated: an operator must approve the string that runs.

Serializes prompts and releases the queue in both branches, so a throw
cannot deadlock every later ask."
```

---

## Task 7: Threading — build the chain at the execution stage

**Files:**
- Modify: `src/agents/types.ts:119-123` (beside `interactionBridge`), `src/agents/coding-tool-support.ts:326-344` (the `Pick`), `src/pipeline/stages/execution.ts:98-103`
- Test: `test/integration/permissions/approval-gate.test.ts`

**Interfaces:**
- Consumes: `chainAskLinks` (T1), `createApprovalsLink` (T5), `createHumanAskLink`/`cancelPendingAsk` (T6), `approvalsPath` (T4).
- Produces: a live `askResolver` reaching `createCodingToolRuntime` at `src/agents/coding-tool-support.ts:201`.

- [ ] **Step 1: Write the failing integration test**

Create `test/integration/permissions/approval-gate.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { buildCodingToolSupport } from "@/agents/coding-tool-support";
import { chainAskLinks } from "@/permissions";

function repo() {
  const root = makeTempDir("approval-gate-");
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "config"), "[core]\n");
  return root;
}

const allowLink = { name: "t", resolve: async () => ({ decision: "allow" as const, decidedBy: "human" as const }) };
const denyLink = { name: "t", resolve: async () => ({ decision: "deny" as const, decidedBy: "human" as const }) };

function session(root: string, links: Parameters<typeof chainAskLinks>[0]) {
  return buildCodingToolSupport({
    root,
    declared: ["Bash"],
    grants: [{ tool: "Bash", patterns: ["echo *"] }],
    bashApproval: "escalate",
    askResolver: chainAskLinks(links),
  });
}

describe("approval gate, end to end", () => {
  test("escalate + an allowing resolver EXECUTES the command", async () => {
    const root = repo();
    const outcome = await session(root, [allowLink])?.runtime.callTool("Bash", {
      command: "echo hi && echo there",
    });
    expect(outcome?.kind).toBe("ok");
    cleanupTempDir(root);
  });

  test("escalate + a denying resolver refuses and spawns nothing", async () => {
    const root = repo();
    const marker = join(root, "SHOULD-NOT-EXIST");
    const outcome = await session(root, [denyLink])?.runtime.callTool("Bash", {
      command: `echo hi && touch ${marker}`,
    });
    expect(outcome?.kind).toBe("denied");
    // Assert the EXECUTED outcome, not just the verdict: a gate that denies
    // while the side effect still lands satisfies a kind-only assertion.
    expect(Bun.file(marker).size).resolves.toBe(0);
    cleanupTempDir(root);
  });

  // SPEC CASE 10. The file lives under outputDir, outside repoRoot, so the
  // TYPED tools cannot address it. Assert the EXECUTED outcome -- whether the
  // file actually changed -- not the verdict alone.
  test("the approvals file is unreachable to the typed tools, reads included", async () => {
    const root = repo();
    const outside = makeTempDir("approvals-out-");
    const file = join(outside, "approvals.json");
    writeFileSync(file, '{"entries":[]}');

    const support = buildCodingToolSupport({
      root,
      declared: ["Read", "Write", "Delete"],
      grants: [
        { tool: "Read", patterns: ["*"] },
        { tool: "Write", patterns: ["*"] },
        { tool: "Delete", patterns: ["*"] },
      ],
      bashApproval: "gated",
    });

    for (const [tool, input] of [
      ["Read", { path: file }],
      ["Write", { path: file, content: "forged" }],
      ["Delete", { path: file }],
    ] as const) {
      const outcome = await support?.runtime.callTool(tool, input);
      expect(outcome?.kind).toBe("denied");
    }
    expect(readFileSync(file, "utf8")).toBe('{"entries":[]}');
    cleanupTempDir(root);
    cleanupTempDir(outside);
  });

  test("an empty chain denies: no channel means no approval", async () => {
    const root = repo();
    const outcome = await session(root, [])?.runtime.callTool("Bash", { command: "echo hi && echo there" });
    expect(outcome?.kind).toBe("denied");
    cleanupTempDir(root);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/integration/permissions/approval-gate.test.ts --timeout=60000`
Expected: FAIL — the allowing case denies, because no resolver is threaded.

- [ ] **Step 3: Add `askResolver` to `AgentRunOptions`**

In `src/agents/types.ts`, beside `interactionBridge` at `:119-123`:

```ts
  /**
   * Answers an `ask` verdict (P2). A runtime capability, not config -- built at
   * the execution stage, which is the only layer that can see both the
   * permission types and the interaction chain.
   */
  askResolver?: import("@/permissions").AskResolver;
```

- [ ] **Step 4: Add it to the `Pick` allowlist**

In `src/agents/coding-tool-support.ts`, add `| "askResolver"` to the `Pick<AgentRunOptions, ...>` list at `:326-344`, and forward it in the `buildCodingToolSupport` call further down:

```ts
    ...(options.askResolver !== undefined ? { askResolver: options.askResolver } : {}),
```

`interactionBridge` is deliberately NOT in this `Pick`; adding `askResolver` is an explicit widening of the seam, which is why it is one visible line.

- [ ] **Step 5: Build the chain at the execution stage**

In `src/pipeline/stages/execution.ts`, immediately after the `buildInteractionBridge` call at `:98-103`:

```ts
    const askResolver = chainAskLinks([
      createApprovalsLink({
        approvalsFile: approvalsPath(ctx.runtime.outputDir),
        repoRoot: ctx.workdir,
        stageModes: collectStageModes(ctx.config),
      }),
      // P5's classifier link slots in HERE, between cache and human.
      createHumanAskLink({
        // `ctx.interaction` is optional on PipelineContext, hence possibly
        // `undefined`. Task 6's signature accepts null AND undefined for that
        // reason -- do not "fix" this with a non-null assertion.
        chain: ctx.interaction,
        timeoutMs: ctx.config.execution?.approvalTimeout ?? 600_000,
        featureName: ctx.prd.feature,
        storyId: ctx.story.id,
        onRemember: async (req) =>
          appendApproval(approvalsPath(ctx.runtime.outputDir), {
            stage: req.stage,
            command: req.command ?? "",
            root: req.root ?? ctx.workdir,
            origin: "escalate",
            matchedRule: null,
            approvedAt: new Date().toISOString(),
            approvedBy: "telegram",
            naxCommit: process.env.NAX_COMMIT ?? "unknown",
          }),
      }),
    ]);
```

Register the teardown so a prompt in flight when the run ends is cancelled and denied, rather
than hanging until `approvalTimeout`. `InteractionChain.cancel()` has no caller in `src/`
today and run cleanup calls only `destroy()` (`src/execution/lifecycle/run-cleanup.ts:286-289`),
so this link owns its own abort path. Keep a reference to the human link and call it from the
same place the stage already unsubscribes its dispatch listener:

```ts
    const humanLink = createHumanAskLink({ /* as above */ });
    // ... alongside the existing `unsubscribe()` teardown:
    await cancelPendingAsk(ctx.interaction, humanLink.pending());
```

Add `askResolver` to `callCtx` exactly as `interactionBridge` is added at `:146`:

```ts
      ...(askResolver ? { askResolver } : {}),
```

Write `collectStageModes(config)` as a small local helper that walks `config.execution?.permissions` and returns every stage's resolved `bashApproval`, including the global default from `config.execution?.bashApproval`. Use the existing `resolveBashApproval` from `src/config/bash-approval.ts` — do not reimplement the precedence.

- [ ] **Step 6: Run the tests**

Run: `bun test test/integration/permissions/ --timeout=60000 && bun x tsc --noEmit`
Expected: PASS, including the full 21-row deny suite.

- [ ] **Step 7: Commit**

```bash
git add src/agents/types.ts src/agents/coding-tool-support.ts src/pipeline/stages/execution.ts \
        test/integration/permissions/approval-gate.test.ts
git commit -m "feat(pipeline): build the ask chain at the execution stage

Constructed beside buildInteractionBridge, which is the only layer that
can see both the permission types and the interaction chain, and threaded
through the Pick allowlist into the sole createCodingToolRuntime call
site. interactionBridge is not in that Pick, so adding askResolver is a
deliberate one-line widening rather than a free ride.

The integration test asserts the EXECUTED outcome -- whether the side
effect landed -- not the verdict alone: a gate that denies while the
command still runs satisfies a kind-only assertion."
```

---

## Task 8: Ledger `decidedBy` and the corpus log

**Files:**
- Create: `src/permissions/approval-audit.ts`
- Modify: `src/tools/runtime.ts` (the `audit` object in the ask branch)
- Test: `test/unit/permissions/approval-audit.test.ts`

**Interfaces:**
- Consumes: `AskRequest` (T3), `AskVerdict` (T1).
- Produces: `appendApprovalAudit(dir: string, runId: string, row: ApprovalAuditRow): Promise<void>`; `ApprovalAuditRow = { request: AskRequest; decision: "allow" | "deny"; decidedBy: AskDecidedBy; latencyMs: number; at: string }`.

**Why now:** every human allow/deny on a real escalated command is a ground-truth labelled example. P5's design says the bash corpus "does not exist today" and must be bootstrapped from shadow logs; logging here means P5 starts with real labels instead.

- [ ] **Step 1: Write the failing test**

Create `test/unit/permissions/approval-audit.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { appendApprovalAudit } from "@/permissions";

describe("approval audit", () => {
  test("appends one JSON object per line, with the command verbatim", async () => {
    const dir = makeTempDir("approval-audit-");
    const row = {
      request: { tool: "Bash", stage: "implementer", rule: "Bash", summary: "s", command: "bun run test | tail -5" },
      decision: "allow" as const,
      decidedBy: "human" as const,
      latencyMs: 4210,
      at: "2026-09-22T10:00:00.000Z",
    };
    await appendApprovalAudit(dir, "run-1", row);
    await appendApprovalAudit(dir, "run-1", { ...row, decision: "deny", decidedBy: "timeout" });

    const lines = readFileSync(join(dir, "run-1.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string).request.command).toBe("bun run test | tail -5");
    expect(JSON.parse(lines[1] as string).decidedBy).toBe("timeout");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/unit/permissions/approval-audit.test.ts --timeout=60000`
Expected: FAIL — `appendApprovalAudit` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/permissions/approval-audit.ts`:

```ts
/**
 * Ground-truth corpus of human permission decisions (P2 design 7.2).
 *
 * Every human allow/deny on a real escalated command is a labelled example --
 * from the actual decision-maker, on the real distribution. P5's classifier
 * needs exactly this corpus and its design records that none exists; writing it
 * now means P5 starts with labels rather than bootstrapping them.
 *
 * One JSON object per line, mirroring finish-audit (src/finish/audit.ts:42).
 */
import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { AskDecidedBy } from "./ask-chain";
import type { AskRequest } from "./types";

export interface ApprovalAuditRow {
  readonly request: AskRequest;
  readonly decision: "allow" | "deny";
  readonly decidedBy: AskDecidedBy;
  readonly latencyMs: number;
  readonly at: string;
}

export async function appendApprovalAudit(dir: string, runId: string, row: ApprovalAuditRow): Promise<void> {
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, `${runId}.jsonl`), `${JSON.stringify(row)}\n`, "utf8");
}
```

- [ ] **Step 4: Record `decidedBy` in the tool-audit ledger**

In `src/tools/runtime.ts`, the ask branch already has the `AskVerdict`. `log()` carries ten positional parameters plus an `audit?: { executed?, target? }` object at `:210` — put the approval record in THAT object, never an eleventh positional. Record it on the ALLOW path too, or a human-approved execution is indistinguishable from a mechanically-allowed one:

```ts
        const approval = {
          decidedBy: askVerdict.decidedBy,
          remembered: false,
          latencyMs: askVerdict.latencyMs,
        };
        if (askVerdict.decision === "allow") {
          return runTool(tool, input, verdict.resolvedPaths ?? [], { approval });
        }
```

Concretely, three edits and no restructuring:

1. `log()`'s `audit` parameter (`src/tools/runtime.ts:210`) gains a third optional field:
   `audit?: { executed?: readonly string[]; target?: "package" | "repoRoot"; approval?: { decidedBy: string; remembered: boolean; latencyMs: number } }`.
2. `runTool` (`:325-329`) gains a fourth optional parameter:
   ```ts
   async function runTool(
     target: CodingTool,
     callInput: Record<string, unknown>,
     resolvedPaths: readonly string[],
     approval?: { decidedBy: string; remembered: boolean; latencyMs: number },
   ): Promise<CodingToolOutcome> {
   ```
3. Both `log()` calls inside `runTool` currently pass `result.audit` as the ninth argument
   (`:350`, and the same position in the catch branch). Merge instead:
   ```ts
   { ...result.audit, ...(approval ? { approval } : {}) },
   ```
   The catch branch passes no audit today; give it `approval ? { approval } : undefined`.

- [ ] **Step 5: Wire the corpus write into the chain construction**

In `src/pipeline/stages/execution.ts`, wrap the composed resolver so each resolved ask appends a row:

```ts
    const baseResolver = chainAskLinks([...]);
    const askResolver = {
      resolve: async (req: AskRequest) => {
        const verdict = await baseResolver.resolve(req);
        await appendApprovalAudit(
          join(ctx.runtime.outputDir, "approval-audit"),
          ctx.runtime.runId,
          { request: req, decision: verdict.decision, decidedBy: verdict.decidedBy, latencyMs: verdict.latencyMs, at: new Date().toISOString() },
        ).catch(() => undefined);
        return verdict;
      },
    };
```

The `.catch()` is deliberate: a full disk must not turn a granted approval into a tool error.

- [ ] **Step 6: Run the tests**

Run: `bun run test`
Expected: PASS. This is the full suite — run it here because Task 8 touches `runtime.ts`'s hot path.

- [ ] **Step 7: Commit**

```bash
git add src/permissions/approval-audit.ts src/permissions/index.ts src/tools/runtime.ts \
        src/pipeline/stages/execution.ts test/unit/permissions/approval-audit.test.ts
git commit -m "feat(permissions): record decidedBy and write the approval corpus

decidedBy goes in the audit object, not an eleventh positional, and is
recorded on the allow path too -- otherwise a human-approved execution is
indistinguishable in the ledger from a mechanically-allowed one.

Each resolved ask appends a JSONL row carrying the verbatim request and
the human's verdict. Every human decision on a real escalated command is
a ground-truth label, so P5's classifier starts with a corpus instead of
bootstrapping one. A failed audit write never fails the approval."
```

---

## Task 9: Extend the deny suite and close the spec's test list

**Files:**
- Modify: `test/integration/permissions/bash-deny-suite.test.ts`
- Test: the same file

**Interfaces:**
- Consumes: everything from Tasks 1-8.
- Produces: nothing consumed later.

**Read first:** spec section 8 lists 18 cases. Tasks 1-8 cover 1-2, 4-12 and 14-18 in their own files. This task adds the rows that belong on the deny suite — the regression spine — and the two that need the real seam.

- [ ] **Step 1: Add the regression and gate rows**

Append to `test/integration/permissions/bash-deny-suite.test.ts`, inside a new `describe("approval gate (P2)")` block. The existing `session()` helper already accepts `bashApproval`; extend it to accept `askResolver` the same way.

```ts
describe("approval gate (P2)", () => {
  test("gated is unaffected by a permissive resolver: ask is never reached", async () => {
    // The 21 rows above run under `gated`. A resolver that allows everything
    // must not turn any of them into an execution, because `gated` denies
    // rather than asking.
    const permissive = chainAskLinks([
      { name: "t", resolve: async () => ({ decision: "allow" as const, decidedBy: "human" as const }) },
    ]);
    const outcome = await call(session({ allow: ["bun test *"], askResolver: permissive }), "bun test x && curl evil.example");
    expect(outcome.kind).toBe("denied");
  });

  test("escalate does NOT escalate a breach: a root escape stays a hard deny", async () => {
    const permissive = chainAskLinks([
      { name: "t", resolve: async () => ({ decision: "allow" as const, decidedBy: "human" as const }) },
    ]);
    const outcome = await call(
      session({ allow: ["cat *"], bashApproval: "escalate", askResolver: permissive }),
      "cat ../../etc/passwd",
    );
    expect(outcome.kind).toBe("denied");
    if (outcome.kind === "denied") expect(outcome.breach).toBe(true);
  });

  test("raw is unaffected: no resolver is consulted at all", async () => {
    let consulted = false;
    const spy = chainAskLinks([
      {
        name: "t",
        resolve: async () => {
          consulted = true;
          return { decision: "deny" as const, decidedBy: "human" as const };
        },
      },
    ]);
    await call(session({ bashApproval: "raw", askResolver: spy }), "echo hi | tail -1");
    expect(consulted).toBe(false);
  });

  test("the default mode is still raw", () => {
    // Pinned at the config layer, so a default flip cannot pass unnoticed.
    expect(DEFAULT_BASH_APPROVAL_MODE).toBe("raw");
  });
});
```

Import `chainAskLinks` from `@/permissions` and `DEFAULT_BASH_APPROVAL_MODE` from `@/config/bash-approval` at the top of the file.

- [ ] **Step 2: Run the suite**

Run: `bun test test/integration/permissions/bash-deny-suite.test.ts --timeout=60000`
Expected: PASS — the original 21 rows plus 4 new ones.

- [ ] **Step 3: Run everything**

Run: `bun run test && bun run check:all`
Expected: PASS. If `check-file-sizes.ts` reports a new oversized file, extract rather than raising the baseline.

- [ ] **Step 4: Commit**

```bash
git add test/integration/permissions/bash-deny-suite.test.ts
git commit -m "test(permissions): extend the deny suite for the three bash modes

The spine now proves the resolver cannot widen what the mechanical gate
refuses: gated never reaches the ask tier even with a permissive
resolver, escalate still hard-denies a breach rather than offering it for
approval, raw consults no resolver at all, and the default mode is pinned
so a flip cannot pass unnoticed."
```

---

## Task 10: Documentation and arc status

**Files:**
- Modify: `docs/adr/ADR-030-bash-approval-modes.md`, `docs/superpowers/specs/2026-09-22-p2-interactive-approval-gate-design.md` (status line)
- Modify (outside this repo): `../../nax-native-coding-agent-master-plan.md` section 6 phase table and changelog

- [ ] **Step 1: Amend ADR-030**

Append an amendment to ADR-030 recording what P2 changed. It must state: the ask tier now has a real resolver; the resolver is a CHAIN and is the single permission decision point; `escalate`'s advertised Bash description was deliberately identical to `gated`'s during P1 *because* the resolver always denied, and that reason has now expired, so the description should be revisited; the approvals cache's trust boundary and its two preconditions; and that the default remains `raw`.

- [ ] **Step 2: Revisit `escalate`'s tool description**

`src/tools/bash.ts:115-120` explains that `escalate`'s description is identical to `gated`'s because the headless resolver denies unconditionally, and says to revisit when P2 ships a real resolver. It has. Decide deliberately: if a real channel is configured, the description may now honestly say a human can approve. Whatever you decide, update the comment so it no longer points at a condition that has passed. If you change the text, the test pinning the two descriptions equal must be updated with it.

- [ ] **Step 3: Update the spec's status line**

Change the header's `**Status:** design approved, not implemented` to `implemented` and add the merge commit once merged.

- [ ] **Step 4: Update the master plan**

In `../../nax-native-coding-agent-master-plan.md`, set P2's row in the section 6 table to the implemented state with the PR link, and add a changelog entry under section 8 recording what shipped and what did not.

- [ ] **Step 5: Commit**

```bash
git add docs/adr/ADR-030-bash-approval-modes.md docs/superpowers/specs/2026-09-22-p2-interactive-approval-gate-design.md src/tools/bash.ts
git commit -m "docs(p2): amend ADR-030 for the interactive approval gate"
```

---

## Before opening the PR

- [ ] `bun run test` green.
- [ ] `bun run check:all` green.
- [ ] The 21 original deny-suite rows still refuse.
- [ ] **Code review BEFORE push, never after** — a standing rule in this workspace.
- [ ] No default changed: `DEFAULT_BASH_APPROVAL_MODE` is still `raw`.

## After the PR — P2's exit (NOT part of this plan's tasks)

Spec section 9 requires the gate exercised end to end on the P0 corpora with `bashApproval: escalate` and a reachable Telegram chat. **These are billed `nax run`s and require explicit user approval at the launch moment.** Do not launch them as part of implementing this plan. Gate on artifacts, never on exit codes — nax exits 0 on failure.
