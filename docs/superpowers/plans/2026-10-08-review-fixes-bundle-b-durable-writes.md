# Review Fixes Bundle B — Durable Writes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read the master plan's **Global Constraints** first: `2026-10-08-review-fixes-master-plan.md`.

**Goal:** A crash mid-write never destroys a session transcript or the remembered-approvals store, and a `null` pi auth file fails with the module's own typed error.

**Architecture:** One new nax-agent helper, `writeFileAtomic` (stage beside the target, then `rename`), used by the transcript store and the approvals store. The approvals append path additionally refuses to rewrite a store it could not parse, mirroring the removal path. The pi import validates the parsed shape. All in `packages/nax-agent` (Node APIs only — `check:no-bun-apis` forbids `Bun.*` in this package).

**Tech Stack:** TypeScript, `node:fs/promises`, bun:test.

**Spec:** `docs/superpowers/reviews/2026-10-08-whole-repo-code-review.md` findings #3, #15, #16.

**Branch:** `git fetch origin && git checkout -b fix/review-b-durable-writes origin/main`

## Global Constraints

See the master plan. All files here are well under the size caps (approvals-store.ts 349, transcript-store.ts 216, auth.ts 407).

## Review Focus

See the master plan. This bundle owns Review Focus line 2 (a run killed mid-save), pinned in Tasks 1 and 3.

## Files

- Create: `packages/nax-agent/src/internal/atomic-write.ts` (Task 1)
- Modify: `packages/nax-agent/src/internal.ts` (Task 1 — re-export)
- Modify: `packages/nax-agent/src/native/session/transcript-store.ts:10, 65-68` (Task 1)
- Modify: `packages/nax-agent/src/native/auth.ts:194-207` (Task 2)
- Modify: `packages/nax-agent/src/permissions/approvals-store.ts:21-24, 200-223` (Task 3)
- Test: `packages/nax-agent/test/unit/internal/atomic-write.test.ts` (new, mirrors the src module)
- Test: `packages/nax-agent/test/unit/native/transcript-store.test.ts` (470 lines)
- Test: `packages/nax-agent/test/unit/native/auth-store-ops.test.ts` (242 lines)
- Test: `packages/nax-agent/test/unit/permissions/approvals-store.test.ts` (345 lines)

---

### Task 1: Transcripts are written atomically (#3)

`writeTranscriptDoc` truncates the live file in place; a SIGKILL mid-write leaves partial JSON, and every later load throws `TRANSCRIPT_CORRUPT` (by design — it must not silently restart). Write to a sibling staging file and `rename` it over the target: a reader then sees the old document or the new one, never a torn one.

**Files:**
- Create: `packages/nax-agent/src/internal/atomic-write.ts`
- Modify: `packages/nax-agent/src/internal.ts`
- Modify: `packages/nax-agent/src/native/session/transcript-store.ts`
- Test: `packages/nax-agent/test/unit/internal/atomic-write.test.ts`
- Test: `packages/nax-agent/test/unit/native/transcript-store.test.ts`

**Interfaces:**
- Produces: `export async function writeFileAtomic(path: string, content: string, options?: { mode?: number }): Promise<void>` and `export const _atomicWriteDeps = { writeFile, rename, rm }` in `#src/internal/atomic-write`. Task 3 consumes `writeFileAtomic`.

- [ ] **Step 1: Write the failing tests**

Create `packages/nax-agent/test/unit/internal/atomic-write.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _atomicWriteDeps, writeFileAtomic } from "#src/internal/atomic-write";
import { withDepsRestore } from "#test/helpers/index";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nax-atomic-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  withDepsRestore(_atomicWriteDeps);

  test("writes the content and leaves no staging file behind", async () => {
    const path = join(dir, "doc.json");
    await writeFileAtomic(path, '{"v":1}');
    expect(await readFile(path, "utf8")).toBe('{"v":1}');
    expect(await readdir(dir)).toEqual(["doc.json"]);
  });

  test("a write that dies part-way leaves the previous content intact and cleans up", async () => {
    const path = join(dir, "doc.json");
    await writeFile(path, '{"v":1}');
    const realWrite = _atomicWriteDeps.writeFile;
    _atomicWriteDeps.writeFile = async (target, content, options) => {
      await realWrite(target, content.slice(0, 3), options);
      throw new Error("ENOSPC: no space left on device");
    };

    await expect(writeFileAtomic(path, '{"v":2,"long":"payload"}')).rejects.toThrow("ENOSPC");
    expect(await readFile(path, "utf8")).toBe('{"v":1}');
    expect(await readdir(dir)).toEqual(["doc.json"]);
  });

  test("applies the requested file mode", async () => {
    const path = join(dir, "secret.json");
    await writeFileAtomic(path, "{}", { mode: 0o600 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});
```

