# nax v0.94.2: verified code review

**Reviewed commit:** `5a112f0a2f26b6a92da4d423696d87dbb3e90d22`. This report records the revised findings from a risk-based review of the six-package monorepo. Paths and line numbers below are relative to `packages/` at that commit.

**Fix first:** run-level `PAUSE`, log identity, GitHub CI head binding, and worktree ID collisions. The first three can give an operator a wrong result: work continues after a pause, a run displays another run’s log, or a green verdict belongs to a different commit. The fourth can discard a live contestant worktree’s uncommitted work. For memory, start with session event retention and image reads during transcript bookkeeping. Both have measurable regression criteria.

## Correctness and reliability

### 1. A run can continue after the operator requests `PAUSE` — High

The TUI writes the queue at the run root, but a package story checks its package directory. A temporary-project probe returned `continue` and left the root `PAUSE` pending. A root-story control consumed the same command and returned `pause`. Even when consumed, the executor pauses the selected story, not the run, and can dispatch another independent story. The promised behavior is to pause **after the current story**, not to cancel it mid-execution.

**Fix and regression:** Read the queue at the run root and propagate a run-level stop before the next dispatch. Test two independent package stories and assert the second never starts after a pause request. Moving the queue read to the run root is not sufficient on its own: a consumed root `PAUSE` already marks only the selected story paused, and the dispatcher still selects the next independent story. `ABORT`, which marks every pending story skipped, is a model for the run-level stop.

**Scope note:** pipeline mode has been removed, but this path is live. `queueCheckStage` is the first stage of workflow mode’s per-story stage list (`getWorkflowPipeline()`).

**Source:** `nax/bin/run-action-execute.ts:39–46`; `nax/src/pipeline/stages/queue-check.ts:98–119`; `nax/src/pipeline/stages/index.ts:38`; `nax/src/execution/pipeline-result-handler.ts:324–349`; `nax/src/execution/iteration-runner.ts:132–145`; `nax/src/execution/unified-executor-dispatch-phases.ts:193–233`.

### 2. A registry ID selects the wrong log — Medium; confirmed for every ordinary `nax run`

The CLI uses a seconds-only timestamp for the log filename but does not pass that ID to the runner, which generates a different registry ID (`run-<hash>-<iso-with-ms>`). The reader looks for `<registryId>.jsonl`, which never exists for an ordinary run, so it always falls back to the newest file in the feature’s runs directory. The defect is not limited to the case where a newer run exists: every `logs --run <id>` for an ordinary run returns the newest log, which is correct only when the requested run happens to be the newest. In a temporary registry, adding a newer timestamped file changed which log `logs --run` selected for the **same old ID**. An exact-name file restored the correct selection. Replay instead looks for an exact filename, finds none, and renders a timeline with no log phases. `nax resume` uses one ID for both and is unaffected.

**Adjacent defect:** with no run query, replay discovery picks the “latest” run by lexicographic comparison of run IDs. Those IDs start with the workdir hash, so across workdirs an older run can be chosen over a newer one (a probe chose a 2026-11-01 run over a 2026-11-28 run).

**Fix and regression:** Generate the ID once and record the actual log path. With two runs for one feature, looking up the older ID must return its log or explicitly report it missing, never substitute the newer file. Remove the `files[0]` fallback on an exact-ID miss. For discovery, order by run start time, not by ID string.

**Source:** `nax/bin/run-action.ts:484–500`; `nax/bin/run-action-execute.ts:163–183`; `nax/src/execution/runner.ts:186–189`; `nax/src/commands/logs-reader.ts:77–88`; `nax/src/commands/replay.ts:54–56`; `nax/src/replay/discovery.ts:77,97`.

### 3. GitHub CI can return green for a known wrong commit — Medium; confirmed on the wait path

With expected head **B**, `waitForChecks` rejected passing checks explicitly attributed to **A**. But when both head-only reads returned **A** and the intervening mergeability response omitted its SHA, or the mergeability call failed, the same wait returned **green**. The code recovered a SHA and then discarded it. This differs from the intentional behavior when the head cannot be determined at all. The one-shot checker has an additional head lookup and correctly returned `unavailable`. The wait path feeds `workflow finalize` and `workflow promote`, which can mark a PR ready.

**Fix and regression:** Attach the recovered SHA to green polls as well as failed polls (the `poll.state === "failed"` condition in `ci-wait-head-bind.ts` should also accept `"green"`). Test missing inline SHA with two matching fallback reads for the wrong head; it must not produce green for the expected head.

