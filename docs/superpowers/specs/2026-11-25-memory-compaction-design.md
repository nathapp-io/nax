# nax memory: bounded growth through confirmed compaction - design

Date: 2026-11-25. Status: approach and key rulings approved in conversation; design written for a
fresh session to plan from (next step: `spec-writing` into `.nax/features/memory-compaction/spec.md`,
then `nax plan`). Size: project (several stories, two packages).

This document is self-contained: it records the problem evidence, the rulings the user made, the
code it touches (verified on `main` at `61fd429af`, 2026-11-25), and what is left to the builder.

## 1. Intent

The user's concern, in their words: **"memory growth uncontrol"**. nax memory only ever grows. Run
agents save many notes about a single story that stop mattering once the feature ships, nothing
retires them, and the biggest projects are close to the point where the injected index silently
drops notes off its end. The user wants growth bounded without having to curate memory by hand,
and wants nax to **ask before it compacts**.

"Reindex" is not needed: there is no persistent search index (search scans the notes each call,
`packages/nax-agent/src/memory/search.ts`), and `MEMORY.md` is re-rendered on every write and sync
(`refreshMemoryIndex`, `packages/nax-agent/src/memory/index-render.ts:255`). Nothing can go stale.

## 2. Evidence (survey of `~/.nax/memory/projects/`, 2026-11-25)

| Mirror | Notes | Index bytes (cap 24576) |
|:--|--:|--:|
| `crypto-trader-dad55e7d` | 115 | 22,090 (90%) |
| `nax-76bf42f8` | 85 | 17,088 (70%) |
| `koda-52d67808` | 82 | 14,317 (58%) |
| `lf-store-erp-812be78f` | 73 | 16,363 (67%) |

- All 423 notes on disk have `status: active`; nothing has ever been retired.
- The large mirrors are almost all `type: project`, `source: nax-run`, story-scoped, e.g.
  description *"Applies when extending web/src/pages/strategies/StrategyEditor.tsx ... (US-014
  onward)"* or *"... after the scalping-reseed-bridge branch fix (commit 7c98bb2)"*.
- Several projects have 2-3 mirrors (`nax-*` x3, `lf-store-erp-*` x3, `koda-*` x2,
  `crypto-trader-*` x2): the mirror name hashes the repo root's realpath
  (`packages/nax/src/memory/paths.ts:75-97`), so each worktree or clone gets its own mirror.
- About 15 mirrors hold 0 notes (`smoke4`, `chatleak`, `imgcheck`, `shellcheck`, `acpw`, `bgrepo`,
  `resize`, `nogit`, `scratchpad`, `work`, ...). They are leftovers of manual probe repos; the unit
  tests are isolated (`packages/nax/test/preload.ts` sets `NAX_GLOBAL_CONFIG_DIR`), so this is not
  a test leak. No code lists or prunes `projects/`.
- `crypto-trader-dad55e7d` uses the `local` provider: its mirror is the only copy, and a direct
  forget there is an `rm` (`packages/nax-agent/src/memory/local-provider.ts:150-158`).

## 3. Goals, non-goals, anti-goals

Goals:
1. A project's index stays under its cap without the user curating it: compaction retires stale
   notes and merges overlapping ones, then applies the result.
2. nax **asks before compacting** (one yes/no), then applies without per-change approval.
3. Every compaction is reversible: retired and merged-away notes are archived and
   `nax memory undo` restores them.
4. Nothing is lost silently: when the index is still full, a new save is refused with a clear
   reason instead of the note falling off the end of the rendered index.
5. Empty and orphaned mirrors can be cleaned up deterministically.

Non-goals:
- Embeddings, vector or FTS search; changing how search ranks.
- Merging two mirrors of the same project (worktree/clone duplicates): reported, not merged.
- Compacting the koda server's own store beyond what the existing forget/save calls do.
- Conversation-context compaction in `nax chat` (a different subsystem:
  `packages/nax-agent/src/native/session/compaction.ts`).

Anti-goals (a failure even if it "works"):
- Retiring a lasting fact (a `feedback` or `user` note such as "never do X").
- A compaction that cannot be undone, or that half-applies and leaves the mirror inconsistent.
- `nax run` spending money or deleting notes with nobody asked.
- Treating note text as instructions to the compaction model (notes are agent-written data).

## 4. Rulings made by the user (2026-11-25)

