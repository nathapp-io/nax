# Whole-Repo Code Review: nax monorepo

**Date:** 2026-11-09
**Version:** 0.91.8-canary.4 (HEAD `475562fda`, main)
**Scope:** every package (`nax`, `nax-agent`, `nax-agent-acp`, `nax-ai`, `repo-tooling`). The review covers correctness and security, not style. Code reachable only through `execution.mode: "pipeline"` (frozen) is out of scope.
**Previous review:** [20261024-review-nax.md](20261024-review-nax.md) (HEAD `6cf9150`, 110 commits ago). Items still open from it are tagged **carried: <old id>**.

## Baseline

After `bun install` and `bun run build`, every gate passes:

| Gate | Result |
|:---|:---|
| `bun run typecheck` | exit 0 |
| `bun run check:all` | exit 0 |
| `bun run test` | exit 0 (nax unit / integration / ui phases all pass; nax-agent 5637, nax-agent-acp 1754, nax-ai 742, repo-tooling 433) |
| Import cycles (nax, nax-agent, nax-agent-acp) | 0 / 0 / 0 |
| `check:nax-error` | 0 violations |
| `check:file-sizes` (nax) | 8 grandfathered (was 11 on 10-24) |

The nax-agent log has one `0 pass / 1 fail` block: `test/fixtures/confined/writes-literal-tmp.fixture.ts`. That fixture is a sandbox probe that must get `EPERM` on `/tmp`, so the block is expected and is not a failure.

## How the review was done

- **First wave.** Eight independent reviewers each took one area: the workflow machine, execution/runtime, agents plus ACP, nax-agent, config/cli/nax-ai, context/review/operations, chat/tui/interaction, and bot/forge/memory/misc.
- **Second wave.** First-wave coverage was 10-45% per area, so six more passes read the files the first wave skipped.
- **Proof.** Every finding had to carry a quoted location, a concrete failure scenario, and either a reproduction (a scratch script calling the real function, with its output) or a traced call path with every hop cited.
- **Verification.** The lead reviewer re-ran the reproductions behind every HIGH and nearly every MEDIUM against HEAD. The **Verified** line on each finding says how it was checked:
  - **re-run** means the lead ran the reproduction and saw the stated output.
  - **code read** means the lead checked the cited lines but did not run anything.
  - **agent repro** means only the area reviewer ran it.
- **Confidence:**
  - **CONFIRMED** means reproduced, or a traced path with no guard on it.
  - **PLAUSIBLE** means the path is real, but the impact depends on outside behaviour such as timing, a remote service or the OS.
- **Coverage:** about 570 of 1,716 non-test source files were read in full or in large part, about one third. The **Coverage gaps** section lists what was not read. A clean result for an unread file means nothing.
- **Safety:** no `nax run`, `nax plan`, LLM call or forge write was made. All reproductions ran in a scratch directory with fake credentials. The repo tree was left untouched; this file is the only addition.

---

## Summary

| Severity | New | Carried | Total |
|:---|---:|---:|---:|
| HIGH | 2 | 0 | 2 |
| MEDIUM | 16 | 7 | 23 |
| LOW | 26 | 11 | 37 |

**Recommended first sweep:** H1, H2, M1, M2, M3, M7, M9, M11, M18. Each is small and local, and all are confirmed by re-run.

Since 10-24 the following are **fixed** and verified at HEAD: H1, H2 (native and Bash-token paths), M1, M2, M3, M4, M5, M6, M16, L7 and L14, plus the P4 fingerprint removal.

---

## HIGH

### H1. A dangling symlink bypasses write containment and the `.git/` write ban (nax-agent)

**Category:** Security (sandbox escape, path traversal) · **Confidence:** CONFIRMED · **Verified:** re-run

`packages/nax-agent/src/internal/realpath.ts:31-46`:
```ts
export function realOrRaw(p: string): string {
  ...
    try {
      return trailing.length === 0 ? realpathSync(current) : join(realpathSync(current), ...trailing);
    } catch {
      ...
      trailing.unshift(basename(current));
      current = parent;
```
`packages/nax-agent/src/tools/policy-paths-branch.ts:105-112`:
```ts
export function resolveWithin(root: string, candidate: string, owned: OwnedPathsPolicy): string | null {
  const absolute = isAbsolute(candidate) ? candidate : resolve(root, candidate);
  if (isInside(root, absolute)) {
    const resolved = realOrRaw(absolute);
    if (entersGitMetadata(root, resolved) || owned.configRefusal(root, resolved) !== undefined) return null;
    return resolved;
```
`packages/nax-agent/src/tools/write.ts:41-42`: `await writeFile(target, content, "utf8");`

**How it fails:**
- `realpathSync` throws on a dangling symlink, so `realOrRaw` falls back to the lexical path, which looks in-root and has no `.git` segment.
- `writeFile` then follows the link and creates the target.
- The `Write` tool is declared for the implementer op (`packages/nax/src/operations/workflow-implement.ts:32`).

**Scenario:** the tree contains `hook-link -> .git/hooks/pre-commit` or `out -> ../../outside/file`, and the target does not exist yet. `Write {path: "hook-link"}` is admitted and writes a git hook (code execution on the next commit), or a file outside the root.

**Proof:** lead re-run, with `resolveWithin` called and each admitted path then written:
```
dangling.txt          -> <root>/dangling.txt      (admitted)
hook-link             -> <root>/hook-link         (admitted)
.git/hooks/pre-commit -> null                     (direct path correctly refused)
outside/new.txt exists: true
.git/hooks/pre-commit exists: true
```

**Precondition:** a dangling symlink in the tree, from repository content or from a code-executing granted command. Bash `ln -s` to an outside target is blocked by the token gate.

**Fix:** `lstat` the final component. If it is a symlink, resolve its target even when dangling (`readlink`), then re-run the containment and `.git` checks on the result. Alternatively open writes with `O_NOFOLLOW`.

### H2. An Anthropic subscription OAuth credential imported from pi is used for inference, bypassing the OAuth policy (nax-ai / nax-agent)

