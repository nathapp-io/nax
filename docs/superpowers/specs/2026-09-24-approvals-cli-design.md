# `nax approvals list/rm` — design

**Date:** 2026-09-24
**Finding:** cross-phase review P0-P5 #11 (MEDIUM) — "No `nax approvals list/rm`: D20's
'expiry: NONE' rests on a revocation surface that does not exist; store has no delete."
**Base:** `main` @ `3b7834208`, branch `feat/approvals-cli`.
**Independence:** standalone. `feat/xreview-remaining` does not touch `approvals-store.ts`
(its plan forbids it) and lists #11 out of scope; `feat/honest-gates-and-labels` touches only
quality-gate ops and config schemas. Commands print raw (below), so nothing depends on #9's
`secret-spans.ts`. The one shared file is `docs/adr/ADR-030-bash-approval-modes.md`:
xreview-remaining edits `:136-151`, `:242-252` and "See also"; this design edits only the
trust-boundary section (`:272-300`), so a merge touches separate hunks.

## Goal

D20 (master plan, 2026-09-22) ruled that a remembered approval never expires, and justified it
by the entry being "auditable and revocable" through a `nax approvals list/rm` surface. That
surface was never built: `approvals-store.ts` can append and read, nothing else. This design
builds it: an operator can see every standing grant for a project, see whether the cache is
currently trusted, and revoke grants.

## Non-goals

`add`, expiry or `--older-than`, id-prefix matching, clearing a taint from the CLI, masking
secrets in output, any change to the file format, the cache key or `approvals-link.ts`.

## Rulings taken in brainstorming (2026-09-24)

1. **Commands print raw.** It is the operator's own terminal reading a file that stays raw by
   the #9 ruling; masking is an egress concern (Telegram/webhook) only.
2. **`rm` addresses entries by a derived short id**, not by list position (unsafe under
   concurrent appends) and not by retyping the byte-exact command (impractical for heredocs).

## Command surface

```
nax approvals list [--json] [-d <dir>]
nax approvals rm <id...>          [-d <dir>]
nax approvals rm --stage <stage>  [-d <dir>]
nax approvals rm --all [--yes]    [-d <dir>]
```

`-d/--dir` defaults to `process.cwd()`. Exactly one of `<id...>`, `--stage`, `--all` is
required for `rm`; the check runs before the store is read.

### Store resolution

Same as `cli/runs.ts:14-19`: `loadConfig(workdir)` (a load failure falls back to defaults),
project key = `config.name?.trim() || basename(workdir)`, then
`approvalsPath(projectOutputDir(key, config?.outputDir))`. The four-line pattern is copied,
not extracted: refactoring `runs.ts`/`status-cost.ts` is unrelated churn.

### Entry id

`approvalId(entry)` = first 8 hex chars of `sha256(stage + "\0" + command + "\0" + approvedAt)`,
with a missing/non-string `approvedAt` read as `""`. Computed on read; never stored.

- Stable when other entries are added or removed.
- A duplicate (stage, command) pair recorded twice has two ids, because `approvedAt` differs.
- Two entries with an identical triple share an id; they are the same grant, and `rm` removes
  both. Stated, not guarded.
- A stale id matches nothing rather than the wrong entry.

### `list`

Human output:

```
Approvals store: /Users/x/.nax/my-project/approvals.json
Cache: trusted                                     # or the TAINTED line below
3 remembered approvals

a3f9c21e  execution  escalate  2026-09-22T10:14:03Z  telegram      naxCommit 57454e7ab
          root /repo/.nax-wt/US-002
          $ bun run test
0b77e514  execution  askRule   2026-09-22T10:20:41Z  telegram      naxCommit 57454e7ab
          root /repo
          $ cat <<'EOF' > notes.txt
            hello
            EOF
```

- Tainted store: `Cache: TAINTED since <since> by run <runId> (pid <n>, alive|exited|unknown)
  -- the cache is OFF; a trusted run will discard these entries.` Liveness reuses
  `_approvalsTaintDeps.isProcessAlive`; `unknown` when `pid` is undefined.