**Source:** `nax/src/workflow/ci-wait-head-bind.ts:54–69`; `nax/src/workflow/ci-wait.ts:200,302–310,565–571`; callers `nax/src/workflow/finalize.ts:439`, `nax/src/cli/workflow-promote.ts:181`.

### 4. Two worktree names can collide — Medium-High; data loss reproduced

The short `(feature, story)` pairs `("billing-api", "retry-1")` and `("billing", "api-retry-1")` produce the same ID. The same ambiguity exists within the bakeoff namespace; the two namespaces do not collide with each other. Ordinary stories run in the checkout. The active creation risk is overlapping `--compare` invocations in the same checkout: contestants run serially within one invocation, but worktree creation precedes the contestant run locks, and the `--compare` path never takes the checkout or feature lock. Two identical `--compare` invocations collide by construction, so tuple ambiguity is not required.

Creation removes any existing worktree at the derived path (`git worktree remove --force`, then `branch -D`) without an ownership check; an existing unit test asserts this. On a temporary repository, a second `create` with a colliding ID deleted the first run’s uncommitted file, replaced its worktree, and recreated the branch at the second run’s tip, leaving the first run’s commit on no branch. Cleanup in the contestant `finally` also acts on the derived ID and can remove the other run’s live worktree.

**Fix and regression:** Encode the tuple boundary or include a digest of the original tuple for short IDs. Verify ownership before removing a live worktree, including an existing worktree created under the old naming scheme. Also take the checkout or feature lock on the `--compare` path before creating worktrees, which removes the overlap entirely. Test two concurrent creates with one ID and assert the first worktree’s files and commits survive.

**Source:** `nax/src/worktree/worktree-id.ts:49–85`; `nax/src/bakeoff/contestant.ts:147–156,181–186`; `nax/src/worktree/manager.ts:301–363,440–456`; `nax/bin/nax.ts:410–412`; `nax/src/execution/lifecycle/run-setup.ts:465–491`.

### 5. An interrupted MCP write can be delivered twice — Medium; server-dependent

The pool resends a call once if it rejected on a connection that reported a close. It does not resend every timeout or tool error. A non-idempotent server may have committed the first write before its reply was lost. A fake server that committed `add` and then exited before replying received two dispatches, and the caller saw success. Separately, memory sync can retry later, and this is probably the more common trigger: an `add` that exceeds the 10 s operation timeout, or returns a tool error, is classified as failed and stays queued, so the next sync resends it even without a connection close. The outbox has a stable client ID, but MCP add sends only text and never sends that ID. If two notes are created, nax may know only the second ID when asked to forget. Memory defaults to local; a remote that deduplicates need not create a duplicate.

**Fix and regression:** Retry writes only with an explicit retry-safe contract or a server-supported idempotency key. Otherwise report an unknown outcome. Test a fake server that commits before losing its reply, including the later outbox-sync path and a slow add that commits after the timeout. A cheap mitigation is to include the outbox client ID in the stored note so a later sync can detect an existing note before re-adding.

**Source:** `nax/src/mcp/pool.ts:464–488`; `nax/src/memory/mcp-provider.ts:137–146`; `nax-agent/src/memory/sync-drain.ts:65–76,94–103`; `nax/src/memory/mcp-id-map.ts:237–243`.

### 6. OpenRouter routing mismatch — withdrawn for the native CLI; Low for custom SDK integrations

The native CLI passes the same overrides to both catalogs, and the installed provider adapter maps routing restrictions onto the request. The remaining issue is narrower: an SDK embedder supplying separately built protocol entries can pass validation with matching model IDs but different routing settings. This is **not evidence of a CLI privacy incident**.

**Fix and regression:** For separately supplied catalogs, compare fields that affect outgoing requests while permitting pricing-only differences. Assert the outgoing routing settings in an offline request-construction test.

**Source:** `nax-agent/src/native/client.ts:74–104`; `nax-ai/src/protocols/override-declaration.ts:95–116`; `nax-ai/src/protocols/pi-client.ts:901–913`.

### 7. A pending ACP output write can stall ordinary session close — Medium

With the installed SDK and a held output write, a notification remained pending after connection close and resolved only when the write was released. Ordinary session close waits for event delivery with no bound, delaying ownership release: in a probe, `close()` was still pending 1.5 s after it was called and resolved only when the write was released. This does not apply to a rejected write, which is handled. Server-wide shutdown also differs: it bounds its wait to five seconds by default and defers cleanup.