**Category:** Security / policy bypass · **Confidence:** CONFIRMED · **Verified:** re-run (fake credential, no network)

The policy is `packages/nax-ai/src/auth/oauth-policy.ts:26`:
```ts
export const PERMITTED_OAUTH_FLOWS: readonly ProviderId[] = Object.freeze(["openai-codex", "openrouter"]);
```
Its header (`:10-14`) says Anthropic subscription OAuth "must never be registered here". It is enforced only at login (`packages/nax-ai/src/auth/pi-auth.ts:166`).

**How it fails:**
- **Import.** `packages/nax-agent/src/native/auth.ts:214-230` copies every provider entry from `~/.pi/agent/auth.json` into the nax store with no policy check:
  ```ts
  for (const providerId of Object.keys(parsed).sort()) {
    const entry = parsed[providerId];
    const credential = ... fromPiEntry(entry) ...;
    ...
    await store.modify(providerId, async (existing) => { ... return credential; });
  ```
- **Catalog.** The catalog gate at `packages/nax-ai/src/providers/catalog.ts:81` checks `auth.kind === "oauth"`, but `pi-catalog.ts:29-32` maps anthropic to `kind: "api-key"`, so that gate never fires.
- **Resolution.** pi-ai resolves a stored OAuth entry whenever the provider declares OAuth (`@earendil-works/pi-ai dist/auth/resolve.js:26-27`), and Anthropic declares it.

**Scenario:** a user who logged into Anthropic with pi's own CLI runs `nax auth import`. Every later Anthropic request from nax sends the subscription access token as the API key.

**Proof:** lead re-run of `createFileCredentialStore` → `toPiCredentialStore` → `builtinModels` → `createPiAuthResolver.resolve({provider: "anthropic"})`, using a fake `kind: "oauth"` credential:
```
resolved apiKey === stored access token: true
resolved keys: apiKey
```
The import half is traced: `grep` finds no `isOAuthFlowPermitted` call outside `pi-auth.ts`.

**Fix:** refuse `oauth` credentials for providers outside `PERMITTED_OAUTH_FLOWS` in `importPiCredentials`. Also filter them out of `toPiCredentialStore.read/modify`, so pi never sees one.

---

## MEDIUM

### M1. Bash deny and ask rules are evaded by exec wrappers missing from the canonicalizer table (nax-agent)

**Category:** Security (policy bypass) · **Confidence:** CONFIRMED · **Verified:** re-run

`packages/nax-agent/src/tools/bash-canonical.ts:14-20` lists `env`, `command`, `exec`, `time`, `nohup`, `nice` and a few more. Then, at `:158-159`:
```ts
const wrapper = Object.hasOwn(WRAPPERS, head.text) ? WRAPPERS[head.text] : undefined;
if (wrapper === undefined) break;
```
Deny and ask matching runs on these canonical segments (`tools/policy-bash.ts:300-309`, `:333`). An unknown wrapper stops canonicalization, so the rule pattern never sees the real command.

**Proof:** lead re-run, with grant `Bash(*)` plus `deny: Bash(git push*)` or `ask: Bash(git push*)`:
```
git push origin main               | deny-rule: denied   | ask-rule: ask
setsid git push origin main        | deny-rule: ALLOWED  | ask-rule: ALLOWED
ionice -c3 git push origin main    | deny-rule: ALLOWED  | ask-rule: ALLOWED
nice git push origin main          | deny-rule: denied   | ask-rule: ask
caffeinate git push origin main    | deny-rule: ALLOWED  | ask-rule: ALLOWED
arch -arm64 git push origin main   | deny-rule: ALLOWED  | ask-rule: ALLOWED
```

**Fix:** when any deny or ask rule exists, treat an unknown head that is followed by a known command as `ask`. Also extend `WRAPPERS` with setsid, ionice, chrt, taskset, flock, caffeinate, arch, unbuffer, script, chroot, unshare, nsenter, su and runuser.

### M2. A `Bash(git *)` grant admits code-executing `git -c` / `--config-env`, which the Git tool refuses (nax-agent)

**Category:** Security (classifier bypass) · **Confidence:** CONFIRMED · **Verified:** re-run (gate)

- `packages/nax-agent/src/tools/policy-bash.ts:171-172` checks `deniedFlag(words)` against `DENIED_FLAGS` (`tools/exec-guard.ts:100-120`), which has no git escape flags.
- `GIT_ESCAPE_FLAGS` (`tools/git-flags/index.ts:10`, which includes `-c`) is used only by `git.ts` and the command interceptor.

**Proof:**
- Lead re-run, gate with grant `git *`:
  ```
  git -c core.pager=sh status            allowed: true
  git -c core.fsmonitor=x status         allowed: true
  git --config-env=core.pager=X status   allowed: true
  ```
- Agent repro of the execution side: `git -c core.fsmonitor="sh -c 'echo EXECUTED > marker'" status` wrote the marker.
- When the sandbox is unavailable (see M3), gated commands run unwrapped, so this executes outside any sandbox.

**Fix:** apply `GIT_ESCAPE_FLAGS` (plus `--config-env`) in the Bash payload check for the `git` verb.

### M3. A glob character in the repo path silently disables the sandbox for gated Bash (nax-agent)

**Category:** Security (sandbox fails open) · **Confidence:** CONFIRMED · **Verified:** re-run

**How it fails:**
- `packages/nax-agent/src/sandbox/policy-builder.ts:78-88`: `literal()` throws `SANDBOX_POLICY_NOT_LITERAL` on any of `*?[]{}`. Its comment says "fail closed instead".
- `packages/nax-agent/src/coding-tools/coding-tool-sandbox.ts:188-191` maps that error to the unavailable state:
  ```ts
  const policyError = await literalPolicyError(policyFor, args.root, confined);
  if (policyError !== undefined) {
    warnSandboxUnavailableOnce(policyError, args.storyId);
    return createCommandLauncher({ state: { kind: "unavailable", backend: backend.name, reason: policyError } });
  ```