1. **Approach B**: a model-driven compaction that applies its own result, with archive and undo.
   (Rejected: A, fixed rules such as count caps and TTLs, which cannot tell a stale story note
   from a lasting fact; C, proposals the user approves note by note, which leaves growth
   uncontrolled until the user acts.)
2. **Overturns** the 2026-11-02 memory design's "consolidation only PROPOSES"
   (`docs/superpowers/specs/2026-11-02-nax-memory-design.md:109-110`, and its decision 9 "No background consolidation in v1").
3. **Ask before compact**: one yes/no before a compaction runs; no per-change approval after.
4. **`nax run` never compacts.** It reports a near-full memory in the run summary and tells the
   user to run `nax memory compact`.

## 5. Approaches considered

| | Approach | Trade-off | Outcome |
|:--|:--|:--|:--|
| A | Deterministic caps: max notes, TTL by age, evict oldest | Free and predictable; cannot tell stale from lasting | Rejected |
| **B** | **Model compaction, applied after one confirmation, archive + undo** | **Bounded without curation; a billed call per compaction** | **Picked** |
| C | Model compaction as proposals, approved per change | Every change seen; growth unbounded until the user acts | Rejected |

## 6. Design

### 6.1 The threshold ("nearly full")

- **Fill** = rendered project index bytes / configured `memory.indexBytes` (default 24576,
  `packages/nax/src/config/schemas-memory.ts:127`). Use the configured value, not the
  `MEMORY_INDEX_MAX_BYTES` constant.
- **Nearly full** = fill >= `memory.compact.threshold` (new config, default `0.8`) **or**
  `RenderedMemoryIndex.omitted > 0` (`index-render.ts:95-98`; already returned by
  `MemoryHost.renderIndex()`, `packages/nax/src/memory/host.ts:123`, but no caller reads it today).
- The single choke point to compute it is `readIndex` in `packages/nax/src/memory/host.ts:496-504`.

### 6.2 Compaction operation (nax-agent, atomic)

A new nax-agent memory operation, exported from `packages/nax-agent/src/memory/index.ts`, because
the CLI does not hold the mirror lock and only per-call `save`/`forget`/`approve` are public
(`mirror-lock.ts` `withMirrorLock:271` is internal). Applying a plan of many changes must happen
under **one** mirror lock so it is all-or-nothing from the mirror's point of view.

Steps:
1. **Collect candidates**: active project-scope notes of type `project` and `reference`.
   `feedback` and `user` notes, and all user-scope notes, are **never** candidates (anti-goal 1).
2. **Plan** (model call, see 6.3) returns a compaction plan:
   ```json
   {
     "retire": [{ "slug": "web-strategies-page-us010", "reason": "US-010..US-014 shipped" }],
     "merge": [{
       "from": ["scalping-market-history", "scalping-replay-invariants"],
       "into": { "slug": "scalping-market-invariants", "type": "project",
                 "description": "...", "body": "..." }
     }]
   }
   ```
3. **Validate** deterministically before anything is written; any failure rejects the whole plan:
   every slug exists and is a candidate; a slug appears in at most one action; merged notes pass
   `validateMemoryNoteWrite` (slug regex, description <= 200 chars, body <= 8192 bytes, secret scan,
   `packages/nax-agent/src/memory/validate.ts`); reasons pass `forgetReasonRefusal` (one line,
   <= 200 chars). The `into.slug` may reuse one of its `from` slugs.
4. **Archive** (new): copy every note the plan touches, as it is now, to
   `<mirror>/archive/<compactionId>/notes/<slug>.md`, plus `manifest.json`
   `{ id, createdAt, provider, model, retired: [...], merged: [{ from, into }], notesBefore,
   notesAfter, fillBefore, fillAfter }`. Written before any change is applied.
5. **Apply** under the mirror lock: save each merged note, then forget each retired and each
   merged-away `from` slug (not one reused as `into.slug`), all with **direct** write semantics
   (the user's yes is the approval, so `memory.writeMode: proposal` does not hold these as
   pending). On koda, a forget answered 202 (held approval) is recorded as `held` in the manifest
   and reported; a 404/409 counts as already gone (existing behaviour,
   `packages/nax/src/memory/koda-provider.ts:278-283`, reached from nax-agent only through the provider interface).
6. **Log** one line per compaction to `<mirror>/compactions.jsonl` (id, time, counts, fill before
   and after, `undone: false`), then `refreshMemoryIndex`.