- Every command line after the first is indented, so an entry boundary is never ambiguous.
- Missing file: `No remembered approvals at <path>`, exit 0.
- Unparseable file: a warning line `approvals.json could not be parsed; the cache reads it as
  empty`, then the empty listing, exit 0.
- Dropped malformed elements (see `isApprovalEntry`): a warning line with the count.

`--json` prints one object:
`{ "path", "state": "ok"|"missing"|"unparseable", "taint": {...}|null, "droppedMalformed": n,
"entries": [{ "id", ...entry }] }`.

### `rm`

| Selector | Removes | No match |
|---|---|---|
| `<id...>` | exactly those entries (all-or-nothing) | any unknown id: `Unknown id(s): ...`, nothing removed, exit 1 |
| `--stage <s>` | every entry whose `stage === s` | `No entries for stage <s>`, no write, exit 0 |
| `--all` | every entry, after confirmation | empty store: no write, exit 0 |

- Ids are validated as `/^[0-9a-f]{8}$/` before the store is read; a malformed id exits 1.
- `--all` confirms via `promptForConfirmation` (`cli/confirm.ts:66`); `--yes` skips it; non-TTY without `--yes` refuses.
  A declined or refused confirmation prints `Aborted` and exits 1 with no write.
- Single-id and `--stage` removals need no confirmation: revoking costs prompts, never safety.
- On success prints each removed entry as `removed <id>  <stage>  <first command line, cut to
  80 chars>`, exit 0.
- **The taint marker is preserved exactly as found.** The CLI never clears it; only a trusted
  run starts a trusted epoch (`clearApprovalsTaint`, unchanged).
- Rewriting drops elements `isApprovalEntry` rejects; the cache already ignores them. `rm`
  reports the count when non-zero.

## Components

### `src/permissions/approvals-store.ts` (155 -> ~210 lines)

```ts
export type ApprovalsFileState = "ok" | "missing" | "unparseable";

export interface ApprovalsFileRead {
  readonly file: ApprovalsFile;
  readonly state: ApprovalsFileState;
  /** Array elements dropped by isApprovalEntry. */
  readonly droppedMalformed: number;
}

/** Same parse as readApprovalsFile, reporting what the lenient reader hides. */
export async function readApprovalsFileDetailed(path: string): Promise<ApprovalsFileRead>;

export function approvalId(entry: ApprovalEntry): string;

export type RemovalDecision =
  | { readonly remove: (entry: ApprovalEntry) => boolean }
  | { readonly refuse: string };

export type RemovalResult =
  | { readonly outcome: "removed"; readonly removed: readonly ApprovalEntry[]; readonly droppedMalformed: number }
  | { readonly outcome: "unchanged" }
  | { readonly outcome: "refused"; readonly reason: string };

/**
 * Locked read-decide-write. `decide` sees the file as read UNDER the lock, so a
 * check such as "every requested id exists" and the removal are one atomic step.
 */
export async function removeApprovals(
  path: string,
  decide: (read: ApprovalsFileRead) => RemovalDecision,
): Promise<RemovalResult>;
```

`removeApprovals` rules, in order, all inside `withPathFileLock(path)`:

1. `state === "missing"` -> `unchanged`, no write, no directory created.
2. `state === "unparseable"` -> `refused` ("approvals.json could not be parsed; not
   rewriting it"). Rewriting would erase whatever the file holds.
3. `decide` returns `refuse` -> `refused`, no write.
4. No entry selected -> `unchanged`, no write (bytes and mtime unchanged).
5. Otherwise write `{ taint: read.file.taint, entries: kept }` via `writeApprovalsFile`.

`readApprovalsFile` becomes a thin wrapper over `readApprovalsFileDetailed(...).file`, so the
cache path's behaviour is byte-for-byte unchanged. The module docblock gains one line: the CLI
in `src/cli/approvals.ts` is the revocation surface D20 relies on. `permissions/index.ts`
already re-exports this module; no edit.

### `src/cli/approvals.ts` (new, ~200 lines)

- `resolveApprovalsFile(workdir): Promise<string>`.
- `approvalsListCommand(opts: { workdir: string; json: boolean }): Promise<number>`.
- `approvalsRmCommand(opts: { workdir: string; ids: readonly string[]; stage?: string;
  all: boolean; yes: boolean }): Promise<number>`. Selector validation happens in here too, so
  it is testable without commander.
- Pure formatters: `formatTrustLine(taint, isAlive)`, `formatEntry(id, entry)`,
  `formatRemoved(id, entry)`.
- `_approvalsCliDeps = { write, writeErr, confirm, isTTY, isProcessAlive }` for tests, in the
  style of `_confirmDeps` / `_approvalsTaintDeps`.
- Errors: a `FILE_LOCK_TIMEOUT` `NaxError` from `withPathFileLock` is caught and reported as
  `a nax run is writing <path>; retry`, exit 1. Any other write error is reported with the
  path, exit 1. New throws, if any, use `NaxError` (`check:nax-error` ratchet).

### `bin/nax.ts`

An `approvals` command group registered after `auth`, with `list` and `rm`, each action doing
`const { ... } = await import("../src/cli/approvals")` (as `mcp lock` does) and
`process.exit(code)` (as the `auth` commands do).

### Docs

- `docs/guides/cli-reference.md`: `### nax approvals list` and `### nax approvals rm`
  sections.
- `docs/adr/ADR-030-bash-approval-modes.md`, "The approvals cache's trust boundary": one
  sentence that grants are listed and revoked with `nax approvals`, and that the CLI never
  clears a taint.
- `configuration.md` / `config-descriptions.ts`: untouched (#22 owns them).

## Error handling summary

| Case | Behaviour | Exit |
|---|---|---|
| No file | `No remembered approvals at <path>` | 0 |
| Unparseable file | list: warning + empty; rm: refused, not rewritten | list 0, rm 1 |
| Unknown id(s) | listed, nothing removed | 1 |
| Malformed id | rejected before reading | 1 |
| Zero or several selectors | usage error | 1 |
| `--stage` / `--all` match nothing | message, no write | 0 |
| `--all` declined / non-TTY without `--yes` | `Aborted`, no write | 1 |
| Lock timeout | `a nax run is writing <path>; retry` | 1 |
| Write failure | error naming the path | 1 |

## Testing

TDD, unit level. Temp dirs only (`makeTempDir`); never the real `~/.nax`
(`check:no-real-global-nax`). The CLI tests inject the approvals path or a temp workdir whose
config sets `outputDir`.

`test/unit/permissions/approvals-store.test.ts` (extend):
- `approvalId`: 8 lowercase hex; stable; differs for the same pair with a different
  `approvedAt`; missing `approvedAt` does not throw.
- `readApprovalsFileDetailed`: `missing`, `unparseable`, `ok`; counts dropped elements;
  `readApprovalsFile` output unchanged for all three.
- `removeApprovals`: taint preserved exactly (present and absent); no write when nothing is
  selected (mtime and bytes unchanged); missing file creates nothing; unparseable refused with
  the file intact; `refuse` from `decide` writes nothing; a concurrent `appendApproval` is
  serialized and its entry survives.

`test/unit/cli/approvals.test.ts` (new):
- `list`: exact rendered text for trusted, tainted-alive, tainted-exited, tainted-unknown-pid,
  empty, missing, unparseable, dropped-malformed, and a multi-line command; `--json` shape.
- `rm`: one id, several ids, unknown id (nothing removed), malformed id, `--stage` hit and
  miss, `--all` with confirm yes / no / non-TTY / `--yes`; zero and multiple selectors; lock
  timeout message; taint survives every variant.

Verification: `bun run test`, `bun run typecheck`, `bun run check:all`, then by hand
`bun bin/nax.ts approvals list` against a temp project and, read-only, against
`~/.nax/p2-exit-native-smoke`. No billed runs.

## Residual

An agent in a forge-capable run can call `nax approvals rm` through its shell. That can only
revoke grants, which costs prompts; it grants nothing, and a forge-capable run wipes the store
anyway.