- `packages/nax-agent/src/sandbox/launcher.ts:205-207` runs `unavailable` commands unwrapped (`runUnwrapped`).
- No config option makes the unavailable state fail closed: `grep` for `required`, `failClosed` and `onUnavailable` in the sandbox schema, launcher and coding-tool-sandbox finds nothing.

**Proof:** lead re-run of the reviewer's `buildSandboxPolicy` repro:
```
/private/tmp/plain-repo -> policy ok, writeRoots: 12
/private/tmp/repo[v2]   -> THROWS SANDBOX_POLICY_NOT_LITERAL ...
```

**Scenario:** a project at `~/work/app[v2]`. Every gated Bash command then runs without OS confinement, with only a one-time warning.

**Fix:** a policy-build error is a nax fault, not a host-capability gap. Refuse gated commands in that case, or escape the glob characters.

### M4. GitCommit runs in-tree hooks (`core.hooksPath`) outside the sandbox (nax-agent) · carried: M7

**Category:** Security · **Confidence:** CONFIRMED · **Verified:** code read + agent repro

**How it fails:**
- `packages/nax-agent/src/tools/git-commit.ts:37` builds `commit: ["commit", "-m", message]`, and `:219` runs it through `gitWithTimeout`, outside the sandbox.
- `internal/git-env.ts:38-42`: `HARDENED_GIT_CONFIG` does not set `core.hooksPath`.
- `sandbox/policy-builder.ts:96-101` denies writes only to `<gitdir>/hooks`.

**Scenario:** the repo sets `core.hooksPath=.husky`. The agent writes `.husky/pre-commit`, which is admitted because it has no `.git` segment, and `GitCommit` then runs it unsandboxed.

**Proof:** agent repro: with `core.hooksPath=.husky`, `git commit -m msg` ran `.husky/pre-commit`, which wrote a marker.

**Fix:** pass `-c core.hooksPath=/dev/null` (or `--no-verify`) in `GitCommit` and `gitlinkSafeAdd`, and make hooks an explicit opt-in.

### M5. "Always allow" still widens to package runners: `npm exec x` remembered approves `npm exec anything` (nax-agent / ACP server) · carried: M8 (partial fix)

**Category:** Security (permission bypass) · **Confidence:** CONFIRMED · **Verified:** re-run

`packages/nax-agent/src/permissions/approval-memory.ts:68-81`:
```ts
if (name === "" || WRAPPERS.has(name)) return undefined;
if (second === undefined) return `${request.tool}:${first}`;
if (second.startsWith("-")) return undefined;
return PLAIN_WORD.test(second) ? `${request.tool}:${first} ${second}` : undefined;
```
`WRAPPERS` (`:16-55`) lists `npx`, `bunx` and `pnpx`, but `npm exec`, `npm run`, `pnpm dlx` and `yarn dlx` fall through to the two-word key. The ACP server calls this at `packages/nax-agent-acp/src/server/permissions.ts:122-124`.

**Proof:** lead re-run:
```
remember "npm exec prettier" key "Bash:npm exec" -> "npm exec evil-pkg" autoAllowed: true
remember "npm run test"      key "Bash:npm run"  -> "npm run deploy"    autoAllowed: true
remember "pnpm dlx x"        -> "pnpm dlx attacker" autoAllowed: true
remember "yarn dlx a"        -> "yarn dlx b"        autoAllowed: true
```

The flag-second-word and masked-command parts of the old M8 are fixed (`:71`, `:79`).

**Fix:** treat `npm|pnpm|yarn|bun` followed by `exec|x|dlx|run` as a wrapper (no key), or key remembered allows on the full plain-word argv.

### M6. Operator `Bash` deny rules are not enforced on sandbox-wrapped commands for opencode and pi (nax-agent-acp) · carried: L2 (raised to MEDIUM)

**Category:** Security · **Confidence:** CONFIRMED · **Verified:** re-run

`packages/nax-agent-acp/src/client/permissions.ts:240-243`:
```ts
const inner = wrapped && plan?.verify ? command.slice(plan.prefix.length + 1, -1).replaceAll("'\\''", "'") : command;
if (shellRuleBlocks(inner, ctx.rules ?? NO_RULES)) return deny(SHELL_RULE_BLOCKED_REASON);
```
`plan.verify` is `agent === "cursor"` (`client/shell-sandbox.ts:128`). For opencode and pi the rule is therefore matched against the sandbox-wrapper text, which never matches the deny pattern.

**Proof:** lead re-run, review profile with a `Bash` deny rule:
```
opencode wrapped verify=false -> selected "a" (allow)   <- bug
cursor   wrapped verify=true  -> selected "r" (reject)
opencode unwrapped            -> selected "r" (reject)
```
The sandbox still confines the command. What is lost is the operator's explicit deny rule (for example `git push *`).

**Fix:** decode the inner command whenever `wrapped` is true, not only when `verify` is set.

### M7. Every ACP agent subprocess receives all provider API keys and every `NAX_*` variable, including `NAX_TELEGRAM_TOKEN` (nax)

**Category:** Security (secret exposure) · **Confidence:** CONFIRMED · **Verified:** re-run (fake values)

`packages/nax/src/agents/shared/env.ts:22-38`:
```ts
const API_KEY_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "CLAUDE_API_KEY"];
const ALLOWED_PREFIXES = ["CLAUDE_", "NAX_", "CLAW_", "TURBO_", "CODEX_", "GEMINI_", "ANTHROPIC_", "OPENCODE_", "MINIMAX_"];
```

**How it fails:**
- `agents/acp/open-context.ts` (`backendEnv`) passes this whole set as `extra`.
- `nax-agent-acp/src/client/env.ts` merges it with `{ ...Object.fromEntries(picked), ...input.extra }`, which bypasses the backend's own `authEnv` allowlist.
- `NAX_TELEGRAM_TOKEN` is the Telegram bot secret (`interaction/plugins/telegram.ts:81`).

**Proof:** lead re-run with fake values in an `env -i` shell. The spawn env contained `NAX_TELEGRAM_TOKEN`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `HOME` and `PATH`.