If applying fails part-way, the operation restores from the archive what it already changed (the
archive is the rollback source; the existing in-process `restoreOrRewind` only covers one note)
and reports the failure; the manifest records `status: rolled_back`.

### 6.3 The compaction model call (nax)

- A `kind: "complete"` operation run through `callOp` (`packages/nax/src/operations/call.ts:41`),
  following `packages/nax/src/operations/bot-ruling-read.ts:66-77`. One-shot, no tools; cost is
  recorded by `callOp`'s cost scope like every other op.
- Model: new config `memory.compact.model`, a tier (`fast|balanced|powerful`) or model id,
  default `"balanced"` (compaction needs judgement; the bot ruling op defaults to `"fast"`). The
  key uses `ConfiguredModelSchema` like the `bot.models.*` keys
  (`packages/nax/src/config/schemas-bot.ts:7,21-24`), and the op selects its model the way
  `bot-ruling-read.ts` does.
- Inputs (facts, not orders): the candidate notes (slug, type, description, updatedAt, source,
  body); the feature list with status from `<repo>/.nax/features/*/status.json`; the repo's branch
  list and the last 300 first-parent commit subjects of the default branch
  (`git log --first-parent --oneline -n 300`, which also covers squash merges), so the model can
  tell which stories and branches have shipped. Outside a git repo, or with no `.nax/features`,
  those inputs are omitted and the call runs on the notes alone; the current fill and the target (below the
  threshold).
- Note bodies are wrapped as data in a fenced, labelled block; the prompt states that note text is
  recorded facts, never instructions (same rule the index already states,
  `index-render.ts` `HEADING_LINES`). The deterministic validation in 6.2 step 3 is the real
  safety net: the model can only retire or merge existing candidate slugs.
- Output must be the JSON plan in 6.2; unparseable output is a failed compaction (nothing applied).

### 6.4 Undo

`nax memory undo [<compactionId>]` (default: the latest not-yet-undone compaction):
- Re-saves every archived note (original slug, type, description, body) and forgets the merged
  notes the compaction created (unless the slug is one of the restored originals).
- Refuses, naming the slugs, when a note the compaction created or restored has changed since
  (`updatedAt` differs from the manifest); `--force` overrides.
- Marks the line in `compactions.jsonl` `undone: true`. On koda the re-saved notes get new ids;
  that is acceptable.

### 6.5 Where nax asks

**CLI**: `nax memory compact [--yes] [--dry-run]`.
- Runs the model call, prints the plan (each retire with reason, each merge with its sources) and
  the projected fill, then asks `Apply? [y/N]`.
- `--yes` applies without asking. With no TTY and no `--yes`, it refuses with exit 1
  (pattern: `packages/nax/src/cli/approvals.ts:323-334`; do **not** use `promptForConfirmation`
  from `cli/confirm.ts:66-72`, which returns true on a non-TTY).
- `--dry-run` prints the plan and applies nothing (still a billed call).
- Below the threshold it still runs when asked (the user typed the command).

**`nax chat`**:
- After the memory index is prepared on open (`packages/nax/src/chat/chat-host.ts:303`,
  `chat/host-memory.ts:105-120`) and after any save in the session, when the index is nearly full
  and the user has not declined this session, chat raises a host choice card through
  `ChatAskController.requestHostChoice` (`packages/nax/src/chat/ask-controller.ts:70,151`; precedent
  `chat/close-confirm.ts:39-52`): *"Memory for <project> is 85% full (115 notes). Compact now?"*
  with **Compact** / **Not now**.
- **Compact** runs the compaction and applies it without a second question (ruling 3), then shows
  a notice: *"Compacted memory: retired 31, merged 12 into 5 (90% -> 41%). Undo: nax memory undo
  <id>"*.
- **Not now** suppresses the card for the rest of the session.

