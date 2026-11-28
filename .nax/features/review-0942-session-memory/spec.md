# SPEC: Bound session bookkeeping to pending events and stored transcript metadata

## Summary

Bundle findings **9 and 10** of `docs/reviews/nax-v0.94.2-verified-code-review.md` into one run in `packages/nax-agent`. A slow consumer should not keep delivered events alive. Recording that a turn started or ended should not access the images in its history. These are private implementation changes; callers keep the same iterator and transcript-store interfaces.

## Motivation

At `5a112f0a2`, the review observed 10,002 live event objects with only two pending. The excess disappeared after drain: the defect is retention *during* a backlog, not a session-lifetime leak. Separately, two historical image references cost four sidecar reads per file-store marker. Worse, if an image was temporarily absent, marking the turn persisted a missing-image note and discarded the reference. An ordinary load may display that note; metadata bookkeeping must not make the loss permanent.

## Design

- **Event delivery.** `createSessionEventChannel` currently advances `head` but clears the indexed FIFO only when empty. Release the dequeued reference immediately and periodically reclaim consumed slots, or use an equivalent bounded FIFO. Keep amortized constant-time queue operations; do not shift or copy the entire pending queue per delivery. The mergeable delta tail is also pending. The target is space proportional to recent backlog plus bounded slack, not a cap that drops events. No GC deadlines or timing benchmarks as acceptance oracles.
- **File turn markers.** `createFileTranscriptStore(dir).markTurn(sessionId, marker)` currently goes through `readTranscriptDoc` and `writeTranscriptDoc`, which hydrate and split images. Instead read the stored JSON and publish a marker-only update using the existing atomic JSON writer and private mode (`0o600`). Preserve format checks without opening sidecars. Compare parsed JSON, not whitespace. `load` still hydrates; `save` still publishes image data before JSON. `running` and `ended` must each operate on the latest stored document, not a cached snapshot from the start of the turn.

## Stories

**US-001: Release delivered events under sustained backlog (finding 9).** Workdir: `packages/nax-agent`. No dependencies. Exercise the actual channel with uniquely identifiable, alternating text/thinking deltas. Seed two pending; for 10,000 iterations push the next event before pulling one so the channel never drains. Observe the actual backing storage (e.g. a package-private test inspection of occupied slots and used span, including the tail); do not use a derived `length - head` pending counter as evidence that references were released. Add cases to the existing session-event-channel suite. No new public diagnostics.

**US-002: Update only the stored turn marker (finding 10).** Workdir: `packages/nax-agent`. No dependencies. Call the file store's `markTurn` on real temporary transcript files. Seed image history via `save`; start counting sidecar operations only after setup, and stop before verification loads. Use the existing image filesystem seam. Test `running` and `ended` individually; for the latter include a genuine intervening save with a changed message so stale snapshots cannot pass.

### Context Files

**US-001**
- `packages/nax-agent/src/session/session-event-channel.ts` — FIFO, waiter, delta tail and control-event accounting.
- `packages/nax-agent/src/session/agent-session-turn.ts` — channel consumer and turn lifecycle.
- `packages/nax-agent/test/unit/session/session-event-channel.test.ts` — valid event fixtures and behavioral controls.

**US-002**
- `packages/nax-agent/src/native/session/transcript-store.ts` — file load, save, mark and error paths.
- `packages/nax-agent/src/native/session/transcript-images.ts` — private v2 format, sidecar operations and read-time fallback.
- `packages/nax-agent/src/native/session/transcript-types.ts` — marker and store contracts.
- `packages/nax-agent/test/unit/native/session/transcript-images-read.test.ts` — filesystem seam and hydration fixtures.
- `packages/nax-agent/test/unit/native/transcript-store.test.ts` — move only the three markTurn cases from the mixed createFileTranscriptStore block into a new marker describe block; leave the other cases in place.

### Creates

**US-002**
- `packages/nax-agent/test/integration/native/transcript-store-turn-marker.test.ts` — split the marker concern out of the existing 559-line transcript-store suite before extending it.

### Modifies

**US-002**
- `packages/nax-agent/test/unit/native/transcript-store.test.ts` — relocate existing markTurn tests to the concern split; preserve every existing assertion there.

### Seams

None between stories. Both exercise existing entry points.

## Acceptance Criteria

### US-001