**Scenario:** a prompt-injected pi, opencode, cursor or codex agent with shell access runs `env` and reads keys and the bot token it never needed. The source comment calls the extras "harmless to pass", which holds for API keys the agent may use but not for bot tokens or other providers' keys.

**Fix:** for ACP launches, forward the essential vars plus the registry entry's `authEnv` only. Drop the blanket `NAX_` prefix and the cross-provider keys.

### M8. An `@` mention through a symlink attaches a git-ignored file such as `.env` (nax chat)

**Category:** Security (secret exposure) · **Confidence:** CONFIRMED · **Verified:** re-run (test secret)

`packages/nax/src/chat/mentions/mention-expand.ts:160`, `:190-191`:
```ts
const ignored = await ignoredRefusal(located.path, ctx.cwd);
...
const result = await _mentionExpandDeps.git([...CHECK_IGNORE_ARGS, path], cwd);
```
The boundary check uses the real path, but the ignore check uses the typed path.

**Proof:** lead re-run, with `.gitignore` = `.env` and `docs/notes.txt -> ../.env`:
```
direct .env: [{"path":".env","status":"refused","note":"not attached: ignored by git"}]
via symlink: [{"path":"docs/notes.txt","status":"attached","body":"SECRET_TOKEN=<test-value>\n"}]
```

**Scenario:** a cloned repo commits such a symlink, or the user mentions one without realising where it points. The secret is sent to the model.

**Fix:** also run `git check-ignore` on the real path (relative to the real root), and refuse if either path is ignored.

### M9. A failed cost-ledger drain drops the committed events from memory and from disk (nax runtime)

**Category:** Reliability (cost accounting) · **Confidence:** CONFIRMED · **Verified:** re-run

`packages/nax/src/runtime/cost-aggregator.ts:556`, `:581`, `:591-594`:
```ts
let committed = [...this._events.splice(0), ...this._errors.splice(0)];
...
await _costAggDeps.write(path, `${committed.map((e) => JSON.stringify(e)).join("\n")}\n`);
...
this._events.length = 0;
this._events.push(...committedEvents);
```
The events are spliced out before the write. If the write throws (ENOSPC, EACCES), the restore at `:591` never runs, and `finally` only resets `_draining`. The next successful drain then rewrites `<runId>.jsonl` with the later events only.

**Callers:** `runtime/index.ts:463` (run close) and `chat/chat-ledger.ts:60` (every chat turn).

**Proof:** lead re-run: turn 1 drain ok, turn 2 drain fails, turn 3 drain ok:
```
rows on disk after turn 3: [ "turn3" ]
in-memory total: 1 (expected 3)
```

**Fix:** write from a copy, and splice out only after the write resolves.

### M10. A failed or timed-out `complete()` hop loses its token cost (nax agents) · carried: M9

**Category:** Reliability (cost accounting) · **Confidence:** CONFIRMED · **Verified:** code read

`packages/nax/src/agents/manager-dispatch.ts:580-597`:
```ts
} catch (err) {
  return {
    result: { output: "", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0,
              adapterFailure: classifyFailure(err) },
    dispatched: false,
```

**How it fails:**
- `agents/acp/complete.ts:105-114` rethrows the `SessionTurnError`, which carries the spend (on max-tokens or a refusal), and throws a plain `NaxError` on timeout.
- The catch above records zero. The dispatch event (`manager-dispatch.ts:107`) is what the cost middleware ledgers, so the spend is never recorded.

**Fix:** copy `readTurnSpend(err)` into the result, and make the timeout throw a `SessionTurnError` that carries the spend.

### M11. The PRD escape sanitizer rewrites valid JSON, silently changing story text (nax prd)

**Category:** Bug (silent data corruption) · **Confidence:** CONFIRMED · **Verified:** re-run

`packages/nax/src/prd/schema.ts:42`, `:46-47`, `:78-81`:
```ts
let result = text.replace(/\\x([0-9a-fA-F]{1,2})/g, (_, hex) => ...);
result = result.replace(/\\u(?![0-9a-fA-F])/g, "\\");
...
const sanitized = sanitizeInvalidEscapes(cleaned);
return JSON.parse(sanitized);
```
The sanitizer runs before every parse, including on valid input, and does not skip an escaped backslash.

**Proof:** lead re-run of `validatePlanOutput`:
```
raw JSON text description: Path C:\users and \xampp
validated description:     "Path C:\\sers and \\u000ampp"
```
Any story or AC that mentions a Windows path, `\x` or `\u` is silently changed.

**Fix:** try `JSON.parse` first and sanitize only on failure, or consume `\\` pairs before the `\x` and `\u` rules.

### M12. An MCP memory forget reports `deleted` when the remote delete failed, and drops the remote ids (nax memory)

**Category:** Reliability (forget guarantee / data loss) · **Confidence:** CONFIRMED · **Verified:** re-run

`packages/nax/src/memory/mcp-provider.ts:107-116`, `:130-134`. `forgetRemote` only warns on `result.isError` or a thrown error. The caller then runs `await idMap.drop(request.scope, request.slug, ids); return deleted;`.

**Proof:** lead re-run with a pool whose `call` throws:
```
warn: memory mcp forget failed
push result: {"id":"c1","status":"deleted"}
idMap.drop called with: [["project","replay-budget",["remote-1"]]]
```
The outbox treats the forget as delivered and never retries it, and the remote copy stays searchable.

**Fix:** surface the failure as retryable (`MEMORY_MCP_CALL_FAILED`), and drop only the ids the server confirmed.

### M13. An MCP forget with no `tools.forget` configured reports `deleted`, while the remote copy is still returned first by search (nax memory)

**Category:** Reliability · **Confidence:** CONFIRMED (mechanism) · **Verified:** code read

**How it fails:**
- `packages/nax/src/memory/mcp-provider.ts:118-124`:
  ```ts
  if (tool === undefined) { await idMap.drop(request.scope, request.slug); return deleted; }
  ```
