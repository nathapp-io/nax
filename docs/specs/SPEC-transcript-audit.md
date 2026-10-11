# SPEC: Archive native session transcripts on close (`agent.transcriptAudit`)

Issue: #2453. Follow-ups (out of scope): #2454 (usage-audit join), #2455 (offline replay).

## Summary

Add an opt-in `agent.transcriptAudit` config block. When it is enabled, every native session close, whether clean or failed, first writes a redacted copy of the session's transcript document into an archive directory. Then the existing close behaviour runs unchanged: a clean close deletes the live transcript, and a failed close renames it aside. The archive is pruned to a retention cap after each write.

## Motivation

`closeNativeSession` (`packages/nax-agent/src/native/session/session.ts`) deletes the transcript on a clean close and keeps it only on failure. Passing sessions, which is where most tokens are spent, therefore leave no turn-level record. prompt-audit, tool-audit, usage-audit and the cost ledger each record only part of a session.

## Design

### Config (`packages/nax`)

`packages/nax/src/config/schemas-infra.ts` gets a sibling of `UsageAuditConfigSchema`:

```ts
const TranscriptAuditConfigSchema = z.object({
  /** When true, every native session transcript is archived on close. Default: false. */
  enabled: z.boolean().default(false),
  /** Archive root. Must be an absolute path. Defaults to <outputDir>/transcript-audit when absent. */
  dir: z.string().refine(isAbsolute, "agent.transcriptAudit.dir must be an absolute path").optional(),
  /** Archived transcripts kept per feature directory, oldest pruned first. Default: 200. */
  maxRetained: z.number().int().min(1).default(200),
});
```

It is registered as `agent.transcriptAudit` with the default `{ enabled: false, maxRetained: 200 }`. Every place that lists `usageAudit` must handle the new block the same way:
- `config/schemas.ts` defaults
- `config/runtime-types-agent.ts`: add a `TranscriptAuditConfig` type
- `config/merge.ts`: deep merge, following the `usageAudit` pattern
- `cli/config-descriptions.ts`: add the three keys

### Session option (`packages/nax-agent`)

`OpenSessionOpts` (`packages/nax-agent/src/session/session-types.ts`) gains:

```ts
/**
 * Native: when set, closeNativeSession writes a redacted copy of the transcript
 * here before deleting or retaining it. ACP ignores it.
 */
transcriptArchive?: { readonly dir: string; readonly maxRetained: number };
```

`openNativeSession` stores it on the session's `SessionTranscript` entry, next to `store` and `retainOnClose`.

### Close behaviour (`packages/nax-agent`)

In `closeNativeSession`, when `transcript !== undefined && !transcript.retainOnClose` and the entry has a `transcriptArchive`, call a new `archiveTranscript(store, sessionId, archive)` **before** the existing `retainFailed` / `delete` branch. This function lives in a new file, `packages/nax-agent/src/native/session/transcript-archive.ts`:

1. `const doc = await store.load(sessionId)`. If the result is `null`, return (nothing to archive).
2. Write `redactSecrets(doc)` with `writeFileAtomic` to `join(archive.dir, \`${sessionId}.transcript.${stamp}.json\`)`, where `stamp = new Date().toISOString().replace(/[:.]/g, "-")`. Create the directory with `mkdir({ recursive: true })`.
3. `await pruneRetainedTranscripts(archive.dir, archive.maxRetained)`.
4. Errors from steps 1-3 are caught and logged as a warning through `getLogger()` (stage `"native-session"`). They are never thrown. The archive is supplementary and must not change close semantics.

The archive file name contains `.transcript.` and ends in `.json`, so the existing `pruneRetainedTranscripts` filter matches it with no changes. Archived files never sit in the live `sessions/` directory, so they can never be loaded as a resumption source (nax#1877).

Export `archiveTranscript` from the native barrel only if a test outside the package needs it. Otherwise keep it internal.

### Wiring (`packages/nax`)

`openSessionExtras` (`packages/nax/src/session/open-session-extras.ts`) takes the resolved config as a third parameter. When `config?.agent?.transcriptAudit?.enabled` is true and `featureName` is known, it adds:

```ts
transcriptArchive: {
  dir: join(config.agent.transcriptAudit.dir ?? join(transcriptRoot, "transcript-audit"), featureName),
  maxRetained: config.agent.transcriptAudit.maxRetained ?? 200,
}
```

The field is omitted when the block is disabled, when `featureName` is missing, or when `transcriptRoot` is undefined and no `dir` is configured. The call site in `packages/nax/src/session/manager.ts` changes in place to `openSessionExtras(opts, this._transcriptRoot, opts.config ?? this._config)`. manager.ts is a grandfathered oversized file and must not gain lines.

## Acceptance criteria

1. With `transcriptAudit` disabled (the default), closing a native session writes nothing to any archive directory, and the live transcript is deleted (clean close) or renamed `*.transcript.failed-*` (failed close), exactly as today.
2. When enabled, a clean close leaves one `<sessionId>.transcript.<stamp>.json` in the archive dir, and its `messages` equal the live document's messages after redaction. The live transcript is deleted.
3. When enabled, a failed close leaves one archived copy, and the live transcript is still renamed to `*.transcript.failed-*` in the `sessions/` dir.
4. A secret-shaped string in a tool-result message (one that `redactSecrets` masks) appears masked in the archived file.
5. A session opened with `retainOnClose: true` writes no archive and keeps its live transcript.
6. A session that never saved a transcript (`load` returns `null`) closes without error and writes no archive file.
7. When the archive write throws (for example, the archive dir is not writable), close still completes, the live transcript is still deleted or retained, and no error propagates.
8. With `maxRetained: 2`, three closes leave only the two newest archived files.
9. `openSessionExtras` returns `transcriptArchive` with `dir = <transcriptRoot>/transcript-audit/<feature>` when enabled with no `dir`, uses `<dir>/<feature>` when `dir` is set, and omits the field when disabled or when `featureName` is missing.
10. A relative `agent.transcriptAudit.dir` fails config validation. A relative path would otherwise resolve against the process cwd, and SessionManager has no workdir to anchor it, unlike `usageAudit`.
11. `nax config` shows `agent.transcriptAudit` with its description, and a package-level override of `enabled` merges like `usageAudit`.

## Tests

- `packages/nax-agent/test/unit/native/session/transcript-archive.test.ts`: AC 2-8 against `closeNativeSession`, using a temp dir and the file store, plus `createMemoryTranscriptStore` for AC 6.
- `packages/nax/test/unit/session/open-session-extras.test.ts`: AC 9.
- Config tests next to the existing `usageAudit` schema/merge tests: AC 1 defaults, AC 10 and AC 11.

Write the tests first. Run the repo's own test commands (see the nax root `package.json` / `check:all`), never bare `bun test`.

## Out of scope

- ACP transcripts: they hold no message history.
- Sessions opened outside SessionManager (the nax-agent facade, `session/native-backend.ts`, used by the ACP server): an embedder that wants an archive passes `transcriptArchive` itself.
- Joining archived messages to usage-audit round trips (#2454).
- Replay tooling (#2455).
- Changing prompt-audit, tool-audit or usage-audit.