**Fix and regression:** Make delivery interruptible while preserving final accounting and lock ownership until it is safe to release. A simpler option reuses the shutdown pattern: bound the close wait with the existing timed wait, and defer cleanup and lock release until the write settles. Test a write that remains pending, not only one that rejects.

**Source:** `nax-agent-acp/src/server/server-session.ts:101–133,346–371`; `nax-agent-acp/src/server/registry-lifecycle.ts:31–73`.

### 8. Code-neighbor resolution can return nonexistent paths — Low; not the default workflow path

On a real fixture, the pull-tool handler returned `Button.ts` for `Button.tsx`, `x.js.ts` for `x.js`, and `lib.ts` for `lib/index.ts`. An ordinary `.ts` control resolved in both directions. The resolver accepts the first candidate inside the repository without checking existence. The same defect breaks reverse lookup: because importers resolve to the wrong path, `Button.tsx` does not list `App.ts` (which imports `./Button`) as a neighbor, and `x.js` does not list its importer.

**Exposure:** pipeline mode has been removed. In workflow mode, the provider is reached only when `context.v2.enabled` is `true` and rules delivery is `push` (or through the pull tool). Both are off by default, so severity stays Low.

**Fix and regression:** Match candidates against real files before emitting a neighbor. Cover explicit extensions, `.tsx`, directory imports, and forward and reverse links. Reverse matching must use the same existence-checked resolver.

**Source:** `nax/src/context/engine/providers/code-neighbor-phases.ts:70–79,129–135`; `nax/src/context/engine/providers/code-neighbor-phases.ts:177–190`; `nax/src/pipeline/stages/workflow-context.ts:101–117`.

## Memory and performance

### 9. A backlogged session retains already-delivered events — Low-Medium; not a session-lifetime leak

Under Node, with valid events, the production control cap, and only two events pending, **10,002 event objects survived forced GC; zero survived after drain**. The stall callback never fired. Dequeue advances an index but leaves references in the array until it empties. A waiting consumer bypasses the queue, and compatible deltas merge: with same-type text deltas only 2 of 10,000 events stayed alive, but with alternating types (for example, interleaved text and thinking) 9,999 of 10,000 did. The problem is a sustained backlog within a turn, not permanent retention after it. The comment on `compact()` (“Drop the consumed prefix”) is inaccurate, because nothing is dropped until the buffer fully drains.

**Fix and regression:** Clear each consumed slot and periodically compact the array, or use a ring buffer. Under a fixed backlog, retained references should follow pending events rather than total events delivered.

**Source:** `nax-agent/src/session/session-event-channel.ts:84–122,138–164`.

### 10. Turn markers reread historical image sidecars — Medium for file-backed image histories

Two references to the same stored image caused **four sidecar reads for `running` and four for `ended`**, excluding normal turn processing. Each marker rehydrates the file-backed transcript, then republishes its stored representation. Text-only file history and image-bearing in-memory history both produced zero sidecar reads. Two distinct images produced the same count: the cost is two reads per image reference, one to rehydrate and one to verify on republish. Thus even a text-only follow-up can pay for images from earlier turns.

**Side effect:** if a sidecar file is missing, a marker update succeeds but permanently rewrites the stored message to `[image missing #1]` and drops the image reference. This is existing hydrate-then-save behavior, but a turn marker now triggers it.

**Fix and regression:** Atomically update the marker in the stored JSON representation without hydrating or republishing images. Assert that a marker-only update preserves image references and performs zero sidecar reads, including when a sidecar is missing.

**Source:** `nax-agent/src/native/session/transcript-store.ts:67–77,97–101`; `nax-agent/src/native/session/transcript-images.ts:81–104,152–185`.

### 11. Replay rescans the full event history once per story — Low; scaling confirmed, production latency unproven

With 10,000 records and `--story` selecting one story, replay inspected story IDs **10,000 / 100,000 / 1,000,000** times for **1 / 10 / 100** stories. Filtering occurs at rendering, after reconstruction. The loader also materializes the full file text, split lines, and parsed records. Reconstruction alone took about **2.2 ms** locally for 100 stories with pre-parsed synthetic records; this timing excludes file I/O and JSON parsing and does not establish a production slowdown. A larger synthetic case (100,000 records, 300 stories) took about 86 ms.

**Fix and regression:** Stream JSONL once and accumulate per-story information as records arrive. Check that inspection counts scale with records rather than records multiplied by stories, while preserving filtered report output.