- The schema (`config/schemas-memory.ts:45-46`, `:56`) makes `forget` optional, because OpenMemory has no delete tool.
- `memory/host-remote-search.ts:64-71` (`mergeRemoteFirst`) ranks remote hits, including the forgotten memory, ahead of local hits.

**Fix:** report the forget as not delivered when a remote copy remains, or refuse forget when remote search is configured without a forget tool.

### M14. An unreadable koda approvals file is overwritten by the next write, dropping every pending record (nax memory)

**Category:** Reliability (data loss) · **Confidence:** CONFIRMED (mechanism); the trigger is PLAUSIBLE · **Verified:** re-run

`packages/nax/src/memory/koda-approvals.ts:148-165`, `:253-254`:
```ts
} catch (cause) { ... return { approvals: [], state: missing ? "missing" : "unusable", ... } }
...
const { approvals } = await read(); await writeApprovals(path, withRecorded(approvals, readable));
```
`memory/mcp-id-map.ts:84-99`, `:144-150` has the same shape (traced, not run).

**Proof:** lead re-run: three records, `chmod 000`, then a fresh instance records one more:
```
warn: koda approvals file is unusable
after a read error + one record: [ "apr_3" ]
```

**Fix:** throw on any read error other than ENOENT, and overwrite only when the content is confirmed corrupt.

### M15. Vitest detection takes `coverage.include` as the test-file pattern, with high confidence (nax test-runners)

**Category:** Bug (gate scoping) · **Confidence:** CONFIRMED · **Verified:** re-run (clean fixture)

`packages/nax/src/test-runners/detect/framework-configs.ts:53`:
```ts
const includeMatch = text.match(/include\s*:\s*\[([^\]]+)\]/s);
```
`parseViteConfig` in the same file extracts the balanced `test: {}` block first; `parseVitestConfig` does not.

**Proof:** lead re-run, with `vitest.config.ts` = `defineConfig({ test: { coverage: { include: ["src/**/*.ts"] } } })`:
```
{"patterns":["src/**/*.ts"],"confidence":"high","sources":[{"type":"framework-config","framework":"vitest",...}]}
```

**Downstream (traced):**
- Every source file is treated as a test file, and `code-neighbor-phases.ts:288` returns null for each.
- Greenfield detection becomes wrong.
- Scoped selection passes source files as tests. The scoped command then fails and `verify-scoped.ts:288` reruns the full suite, so the cost is an extra run, not a false pass.

**Fix:** reuse `extractBalancedBlock(text, /\btest\s*:\s*\{/)`, as `parseViteConfig` does.

### M16. A rule `appliesTo` written with brace globs (`*.{ts,tsx}`) never matches and gives no warning (nax context)

**Category:** Bug (rules silently not delivered) · **Confidence:** CONFIRMED · **Verified:** re-run

`packages/nax/src/context/engine/scope-path-match/index.ts:43` counts `{` as glob meta. Then `:115-116` escapes `{`, `}` and `,` rather than expanding them:
```ts
if (`.+^${}()|[]\\`.includes(c)) { regex += `\\${c}`; }
```

**Proof:** lead re-run:
```
parsed appliesTo: [ "src/**/*.{ts,tsx}" ]
brace glob vs src/a.ts: false
star glob vs src/a.ts: true
```
The same brace syntax works in test-pattern detection (`framework-configs.ts` `normalize()`), so the two paths disagree.

**Fix:** expand braces (`expandExtglobAll` already exists in `test-runners/detect/extglob.ts`), or reject brace patterns in `rules-frontmatter.ts`.

### M17. The import-grep fallback caps at 200 test files in readdir order, so scoped verification can skip affected tests (nax verification)

**Category:** Reliability (gate under-selection) · **Confidence:** CONFIRMED (truncation), PLAUSIBLE (missed test) · **Verified:** agent repro

`packages/nax/src/verification/smart-runner.ts` (`importGrepFallback`, about `:138-170`):
```ts
if (testFilePaths.length >= maxScanFiles) {
  getSafeLogger()?.debug("smart-runner", "import-grep glob cap reached — results truncated", {...});
  break outer;
}
```
`test-runners/scoped-selection.ts` (Pass 2) treats any non-empty result as authoritative.

**Proof:** agent repro with 261 test files that all import `src/a`: uncapped 261, capped 200. An empty result falls back to the full suite. The harm is a partial non-empty result.

**Fix:** escalate to the full suite when the cap is hit, logged at warn.

### M18. `nax setup --fill-scripts` overwrites an unparseable `package.json` (and `turbo.json`) with a stub (nax cli)

**Category:** Bug (data loss) · **Confidence:** CONFIRMED · **Verified:** re-run

`packages/nax/src/cli/setup-fill.ts:9-16`, `:23-28`:
```ts
readJson: async (path) => { try { ... return JSON.parse(await f.text()) } catch { return null; } },
...
const pkg = (await _fillScriptsDeps.readJson(pkgJsonPath)) ?? {};
...
await _fillScriptsDeps.writeFile(pkgJsonPath, JSON.stringify(updated, null, 2));
```
`addTurboTask` (`:31-38`) has the same shape. The CLI path is `bin/nax.ts:200` → `setup.ts:97`; only `--dry-run` returns earlier.

**Proof:** lead re-run on a copy whose `package.json` has a trailing comma:
```
before: { "name": "my-app", "version": "1.2.3", "dependencies": { "left-pad": "^1.3.0" }, "scripts": { "build": ... }, }
shape single missing [["build","test","lint","type-check","lint:fix"]]
after: { "scripts": { "type-check": "tsc --noEmit -p tsconfig.json" } }
```
The name, version, dependencies and workspaces are lost. This is MEDIUM rather than HIGH because the file was already broken and is normally recoverable from git.

**Fix:** tell "absent" apart from "unparseable", and skip the write with a warning when the file exists but does not parse.

### M19. The registry hydrate path skips config validation (nax config) · carried: M12

**Category:** Bug (validation gap) · **Confidence:** CONFIRMED · **Verified:** re-run