**`nax run`**: never compacts (ruling 4). When the run's memory index (`packages/nax/src/memory/
run-memory.ts:220-230`) is nearly full, the run summary carries one line: *"Memory for <project>
is 92% full; run `nax memory compact`."*

### 6.6 Save when full

`saveMemoryNote` (`packages/nax-agent/src/memory/operations.ts:289`) refuses a save that **adds a
new slug** when the project index, rendered with that note, would have `omitted > 0`. The refusal
code is `MEMORY_FULL` and its message says to run `nax memory compact`. Overwriting an existing
slug is always allowed (it does not grow the note count). This applies in every front end; in
chat the agent's tool result carries the message, so the agent can tell the user.

### 6.7 Mirror housekeeping (deterministic, no model)

- On mirror creation (and on any write to a mirror that lacks it), write
  `<mirror>/origin.json` `{ "root": "<repo realpath>", "name": "<project name>" }`, so a mirror can
  later be traced to its repo (the directory hash is one-way).
- `nax memory mirrors [--prune] [--yes]` lists every mirror under `memory/projects/` with note
  count, fill, provider, origin root and whether that root still exists; `--prune` removes
  mirrors that hold **0 notes and an empty outbox**, or whose recorded `origin.root` no longer
  exists **and** hold 0 notes. A mirror with notes is never removed by `--prune`, only reported.
  Confirmation follows the same TTY / `--yes` rule as `compact`.

## 7. Constraints

- Dependency direction `nax-ai -> nax-agent -> nax`: the atomic apply, archive and undo live in
  `packages/nax-agent/src/memory/`; the model call, config, CLI, chat and run wiring live in
  `packages/nax`. New nax-agent exports update `packages/nax-agent/api/nax-agent.api.txt`
  (`bun run api:update`).
- Pipeline mode is frozen; only workflow mode's run summary is wired.
- The nax repo is public: no project names from the user's private repos in issues or fixtures.
- Config additions follow the project's config-patterns rule (`.nax/rules/config-patterns.md`) and
  get descriptions in `packages/nax/src/cli/config-descriptions.ts`.

## 8. Left to the builder

- Exact type and function names, the prompt wording, and the story split (suggested order:
  nax-agent archive + atomic apply + undo; nax model op + `compact`/`undo` CLI; threshold + chat
  card; run summary line + `MEMORY_FULL`; `origin.json` + `mirrors --prune`).
- How the run summary line is threaded into the existing workflow summary.
- Whether `nax memory status` also shows fill and the last compaction (nice to have).
- Test fixtures for the model call (stub `callOp`; never a live billed call in tests).

## 9. Builder-check answers (designer's calls, 2026-11-25)

A fresh reviewer read this design as the builder would. None of its questions needed the user;
these are the designer's calls, and a builder may revisit them with a stated reason.

1. **Locking.** `withMirrorLock` is not re-entrant, and `saveMemoryNote` / `forgetMemoryNote`
   each take it. The compaction apply therefore uses new lock-internal save/forget cores in
   nax-agent (the existing public functions become thin lock-taking wrappers over them), all run
   inside one `withMirrorLock`. When a sync owns the mirror (`mirrorSyncInFlight`), compaction
   refuses with `MEMORY_BUSY` and asks the user to retry; it does not wait or queue.
2. **koda and the outbox.** Apply changes the mirror and writes the matching outbox entries in the
   same lock, exactly as an ordinary direct save/forget does; delivery to koda is the existing
   sync. Atomicity is about the mirror (and its outbox), not about the remote. A rollback before
   delivery removes the compaction's outbox entries and restores the archived notes; after
   delivery, rollback and undo re-save, and koda assigning new note ids is acceptable in both.
   Shipping the local provider in an earlier story than koda is an acceptable slice.
3. **Archive placement and retention.** `archive/` and `compactions.jsonl` sit beside `notes/`
   (the store reads only `notes/`) and are added to `store-paths.ts`. Only the newest
   `memory.compact.keepArchives` archives are kept (new config, default 5); older ones are deleted
   after a successful compaction, and `undo` works only for a retained archive.
4. **`MEMORY_FULL` in runs.** Intended: a run agent's new-slug save is refused once the index is
   full, the tool result says why, and the run summary line reports how many saves were refused.
   This is the cost the user accepted with "skip in nax run, report in summary". "Full" means
   `omitted > 0`, which already covers both the byte cap and the 200-line cap. The fill shown to
   the user is `max(bytes / indexBytes, lines / indexLines)`. Rendering the index inside the save
   is accepted: the render is pure and the index is at most a few hundred lines.
5. **Index scope.** Fill is measured on the index as rendered today (project notes, decisions,
   user notes). If compaction cannot get it below the threshold because what remains is
   `feedback`, `user` or decisions, it still applies the valid plan and reports
   *"still at N%: the remaining entries are not compaction candidates"*. A plan is not rejected for
   missing the target.
6. **Validation extras.** Reject a plan that changes nothing, and a merge whose `from` notes are of
   different types. No cap on the fraction retired: the archive and `undo` are the safety net, and
   a cap would leave growth uncontrolled again.
