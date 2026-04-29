# Operator guide — running opencode against the ADR-019 test migration

**Date:** 2026-04-29
**Companion to:** [legacy-run-test-migration-playbook.md](./2026-04-29-legacy-run-test-migration-playbook.md)
**Audience:** the human (you) running opencode on a remote machine, not the agent itself.

The playbook is self-contained for the agent. This document covers the surrounding mechanics: how to launch opencode, what to verify before and after, and how to land the result.

---

## Prerequisites

On the machine you'll run opencode on:

- `bun` 1.3.7+ on PATH.
- `git` configured with commit identity (the agent will run `git commit`).
- `opencode` installed and configured with a cheap model (Haiku-class, DeepSeek, GPT-4o-mini, etc.). The exact model is your choice — anything that can call shell tools and read files reliably.
- A clone of `nax` with the foundation PR merged to `main` (or with the foundation branch checked out).
- Network access disabled or restricted (the agent should not need it; this is a defensive measure).

---

## Step 1 — verify the foundation is in place

```bash
cd /path/to/nax
git fetch origin
git checkout main
git pull
test -f test/helpers/runtime.ts && grep -q makeMockRuntime test/helpers/runtime.ts && echo "foundation present"
test -f scripts/adr-019-source-cleanup.patch && echo "cleanup patch present"
test -f docs/findings/2026-04-29-legacy-run-test-migration-playbook.md && echo "playbook present"
```

All three should print "present". If not, the foundation PR is not merged yet — stop and merge it first.

---

## Step 2 — sanity-check the patch applies cleanly

```bash
git apply --check scripts/adr-019-source-cleanup.patch && echo "patch OK"
```

If this fails, `main` has drifted from when the patch was generated. Stop and ask a human to regenerate the patch.

---

## Step 3 — launch opencode

The agent prompt is the fenced block in the playbook's "Agent Prompt" section. Two ways to feed it:

### Option A — single-shot run (preferred)

```bash
# Extract the prompt (works because the playbook puts it inside a single fence
# in the "## Agent Prompt" section).
prompt=$(awk '/^```$/{f=!f; next} f && /^You are migrating/,/^```$/{print}' \
  docs/findings/2026-04-29-legacy-run-test-migration-playbook.md \
  | sed '$d')

opencode run "$prompt"
```

### Option B — interactive

```bash
opencode
# In the REPL:
> Read docs/findings/2026-04-29-legacy-run-test-migration-playbook.md and
> follow the "Agent Prompt" section verbatim. Begin with the Bootstrap
> section. Start now.
```

Recommended: Option A. Less drift from the prompt, no interactive turn-taking the cheap model can lose track of.

### Model choice

Configure in your `opencode.json` or via the `--model` flag if your build supports it. Suggestions:

- `anthropic/claude-haiku-4-5-20251001` — cheapest Anthropic model that handles structured edits well.
- `deepseek/deepseek-chat` — cheaper still, good at mechanical tasks.
- `openai/gpt-4o-mini` — comparable.

Avoid anything below the Haiku tier (e.g. Llama 3.1 8B); the playbook's two-pattern decision rule is simple but wrong choice → quarantine, and a sub-Haiku model quarantines too aggressively.

---

## Step 4 — supervise loosely

The agent will:

1. Create branch `chore/adr-019-test-migration-batch`.
2. Apply the patch.
3. Process 7 files one by one. Each successful migration is a separate commit.
4. Maintain `migration-progress.md` and (if needed) `quarantine.md`.
5. Stop when done. Will NOT push, will NOT open a PR.

Expected wall time: 30–90 minutes depending on the model. You can leave it unattended.

If the process stalls for more than 15 minutes on a single file, consider Ctrl+C — it's likely looping on a tricky migration. Restart from the same branch; the agent should pick up at the next unticked file in `migration-progress.md`.

---

## Step 5 — review the agent's work

When the agent stops:

```bash
cd /path/to/nax
git log main..chore/adr-019-test-migration-batch --oneline
cat migration-progress.md
test -f quarantine.md && cat quarantine.md
git diff main..HEAD --stat
```