`packages/nax/src/config/loader.ts:390-407` (`loadPackageOverrideWithConfig`) calls `mergePackageConfig(rootConfig, resolved)` with no `applyConfigCompatShims`, `resolveEnvVars`, `validatePermissionsBlock` or `safeParse`. `runtime/packages.ts:210-232` (`hydrate`) uses that path.

**Proof:** lead re-run with `.nax/mono/packages/api/config.json` = `{"execution":{"costLimit":-5}}`:
```
loadConfigForWorkdir threw: PER_PACKAGE_PROFILE_INVALID ...
loadPackageOverrideWithConfig: returned costLimit= -5
```

**Fix:** one shared helper (shims → env → guards → safeParse) used by both paths.

### M20. Reserved project names still miss real `~/.nax` subdirectories (nax cli) · carried: M13

**Category:** Bug (destructive collision) · **Confidence:** CONFIRMED · **Verified:** re-run

`packages/nax/src/cli/init.ts:50`:
```ts
if (["global", "_archive"].includes(name)) return { valid: false, ... }
```
`commands/migrate.ts:45-68` (`--reclaim`) renames `~/.nax/<name>` into `_archive` without a prompt.

**Proof:** lead re-run: `runs`, `profiles`, `acp`, `plugins`, `events` and `trust` all return `{"valid":true}`.

**Scenario:** `nax migrate --reclaim profiles` archives every named profile.

**Fix:** one exported reserved list, derived from the children of `globalConfigDir()`, used by init, the schema and migrate.

### M21. The tree-kill SIGKILL pass skips descendants that were reparented when their parent died (nax execution) · carried: M15

**Category:** Resource (orphaned process) · **Confidence:** CONFIRMED · **Verified:** code read + agent repro

`packages/nax/src/execution/pid-registry.ts:337`:
```ts
if (current.parentPid !== proc.parentPid || current.startedAt !== proc.startedAt) {
  getSafeLogger()?.warn("pid-registry", `Skipping SIG${signal} for PID ${proc.pid} after identity changed`, ...
```

**Proof:** agent repro: a child that traps TERM under a shell. After TERM to the shell, the child had `ppid=1` and was still alive, so the KILL pass skipped it.

**Fix:** in the KILL pass, match on `pid` plus `startedAt` only.

### M22. The auto-PR plugin pushes and opens a PR from whatever branch is current, including `main` (nax plugins; opt-in)

**Category:** Safety gate · **Confidence:** CONFIRMED (mechanism) · **Verified:** code read (reachability)

`packages/nax/src/plugins/builtin/auto-pr/index.ts:221`:
```ts
_autoPrDeps.run(["git", "push", "-u", "origin", context.branch], ...)
```
`shouldRun` (`:182-196`) has no branch check.

**Reachability:**
- The branch comes from `git branch --show-current` (`execution/runner.ts:387-391`).
- Post-run actions are dispatched from `execution/lifecycle/run-cleanup.ts:297` in both modes.
- The workflow publisher already guards this case with `isPublishableBranch` (`workflow/finalize.ts:73-76`, which treats `""`, `main` and `master` as protected). Auto-PR has no equivalent.

**Precondition:** `autoPr.enabled: true` (default false) and a run started on the default branch.

**Fix:** apply `isPublishableBranch` in `shouldRun` and `execute`.

### M23. koda memory search returns retired rows as `status: "active"` hits (nax memory)

**Category:** Reliability / privacy · **Confidence:** PLAUSIBLE · **Verified:** re-run (mapping)

`packages/nax/src/memory/koda-mapping.ts:466-477` (`kodaHitOf`) always returns `status: STATUS_ACTIVE` and never reads `deletedAt` or `status`. The search request (`koda-provider.ts:336-341`) sends no status filter; the lookup path (`koda-lookup.ts:143`) does pass `status: "active"`.

**Proof:** lead re-run: a row with `status: "rejected"` and a set `deletedAt` maps to `{"slug":"old-rule",...,"status":"active",...}`. Whether koda's search filters retired rows server-side cannot be checked from this repo.

**Fix:** filter in `kodaHitOf`, and pass `status: "active"` in the search query.

---

## LOW