1. [unit] In the fixed-backlog fixture, after every `iterator.next()` the channel's backing storage references only the two undelivered event objects, not any delivered object. The baseline must fail before drain.
2. [unit] With two events pending throughout, the space used for FIFO slots does not grow with the number delivered. State the implementation's fixed slack bound and assert the actual storage span remains within that bound plus backlog across multiple reclamation cycles. Clearing references but accumulating 10,000 empty slots is not sufficient.
3. [unit] After `end()` and drain, the sequence returned across the entire alternating-delta fixture equals the pushed sequence, in order and without loss or duplication.
4. [unit] Across storage reclamation, buffered adjacent `tool_input_delta` events with the same round and call ID still merge by summing `chars`; different call IDs remain distinct.
5. [unit] Across reclamation, delivered controls no longer count toward `controlCap`; exceeding the cap with undelivered controls still fires `onStall` only once.

6. [unit] Fill the channel with N = 8,192 alternating nonmergeable deltas before pulling. Across drain, the total number of pending slots relocated is bounded by a stated small constant times N (count actual compaction work, not elapsed time). Per-pull shifting of the pending queue would require quadratic movement and must fail this bound.

### US-002

1. [integration] Given a schemaVersion 2 transcript with user and tool-result references to the same image, each `markTurn` performs zero image-sidecar filesystem operations. Count calls on the image seam (including reads, existence checks and publication), excluding transcript JSON I/O.
2. [integration] On that fixture, raw JSON after each successful mark equals the immediately preceding parsed document with only `turn` replaced by the supplied `{turnId, state}`. Include owner/model, savedAt, duplicate refs and their metadata; for `ended` compare against the intervening save.
3. [integration] With one referenced sidecar absent, each of `running` and `ended` makes zero calls on the image filesystem seam during `markTurn` and still persists the requested marker without dropping the ref or appending a missing-image note to stored content. Restoring the same sidecar then makes `load` return the original image again without another save.
4. [integration] Marking an absent transcript creates a loadable document with `messages: []`, a current ISO `savedAt`, and the supplied `turn`, with private file mode on POSIX.
5. [integration] Marking a legacy bare message array wraps those same messages with epoch `savedAt` and the supplied marker, without migrating inline images to sidecars.
6. [integration] For a valid unversioned or v1 text-only document, `markTurn` preserves its stored fields apart from `turn` (including whether `schemaVersion` was present).
7. [integration] Invalid JSON or a null/scalar document causes `markTurn` to reject with `TRANSCRIPT_CORRUPT`, leaving original bytes intact.
8. [integration] For a numeric `schemaVersion` above 2, `markTurn` rejects with `TRANSCRIPT_SCHEMA_UNSUPPORTED` and does not overwrite the file.
9. [integration] For v2 user/tool-result `images` set to a nonempty string instead of a list, `markTurn` retains the existing `TRANSCRIPT_CORRUPT` rejection without modifying the file.
10. [integration] Inject a failure before atomic rename during `markTurn` of an existing file; the caller sees failure and the previous complete JSON remains at its original path.

11. [integration] A v2 `messages` container set to null or a non-array object causes `markTurn` to reject before publication. The original bytes remain intact and there are no sidecar operations.

## Verification

Show the sustained-retention and sidecar-I/O or missing-ref regressions failing against the baseline before applying fixes. From `packages/nax-agent` run `timeout -k 5s 60s bun test ./test/unit/session/session-event-channel.test.ts ./test/integration/native/transcript-store-turn-marker.test.ts ./test/unit/native/transcript-store.test.ts ./test/unit/native/session/transcript-images-read.test.ts ./test/unit/native/session/transcript-images-write.test.ts ./test/unit/native/transcript-store-modes.test.ts --timeout=60000`. Use the normal package typecheck and check:all gates. No provider, network, heap profiler or live session required.

## Out of Scope

- Review findings 1–4 shipped in #3075; findings 5–8 and 11–14 are not part of this run. No release work.
- No changes to public session APIs, event delivery policy, `controlCap`, subscriber count or turn lifecycle.
- No bound on an actively growing undelivered backlog, delta payload size, process RSS or GC scheduling.
- No change to ordinary image load/save semantics, missing-image display, memory-backed stores, transcript retention, or image/JSON formats. No history migration or sidecar repair.
- No new cross-writer locking or transactional isolation. Atomic publication here means readers see a complete old or new JSON document, not that concurrent independent writers merge updates.