**Source:** `nax/src/commands/replay.ts:54–68,129–157`; `nax/src/replay/reconstruct.ts:98–122`; `nax/src/replay/phase-infer.ts:44–46`.

### 12. The job-panel tail limits lines, not bytes — Low-Medium; long-line defect, not a general large-log slowdown

A 256 KiB log of short records needed one 64 KiB read to return a tail. A single 256 KiB record needed five reads (four full chunks and a short remainder); each new chunk caused the accumulated line to be copied and scanned again. Disk I/O is linear, but copying and scanning can be quadratic within one line. The panel asks for 12 nonblank lines, refreshes running jobs every two seconds, and does not overlap refreshes for the same job. Neither 256 KiB fixture demonstrated a visible stall, but the growth is quadratic: a single-line log took about 2.5 ms at 1 MiB, 178 ms at 16 MiB and 2.5 s at 64 MiB per refresh, synchronously on the event loop.

**Display cost:** the 12-line limit does not bound rendering. Each line is wrapped in full with no width or row cap; at width 120, one 256 KiB line produced 2,222 rows and took about 75 ms per layout pass.

**Fix and regression:** Scan each chunk once and introduce a display byte limit with a truncation marker. Also cap rows per line in the job-panel layout. Retain a short-record control so typical tails still read only the end of the file.

**Source:** `nax/src/chat/jobs/log-tail.ts:27–32,64–80`; `nax/src/chat/jobs/job-panel-view.ts:173–177`; `nax/src/tui/chat/use-job-panels.ts:154–215`; `nax/src/tui/chat/layout-job.ts:242–245`; `nax/src/tui/chat/layout-lines.ts:244–255`.

### 13. Mirror inventory reads ledgers concurrently — Low; defer pending field evidence

`nax memory mirrors` reads two whole JSONL ledgers per mirror concurrently and splits them to count nonblank lines. This occurs during explicit listing or pruning, not ordinary chat or note access. Koda decisions are capped at 500 rows per project mirror, a row cap rather than a byte cap. The cap is applied on the nax side (`MEMORY_KODA_DECISIONS_MAX`); it was not found in the Koda source. Twelve synthetic mirrors totaling about 671 KB took **0.66 ms** warm. Peak heap and cold-filesystem behavior were not measured.

**Recommendation:** If real installations show inventory pressure, bound concurrency and stream the counts. Preserve the distinction between absent and unreadable files used by prune decisions.

**Source:** `nax/src/memory/mirrors.ts:199–203,285–337`; `nax/src/cli/memory-mirrors.ts:249–346`; `nax/src/memory/koda-mapping.ts:109,393`.

### 14. Quiet coverage capture can outlive its deadline without bound — Medium locally; default-CI claim withdrawn

Only a **parent** with `AGENT=1` captures both streams into complete strings. It starts draining promptly, but clears the timeout after the direct child exits and before captured streams reach EOF. In a bounded Bun 1.4.5 probe, the leader exited in about **5 ms** and capture finished around **412 ms** because a descendant still held the pipe. The capture has no deadline of its own, so it is unbounded, not merely late: with a descendant that keeps running, capture stayed pending until that descendant exited, and a descendant that never exits would hang the script indefinitely. No workflow sets `AGENT`, so the checked-in CI jobs inherit output and have outer timeouts; no CI hang was observed. Agent sessions set `AGENT=1` and are exposed.

**Fix and regression:** Keep an end-to-end deadline through pipe completion in quiet mode. Retain a bounded diagnostic tail or spool output to disk. Test leader exit and stream EOF as separate events.

**Source:** `repo-tooling/scripts/check-coverage.ts:143–145,207–251`.

## Verification scope

A second pass re-verified every finding against the same commit with independent probes; the corrections from that pass are folded in above (#1 fix trap, #2 scope and discovery ordering, #4 data loss, #5 outbox timeout path, #8 reverse lookup, #10 missing-sidecar rewrite, #12 display cost, #14 unbounded capture). Pipeline mode has been removed; findings that touch `src/pipeline/` were checked against workflow mode, which still uses that stage list.

The review used source and caller tracing, focused existing tests, temporary filesystem fixtures, fake transports and forge responses, and bounded runtime probes. Workspace typechecking and the `nax-ai` non-live suite passed. Timings above are local synthetic measurements, not production benchmarks. The review did not run the full monorepo suite, contact live providers, reproduce destructive Git cleanup on a real checkout (#4 was reproduced on a temporary repository only), or collect production heap profiles.