| ID | Location | Defect · proof | Verified |
|:---|:---|:---|:---|
| L1 | `nax/src/execution/crash-signals.ts:204-219`; `lock.ts:348`; `feature-lock.ts:150` | **carried M14 (lowered).** The fatal-signal path never releases `nax.lock` or the feature lock. A holder with the same PID counts as alive, so a restart reusing the PID (a container as PID 1) is blocked. Traced: `releaseLock` is called only from run-setup, run-setup-init and run-cleanup. | code read |
| L2 | `nax/src/worktree/manager.ts:378-395` | A tracked `.env` makes every worktree creation fail. `git worktree add` checks it out, so `symlinkSync` throws EEXIST and the worktree is removed. Agent repro of the precondition: `ln -s` gives "File exists". | code read |
| L3 | `nax/src/execution/feature-lock.ts:219`, `:250` | The feature-lock reclaim has no `.reclaim` mutex (`lock.ts:184-212` has one). Three racers can leave two holders. Traced. PLAUSIBLE. | agent trace |
| L4 | `nax/src/session/manager.ts:428-429`, `:598-604` | Reopening after an aborted `keepOpen` turn drops the live handle without `adapter.closeSession`, so the old agent process runs until `killAll`. PLAUSIBLE. | code read |
| L5 | `nax/src/agents/acp/turn-loop.ts:254-271` | **carried L1.** On the last allowed turn the loop still asks a human (up to 5 min), then discards the answer. | code read |
| L6 | `nax/src/workflow/ci-wait.ts:286-294`, `:415` | Abort during a CI wait is only noticed after the current poll sleep (default 30s). `sleep` ignores the signal. | agent trace |
| L7 | `nax/src/cli/workflow-promote.ts:118-125` | `promote` binds the CI check to local `HEAD`. A local commit after the push makes the wait time out as `unavailable`. Fails closed. | agent trace |
| L8 | `nax/src/workflow/git.ts:110` | **carried L3.** `listUncommitted` drops every `.nax/` path, so an edited tracked `.nax/config.json` or `prd.json` is not reported dirty. | code read |
| L9 | `nax/src/workflow/finalize.ts:464-469` | **carried L4.** The approval advisor runs with no `costExceeded` check when `plan.base` is empty. | code read |
| L10 | `nax/src/workflow/adjudicate.ts:17-22`; `story-loop.ts:161` | **carried L5.** `adjudicateResidual` swallows an abort, writes default holds and persists `phase: "closed"` before the abort is rethrown. | agent trace |
| L11 | `nax/src/workflow/approval.ts:89-96`, `:118-132` | **carried L6.** A story that never got its review (`unreviewed: true`) does not block readiness. Policy call. | agent trace |
| L12 | `nax/src/finish/pr/open.ts:130`, `:149-168` | **carried L20.** `gh pr view` requests only `isDraft,url`, so a CLOSED non-draft PR is returned as `already-ready` with a dead URL. PLAUSIBLE. | code read |
| L13 | `nax/src/workflow/ci-wait.ts:297-309` | **carried M11 (lowered).** `bindToHead` binds only green polls. A failed poll from the previous head is terminal, which can trigger CI repair on stale failures (GitLab timing). PLAUSIBLE. | code read |
| L14 | `nax-agent/src/tools/grep.ts:116`; Bash gate | **carried L19.** The grep fallback (no ripgrep) has no `--exclude-dir=.git`. Agent repro returned a token-bearing remote URL from `.git/config`. Bash `tee .claude/settings.local.json` is allowed under `Bash(*)`. | agent repro |
| L15 | `nax/src/review/scoped-lint.ts:350-366` | Latent fail-open: the degraded branch returns `success: true` when ESLint reports absolute paths. Agent repro: absolute gives `success: true, out_of_scope`; relative gives `success: false`. Not reachable today (`run-initialization.ts:93` passes no story ref). | code read |
| L16 | `nax/src/quality/runner.ts:240-254` | **carried L15.** The non-timeout drain has no deadline, so a child holding the pipe turns a passing command into `timedOut: true`. Agent repro: `sh -c 'sleep 20 & echo lint-clean'` gives `success: false`. | code read |
| L17 | `nax/src/chat/mentions/mention-expand.ts:38-44`, `:199-202` | `@fifo` hangs the send forever, because the code reads without a regular-file check. Agent repro: still blocked after 8s. | agent repro |
| L18 | `nax/src/chat/background/task-registry.ts:41`, `:261-267` | Each task `output` read loads the whole log (up to 50 MB) to return at most 500 lines. Agent repro: RSS 93 MB rising to a 372 MB peak over 5 calls. | agent repro |
| L19 | `nax/src/tui/chat/useChatKeys.ts:189-194`, `:92-93` | A queued mode or model switch is consumed, then silently dropped, if the close confirmation is open when the turn ends. PLAUSIBLE. | agent trace |
| L20 | `nax/src/interaction/plugins/webhook.ts:500`, `:559` | **carried L17.** The callback HMAC covers only the body. The URL `requestId` is never compared to `body.requestId`, and there is no nonce. PLAUSIBLE. | agent trace |
| L21 | `nax-agent/src/internal/redact.ts:43-122` | The redactor has no `glpat-`, `AIza` or `sk_live_` patterns. Lead re-run: all three pass through unmasked, while `ghs_` and URL credentials are masked. | re-run |
| L22 | `nax/src/prd/index.ts:125-127` | **carried L18.** `"userStories":[null]` throws a native TypeError instead of `PRD_INVALID`. Lead re-run: `TypeError - null is not an object (evaluating 'story.attempts')`. | re-run |
| L23 | `repo-tooling/scripts/release.ts:173-188` | `release tag` tags local HEAD without checking it equals `origin/main`, and `release.yml` publishes from any `v*.*.*` tag. PLAUSIBLE (needs a maintainer slip). | agent trace |
| L24 | `nax/bin/nax.ts:235`; `bin/run-action.ts` | `nax run --no-context` is declared but never read. Lead grep: `options.context` is read only by `generate` (`nax.ts:1413`). | code read |
| L25 | `nax/src/cli/config-display.ts:52,56`; `config-get.ts:50` | **carried L13.** `nax config -d <dir> --diff` reads the cwd's project. | agent trace |
| L26 | `nax-ai/src/credentials/file-store.ts:128-132` | **carried L16.** The credential lock wait totals about 3.6s. Agent repro: a live holder makes a waiter fail at 3651 ms, though the stale window is 10s. | agent repro |
| L27 | `nax/src/config/dotenv.ts:209-213` | `$NAME` is expanded again inside an already-substituted `${X}` value. Lead re-run: `X='$Y'`, `Y=zzz` resolves `"${X}"` to `zzz`. | re-run |
| L28 | `nax-ai/src/protocols/pi-client.ts:349-368` | When tool-call arguments fail to parse, the stream returns before emitting `usage`, so the hop's tokens are lost. PLAUSIBLE. | agent trace |
| L29 | `nax/src/execution/deferred-review.ts:63-64`, `:77-83` | A failed `git diff` (exit code unchecked) gives plugin reviewers `[]`, which looks the same as "no changes". PLAUSIBLE. | agent repro |
| L30 | `nax/src/execution/unified-executor.ts:232`, `:43`, `:256` | A stalled loop is reported as "the derived loop bound was exhausted" (`max-iterations`), which gives the operator the wrong cause. | agent trace |
| L31 | `nax/src/memory/koda-approvals.ts:198-231` | The approvals read-modify-write is serialised per instance only, so two processes (`nax run` and `nax chat`) can lose a record. PLAUSIBLE. | agent trace |
| L32 | `nax/src/review/{typecheck,lint}-parsing/strategies/text-block.ts:4` | ReDoS: `(?:\/[\w./-]+)+` lets `/` match both inside and between segments. Agent repro: 24 segments took 148 ms, about 4x per two segments. | agent repro |
| L33 | `nax/src/context/engine/scope-path-match/index.ts:95-106`, `:122` | Polynomial backtracking with several `**` against a deep path. Lead re-run: k=4 on an 80-segment path took 700 ms. Repo-controlled input. | re-run |
| L34 | `nax/src/prompts/builders/rectifier-builder-helpers.ts:254-256`; `rectifier-builder.ts:137`, `:436` | Gate output is truncated from the head, which drops the failure summary at the tail. `gateOutputTail` already exists. PLAUSIBLE. | agent trace |
| L35 | `nax-agent-acp/src/client/tool-events.ts:42`, `:215-216` | Tool calls past 512 per turn emit no events and no warning, which leaves gaps in the tool-audit ledger. Agent repro: 522 attempted, 512 recorded. | agent repro |
| L36 | `nax/src/agents/retry/default-strategy.ts:33-37` | A `retryAfter` above about 24.8 days overflows `setTimeout` to a 1 ms wait. Lead re-run: 3e9 ms requested, about 4 ms waited. | re-run |
| L37 | Misc nax-agent | Four smaller items:<br>(a) `bounded-io.ts:19`: `Read` on a FIFO hangs and ignores abort (agent repro).<br>(b) `tools/scratchpad.ts:194-199`: `ScratchpadList` checks containment against `ctx.root` instead of the scratchpad dir, which leaks names (not contents) through a scratchpad symlink (agent repro).<br>(c) `native/session/transcript-store.ts:76` and `session-store/storage.ts:175`: transcripts and session metadata are written 0644 (agent repro; the ACP server uses 0600).<br>(d) `session-store/session-lock.ts:90`, `:103`: same-PID lock takeover. The ACP registry has an await between the `entries.get` check and `openEntry`, so two concurrent `session/load` calls can orphan a session. PLAUSIBLE. | agent repro |