In `transcript-store.test.ts`, add `_atomicWriteDeps` via `import { _atomicWriteDeps } from "#src/internal/atomic-write";` and append inside `describe("transcript store", ...)`:

```ts
  test("a save that dies mid-write leaves the previous transcript loadable", async () => {
    await saveTranscript(dir, "sess-a", msgs);
    const realWrite = _atomicWriteDeps.writeFile;
    _atomicWriteDeps.writeFile = async (target, content, options) => {
      await realWrite(target, content.slice(0, 10), options);
      throw new Error("killed");
    };
    try {
      await expect(saveTranscript(dir, "sess-a", [...msgs, { role: "user", content: "more" }])).rejects.toThrow(
        "killed",
      );
    } finally {
      _atomicWriteDeps.writeFile = realWrite;
    }
    expect(await loadTranscript(dir, "sess-a")).toEqual(msgs);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run (from `packages/nax-agent`): `timeout 30 bun test test/unit/internal/atomic-write.test.ts test/unit/native/transcript-store.test.ts --timeout=5000`
Expected: FAIL — `#src/internal/atomic-write` does not exist.

- [ ] **Step 3: Implement**

Create `packages/nax-agent/src/internal/atomic-write.ts`:

```ts
/**
 * Whole-file writes that a crash cannot tear.
 *
 * `writeFile` truncates the target before the new bytes land, so a process
 * killed mid-write (SIGKILL, OOM, ENOSPC) leaves a partial file and the old
 * content is gone. Staging the bytes in a sibling and `rename`-ing it over the
 * target publishes the new content in one step: a reader, or the next run,
 * sees the old file or the new one. Same-directory staging keeps the rename on
 * one filesystem, where POSIX makes it atomic. Not fsync'd: this guards against
 * a killed PROCESS, not a power loss.
 */
import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

/** The one `writeFile` shape this module uses; narrower than the overloaded node signature so stubs type-check. */
type WriteText = (path: string, content: string, options: { encoding: "utf8"; mode?: number }) => Promise<void>;

/** Injectable for tests that simulate a write dying part-way. */
export const _atomicWriteDeps: { writeFile: WriteText; rename: typeof rename; rm: typeof rm } = {
  writeFile: (path, content, options) => writeFile(path, content, options),
  rename,
  rm,
};

export async function writeFileAtomic(path: string, content: string, options: { mode?: number } = {}): Promise<void> {
  // Ends in `.tmp`, not `.json`, so directory sweeps that match `*.json` never see it.
  const staged = `${path}.${randomUUID()}.tmp`;
  try {
    await _atomicWriteDeps.writeFile(staged, content, {
      encoding: "utf8",
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
    });
    await _atomicWriteDeps.rename(staged, path);
  } catch (error) {
    await _atomicWriteDeps.rm(staged, { force: true });
    throw error;
  }
}
```

In `packages/nax-agent/src/internal.ts`, add the re-export in its ALPHABETICAL slot among the `#src/internal/*` lines (the list is sorted; it goes right after the `argv-exec` line):

```ts
export * from "#src/internal/atomic-write";
```

This adds `_atomicWriteDeps` and `writeFileAtomic` to the package's `/internal` surface, which is snapshotted: `test/unit/packaging/public-surface.test.ts` compares `Object.keys(internal)` with `packages/nax-agent/api/nax-agent.api.txt`, and `check:api` gates it. Regenerate the snapshot from `packages/nax-agent`:

```bash
bun run api:update
git diff api/nax-agent.api.txt   # expect exactly two added names: _atomicWriteDeps, writeFileAtomic
```

In `transcript-store.ts`, drop `writeFile` from the `node:fs/promises` import, add `import { writeFileAtomic } from "#src/internal/atomic-write";`, and change `writeTranscriptDoc`:

```ts
async function writeTranscriptDoc(dir: string, sessionName: string, doc: TranscriptDoc): Promise<void> {
  await mkdir(dir, { recursive: true });
  // Atomic (#3): a torn transcript is unrecoverable — every later load throws TRANSCRIPT_CORRUPT.
  await writeFileAtomic(transcriptPath(dir, sessionName), JSON.stringify(doc, null, 2));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 30 bun test test/unit/internal/ test/unit/native/ test/unit/packaging/ --timeout=5000`
Expected: PASS (the packaging suite proves the snapshot matches). `pruneRetainedTranscripts` filters names ending in `.json`, so a leftover `*.tmp` from a killed process is never counted or deleted by it.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent/src/internal/atomic-write.ts packages/nax-agent/src/internal.ts packages/nax-agent/api/nax-agent.api.txt packages/nax-agent/src/native/session/transcript-store.ts packages/nax-agent/test/unit/internal/atomic-write.test.ts packages/nax-agent/test/unit/native/transcript-store.test.ts
git commit -m "fix(native): write session transcripts atomically (review #3)"
```

---

### Task 2: A `null` or non-object pi auth file fails with `AUTH_IMPORT_SOURCE_UNREADABLE` (#15)

`JSON.parse("null")` succeeds, so `Object.keys(null)` throws a raw `TypeError`. An entry value of `null` (`{"x": null}`) crashes `fromPiEntry` the same way.

**Files:**
- Modify: `packages/nax-agent/src/native/auth.ts:194-210`
- Test: `packages/nax-agent/test/unit/native/auth-store-ops.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside `describe("importPiCredentials", ...)`:

```ts
  test.each(["null", "[]", '"a string"', "42"])(
    "reports a file whose JSON is not a provider map (%s) as AUTH_IMPORT_SOURCE_UNREADABLE",
    async (body) => {
      writeFileSync(piPath, body);
      await expect(importPiCredentials({ from: piPath })).rejects.toMatchObject({
        code: "AUTH_IMPORT_SOURCE_UNREADABLE",
      });
    },
  );

  test("a null provider entry is unsupported, not a crash", async () => {
    writeFileSync(piPath, JSON.stringify({ broken: null, "opencode-go": { type: "api_key", key: "sk-1" } }));
    expect(await importPiCredentials({ from: piPath })).toEqual([
      { providerId: "broken", status: "unsupported" },
      { providerId: "opencode-go", status: "imported" },
    ]);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 30 bun test test/unit/native/auth-store-ops.test.ts --timeout=5000`
Expected: FAIL — `TypeError: Cannot convert undefined or null to object` / `null is not an object`.

- [ ] **Step 3: Implement**

In `auth.ts`, right after the `JSON.parse` try/catch (before `const store = naxCredentialStore();`), add:

```ts
  // JSON.parse accepts `null`, arrays and scalars; none of them is a provider map.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new NaxError(`The file at ${path} is not a provider credential map.`, "AUTH_IMPORT_SOURCE_UNREADABLE", {
      path,
    });
  }
```

and change the per-entry guard in the loop:

```ts
    const credential = entry === undefined ? undefined : fromPiEntry(entry);
```

to:

```ts
    const credential = typeof entry === "object" && entry !== null ? fromPiEntry(entry) : undefined;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 30 bun test test/unit/native/ --timeout=5000`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent/src/native/auth.ts packages/nax-agent/test/unit/native/auth-store-ops.test.ts