Sanity checks:

- [ ] All commits touch only `test/unit/**/*.test.ts`, `migration-progress.md`, and `quarantine.md`.
- [ ] No commits touch `src/`, `docs/`, `package.json`, or other non-test files.
- [ ] No `git push` happened (`git log origin/main..HEAD` shows the unpushed commits).
- [ ] `migration-progress.md`'s final suite result matches what the agent claims.

Then run yourself:

```bash
bun run typecheck
bun run lint
bun run test
```

If `bun run test` is green: proceed to Step 6.
If red: review `quarantine.md` and the failing files. Fix manually or re-launch opencode with a narrower scope ("retry only quarantined files").

---

## Step 6 — push and open the migration PR

```bash
git push -u origin chore/adr-019-test-migration-batch
gh pr create \
  --base main \
  --title "test: migrate review/autofix tests to runtime path (ADR-019)" \
  --body "$(cat <<'EOF'
## Summary

Migrates the seven test files that exercised the legacy `agentManager.run({ keepOpen: true })` path so they now flow through the ADR-019 runtime/`callOp` dispatch path. Unblocks the source-cleanup PR that drops the legacy fallback.

Generated by opencode following docs/findings/2026-04-29-legacy-run-test-migration-playbook.md.

## Files migrated

See migration-progress.md for the per-file outcome.

## Test plan

- [x] bun run typecheck clean
- [x] bun run lint clean
- [x] bun run test green (full suite)
- [x] Each migrated test file passes both with and without the source-cleanup patch applied

## Follow-up

After this PR merges, a small cleanup PR drops the legacy code path:
- src/review/semantic.ts
- src/review/adversarial.ts
- src/pipeline/stages/autofix-agent.ts
- src/pipeline/stages/autofix-adversarial.ts
EOF
)"
```

---

## Step 7 — after the migration PR merges

Land the source cleanup. The patch lives at `scripts/adr-019-source-cleanup.patch` (delete it as part of this PR; it has served its purpose).

```bash
git checkout main && git pull
git checkout -b refactor/adr-019-source-cleanup
git apply scripts/adr-019-source-cleanup.patch
git rm scripts/adr-019-source-cleanup.patch docs/findings/2026-04-29-legacy-run-test-migration-playbook.md docs/findings/2026-04-29-opencode-invocation.md migration-progress.md
test -f quarantine.md && git rm quarantine.md
bun run typecheck && bun run lint && bun run test  # should all be green
git add -A
git commit -m "refactor: drop legacy agentManager.run keepOpen path (ADR-019 Wave 3, #762)"
git push -u origin refactor/adr-019-source-cleanup
gh pr create --base main --title "refactor: drop legacy agentManager.run path (ADR-019, #762)" --body "..."
```

This third PR is mechanical and should pass CI on the first try. Done.

---

## Troubleshooting

### "patch OK" but the agent reports apply failure

Likely a CRLF / line-ending issue if you're on Windows. Run:

```bash
git config --global core.autocrlf false
git checkout chore/adr-019-test-migration-batch
git apply --3way scripts/adr-019-source-cleanup.patch
```

### Agent edits files outside the allowed list

Stop the agent. Reset:

```bash
git checkout chore/adr-019-test-migration-batch
git reset --hard main
git apply scripts/adr-019-source-cleanup.patch
```

Re-launch with a stronger constraint: prepend to the prompt: "If you ever feel inclined to edit a file outside test/unit/, write to quarantine.md instead and move on."

### Agent gets every file wrong

Either the model is too weak or the playbook is wrong for the codebase state. Check:
- Is `main` actually at the foundation PR head? (`git log --oneline -3`)
- Is `makeMockRuntime` actually exported? (`grep makeMockRuntime test/helpers/index.ts`)
- Do the reference test files (`semantic-parsing.test.ts`, `autofix-routing.test.ts`) pass? (`bun test test/unit/review/semantic-parsing.test.ts`)

If all three are green, the model is the issue. Switch to a stronger one (Sonnet-class) and re-run. The cost difference for ~7 files is small.