---

## Checked and dropped

These came up during the review and were rejected after checking:

- **`nax chat` trust prompt accepts piped stdin.** False positive: `cli/chat.ts:398` refuses a non-TTY stdin before the trust gate runs. The reviewer's repro called `ensureProjectTrusted` directly and skipped that guard.
- **The story `residual` step is not cost-gated.** By design: the `story-graph.ts` header says the cost check runs "never before the first implement turn or the residual adjudication".
- **"Always allow" on `git config` widening.** The repro was inconsistent (`applies: false` on the remembered command), so it is not reported.
- **Also checked and sound:**
  - Terminal escape sanitisation (`styled-line.tsx`), and the `@` mention envelope and traversal checks.
  - Image attachment limits, and bot git argv and token handling.
  - `gh api -f` for untrusted text, and comment-ID validation.
  - Plugin path containment, and the MCP spawn trust gate.
  - The trust store (0600, atomic writes), and profile-name traversal.
  - Bash `..` / `-C` / `cd` containment, and signal-killed exit codes (128+sig).
  - The LLM reply validators, which all fail closed.
  - Symlinked rule files: `Bun.Glob` does not follow them.
  - `forge-tools`, which are read-only with fenced untrusted input.

## Coverage gaps

Read in full or in large part: about 570 of 1,716 non-test source files. The largest unread surfaces are:

- **nax:**
  - `tui/` beyond the chat input, keys and render helpers that were sampled.
  - `cli/` memory-*, advisor*, agents-run-*, gates, generate, context*, plan-command, mcp, routing-calibrate.
  - `precheck/` model-resolution, blockers, catalog-endpoints, story-size-gate.
  - `execution/lifecycle/` beyond setup, cleanup and completion phases; `execution/escalation/`; `runtime/middleware/` (audit, logging, usage-audit, cancellation).
  - `context/engine/` orchestrator, packing and manifest; `context/generator`; most of `prompts/builders`; most of `operations/`.
  - `advisor/`, `routing/`, most of `prd/`, `plan/`, `utils/` and `bot/`; `bakeoff/`, `replay/`, `analyze/`, `log-format/`.
- **nax-agent:** `cost/`, `config/`, `runtime/`, `infra/`; `sandbox/` git-guards and srt-backend; `permissions/` approvals-store and secret-spans; `session/`; `native/` session-adapter and tool batch; `memory/` sync.
- **nax-agent-acp:** the client session-* files, offers and per-agent sandboxes; `server/` errors and capabilities.
- **nax-ai:** most of `providers/*`, plus `retry`, `request-headers`, `tool-args` and `thinking`.

## Priority fix order

| Priority | ID | Effort | Description |
|:---|:---|:---|:---|
| P0 | H1 | S | `lstat`/`readlink` the final component in `resolveWithin`, or write with `O_NOFOLLOW` |
| P0 | H2 | S | Refuse non-permitted OAuth credentials on import and in `toPiCredentialStore` |
| P1 | M1 | S | Extend Bash `WRAPPERS`, and `ask` on an unknown head when deny or ask rules exist |
| P1 | M2 | S | Apply `GIT_ESCAPE_FLAGS` to the Bash `git` verb |
| P1 | M3 | S | Refuse gated Bash when the sandbox policy cannot be built |
| P1 | M7 | S | Forward only `authEnv` plus essentials to ACP agents |
| P1 | M8 | S | Check the real path with `git check-ignore` in mentions |
| P1 | M4, M5, M6 | S | Hooks off in GitCommit; npm/pnpm/yarn runners as wrappers; decode wrapped commands for all agents |
| P2 | M9, M10 | S | Cost ledger: write from a copy; carry spend on a failed `complete()` |
| P2 | M11, M18 | S | PRD sanitizer only on parse failure; never overwrite an unparseable manifest |
| P2 | M12, M13, M14, M23 | M | Memory forget and approvals: fail closed, filter retired rows |
| P2 | M15, M16, M17 | S | Vitest `test{}` block; expand brace globs; full suite on cap |
| P2 | M19, M20, M21, M22 | S-M | Shared config validation; reserved-name list; KILL pass by `startedAt`; protected branch in auto-PR |
| P3 | L1-L37 | S | Work through as a batch; the carried items have been open since 10-24 |