git commit -m "fix(auth): typed error for a pi auth file that is not a provider map (review #15)"
```

---

### Task 3: Remembering an approval never destroys the store (#16)

`appendApproval` reads through `readApprovalsFile`, which returns an EMPTY store on any failure (by design, for lookups), then writes `{entries: [entry]}` — dropping every remembered approval and the taint marker whenever the file was unreadable or unparseable (e.g. torn by a crash, since `writeApprovalsFile` also writes in place). Fix both halves: the append path refuses an unparseable store and propagates read errors (the caller already logs and still allows the approved call: `packages/nax/src/interaction/ask-link-session.ts:227-240`), and every write is atomic.

**Files:**
- Modify: `packages/nax-agent/src/permissions/approvals-store.ts`
- Test: `packages/nax-agent/test/unit/permissions/approvals-store.test.ts`

**Interfaces:**
- Consumes: `writeFileAtomic` from Task 1.
- `appendApproval(path, entry)` keeps its signature; it now rejects with `NaxError` code `APPROVALS_STORE_UNPARSEABLE` instead of overwriting.

- [ ] **Step 1: Write the failing tests**

Append inside `describe("approvals store", ...)`:

```ts
  test("appending to an unparseable store refuses instead of replacing it", async () => {
    const dir = makeTempDir("approvals-");
    const path = join(dir, "approvals.json");
    writeFileSync(path, '{ "entries": [ { "stage": "implementer", "comm');
    await expect(appendApproval(path, entry("bun run test"))).rejects.toMatchObject({
      code: "APPROVALS_STORE_UNPARSEABLE",
    });
    expect(await Bun.file(path).text()).toBe('{ "entries": [ { "stage": "implementer", "comm');
    cleanupTempDir(dir);
  });

  test("appending to an unreadable store propagates the error instead of replacing it", async () => {
    const dir = makeTempDir("approvals-");
    const path = join(dir, "approvals.json");
    await appendApproval(path, entry("first"));
    // Write-only: the READ fails with EACCES while a write would still succeed, so the old
    // code (read failure -> empty store -> write) clobbers the store. 0o000 would make the
    // old write fail too and the test would pass before the fix.
    chmodSync(path, 0o200);
    try {
      await expect(appendApproval(path, entry("second"))).rejects.toThrow();
    } finally {
      chmodSync(path, 0o600);
    }
    expect((await readApprovals(path)).map((e) => e.command)).toEqual(["first"]);
    cleanupTempDir(dir);
  });
```

(Tests may use `Bun.file` — `check:no-bun-apis` scans `src/` only. If the chmod test is skipped on a root CI runner, wrap it in `test.skipIf(process.getuid?.() === 0)` instead of `test` — root ignores file modes.)

- [ ] **Step 2: Run them to verify they fail**

Run: `timeout 30 bun test test/unit/permissions/approvals-store.test.ts --timeout=5000`
Expected: FAIL — both appends resolve, and the store is replaced by a one-entry file.

- [ ] **Step 3: Implement**

In `approvals-store.ts`:

1. Imports: drop `writeFile` from the `node:fs/promises` import; add `import { writeFileAtomic } from "#src/internal/atomic-write";` and `import { NaxError } from "#src/infra/index";` (use whatever path `transcript-store.ts` uses for `NaxError`).

2. `writeApprovalsFile`:

```ts
/** Serialize the whole store, atomically (#16): a torn store would lose every remembered approval. Callers hold the path lock. */
export async function writeApprovalsFile(path: string, file: ApprovalsFile): Promise<void> {
  const body = file.taint === undefined ? { entries: file.entries } : { taint: file.taint, entries: file.entries };
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(body, null, 2)}\n`);
}
```

3. `appendApproval` — read with the DETAILED reader so failure is not mistaken for emptiness:

```ts
export async function appendApproval(path: string, entry: ApprovalEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await withPathFileLock(path, async () => {
    // Detailed read, not readApprovalsFile: that one reads failure AS empty (right for a
    // lookup), and writing "empty + this entry" back would destroy the store (#16). A read
    // error propagates; the caller logs it and still allows the approved call.
    const read = await readApprovalsFileDetailed(path);
    if (read.state === "unparseable") {
      throw new NaxError("approvals.json could not be parsed; not rewriting it", "APPROVALS_STORE_UNPARSEABLE", {
        stage: "permissions",
        path,
      });
    }
    await writeApprovalsFile(path, { taint: read.file.taint, entries: [...read.file.entries, entry] });
  });
}
```

Extend `appendApproval`'s doc comment with one line: "An unparseable store is refused, never replaced (the removal path does the same)."

- [ ] **Step 4: Run tests to verify they pass**

Run: `timeout 30 bun test test/unit/permissions/ --timeout=5000`
Then the nax consumer (from `packages/nax`): `timeout 30 bun test test/unit/interaction/ --timeout=5000`
Expected: PASS. If a nax test asserted that remembering over a malformed store succeeds, it pinned #16: update it to expect the warning path (`"[ask] approved call not remembered; allowing anyway"`) and an `allow` decision.

- [ ] **Step 5: Commit**

```bash
git add packages/nax-agent/src/permissions/approvals-store.ts packages/nax-agent/test/unit/permissions/approvals-store.test.ts
git commit -m "fix(permissions): never replace an unreadable approvals store; write it atomically (review #16)"
```

---

## Bundle wrap-up

Run the master plan's **Per-bundle PR checklist** with scope `nax-agent`. Also run the nax gates (Task 3 changes behaviour nax consumes).
