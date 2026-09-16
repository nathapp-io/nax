# PR 1 — Stop emitting a real but WRONG file at the frame SSOT (#2089)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop `src/context/builder.ts` injecting a package-local file as if it were the repo-root file a parent story actually touched.

**Architecture:** Add a partitioning helper to the path-frame SSOT that separates reachable from unreachable paths instead of silently passing unreachable ones through, and use it at the one agent-boundary consumer.

**Spec:** `docs/superpowers/specs/2026-09-16-path-frame-convention-design.md` (seam 6). **Overview:** [`00-overview.md`](./00-overview.md) — read its Global Constraints first.

**Base:** `main` @ `71071a035`.

**Blocks:** PR 2 consumes `partitionPackageFrame`. Do not start PR 2 until this lands.

---

## Global Constraints

See [`00-overview.md`](./00-overview.md#global-constraints). The ones that bite here:

- Bun-native only; `@/utils/path-frame` is a **pure leaf** — no I/O, no config, no logging, and **no value import from `@/prd`** (`check:import-cycles` guards this).
- `bun run typecheck && bun run lint && bun run test` green before every commit, plus `bun run test:coverage` (separate per-file floor; this PR adds tests).
- Never read `story.workdir` raw — use `storyWorkdir(story)`.

---

## The defect

```ts
// src/utils/path-frame.ts:157-159
export function toPackageFrameFiles(files: readonly string[], workdir: string | null | undefined): string[] {
  return files.map((file) => toPackageFrame(file, workdir) ?? file);
}
```

`toPackageFrame`'s own docblock one function up (`path-frame.ts:93-101`) says callers should render an unreachable path with `UNREADABLE_MARKER` **"rather than emitting a path that would resolve to a real but WRONG file under the consumer's root."** The list helper does exactly what the singular helper forbids.

**The live damaging case.** A root-workdir parent story edits `package.json`. `US-004` at `packages/api` unions it into `contextFiles` (`builder.ts:245`); `toPackageFrameFiles` at `:294` returns it unchanged; `path.resolve("/repo/packages/api", "package.json")` **exists**, passes the `exists()` gate at `:309`, and is injected as authoritative parent context. The agent reasons from the wrong manifest. No warning.

A sibling-package path instead vanishes with one `logger.warn("context", "Relevant file not found")` at `:327`.

And because the reframe at `:294` precedes the `slice(0, FILE_INJECTION_MAX_FILES)` at `:301` (`FILE_INJECTION_MAX_FILES = 5`, `builder.ts:36`), **each bad path evicts a correct file** from the five available slots. A story whose parent touched three root files can lose 3/5 of its file context.

The producer side is fine: `captureOutputFiles` (`src/utils/git.ts:484-501`) emits repo-framed paths, and its only production call site (`src/execution/pipeline-result-handler.ts:211`) passes a correct `storyPackageDir` pathspec.

## The disambiguation problem — read before writing code

The passthrough is not simply a bug. Its docblock claims it serves "paths already in the package frame (pre-canonicalization PRDs)", and that concern is **real and genuinely ambiguous**: for `workdir = packages/api`, the entry `src/client.ts` is either a legacy package-relative path (passthrough correct) or a repo-root file (passthrough catastrophic). Nothing in the string distinguishes them.

**The disambiguator is `workdirSource`.** `canonicalizePrdWorkdirs` (`src/prd/workdir-canonical.ts:168-174`) stamps it on **every** story it canonicalizes, unconditionally:

- `workdirSource` present ⇒ the PRD went through the write seam ⇒ paths are provably repo-rooted ⇒ a `toPackageFrame` miss means genuinely out-of-package, and the passthrough is **wrong**.
- `workdirSource` absent ⇒ pre-#2067 PRD ⇒ paths may be package-relative ⇒ preserve today's passthrough.

Decidable, testable without fixtures, and it ages out on its own as old PRDs drain.

## Why partition rather than mark

An earlier draft of this plan had `toPackageFrameFiles` append `UNREADABLE_MARKER` and the builder then detect and drop marked entries. That is string-sniffing: the builder would have to re-parse a suffix that `stripUnreadableMarker` exists precisely to manage, and `code-neighbor-chunk.ts:145-150` already documents what goes wrong when a marker leaks into a path used as an identity key.

Return the classification instead of encoding it in the string. Callers that want the marker (prompt rendering) can still apply it; callers that want to drop (file injection) just use the other list.

## Files

- Modify: `src/utils/path-frame.ts` — add `partitionPackageFrame`. Keep `toPackageFrameFiles` untouched; PR 2 decides its fate.
- Modify: `src/context/builder.ts:294-301`
- Test: `test/unit/utils/path-frame.test.ts` (152 lines, room to grow)
- Test: `test/unit/context/builder-parent-frame.test.ts` (new)

**Explicitly out of scope for this PR:** `src/pipeline/stages/context.ts:131` and `src/context/engine/stage-assembler.ts:236`. They build `ContextRequest.touchedFiles`, which `git-history.ts:109` and `code-neighbor.ts:390` feed to git pathspecs and glob inputs. Changing their framing here would push classification into strings that become shell arguments. PR 2 settles that frame properly.

## Interfaces

- **Produces:** `partitionPackageFrame(files: readonly string[], workdir: string | null | undefined, opts?: { readonly canonical?: boolean }): { readable: string[]; unreachable: string[] }`
  - `readable` — paths spelled for a consumer contained at `workdir`.
  - `unreachable` — paths that are **not** under `workdir`, left repo-rooted. Empty unless `canonical` is true.
  - With `canonical: false` (the default) every input lands in `readable`, reproducing today's behaviour exactly.

---

- [ ] **Step 1: Write the failing SSOT tests**

Append to `test/unit/utils/path-frame.test.ts` (it already imports from `@/utils/path-frame`; add `partitionPackageFrame` to that import):

```ts
describe("partitionPackageFrame (nax#2089)", () => {
  test("re-spells an in-package path into readable", () => {
    expect(partitionPackageFrame(["packages/api/src/client.ts"], "packages/api", { canonical: true }))
      .toEqual({ readable: ["src/client.ts"], unreachable: [] });
  });

  test("routes a repo-root path to unreachable instead of emitting a wrong path", () => {
    expect(partitionPackageFrame(["package.json"], "packages/api", { canonical: true }))
      .toEqual({ readable: [], unreachable: ["package.json"] });
  });

  test("routes a sibling-package path to unreachable", () => {
    expect(partitionPackageFrame(["packages/web/src/x.ts"], "packages/api", { canonical: true }))
      .toEqual({ readable: [], unreachable: ["packages/web/src/x.ts"] });
  });

  test("preserves input order within readable", () => {
    expect(
      partitionPackageFrame(
        ["packages/api/b.ts", "package.json", "packages/api/a.ts"],
        "packages/api",
        { canonical: true },
      ),
    ).toEqual({ readable: ["b.ts", "a.ts"], unreachable: ["package.json"] });
  });

  test("root workdir is identity and never routes to unreachable", () => {
    expect(partitionPackageFrame(["package.json"], ".", { canonical: true }))
      .toEqual({ readable: ["package.json"], unreachable: [] });
  });

  test("non-canonical mode keeps the legacy passthrough", () => {
    expect(partitionPackageFrame(["package.json"], "packages/api"))
      .toEqual({ readable: ["package.json"], unreachable: [] });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test test/unit/utils/path-frame.test.ts`
Expected: FAIL — `partitionPackageFrame` is not exported.

- [ ] **Step 3: Implement `partitionPackageFrame`**

Add to `src/utils/path-frame.ts`, immediately after `toPackageFrame`:

```ts
/**
 * Split a declared-path list into what a package-contained consumer can read
 * and what it cannot.
 *
 * `canonical: true` asserts the caller's paths came through the plan-time write
 * seam (story.workdirSource is stamped, src/prd/workdir-canonical.ts), so they
 * are provably repo-rooted. A toPackageFrame miss is then a REAL out-of-package
 * path and goes to `unreachable` rather than being passed through -- passing it
 * through emitted a path that resolved to a real but WRONG file under the
 * consumer's root (nax#2089), exactly what toPackageFrame's docblock forbids.
 *
 * Without the flag every entry lands in `readable` unchanged: a pre-#2067 PRD
 * may hold package-relative paths, and `src/x.ts` is genuinely ambiguous between
 * "already package-framed" and "a repo-root file" with no way to tell from the
 * string alone.
 *
 * The classification is RETURNED, not encoded into the strings. A caller that
 * wants the marker applies UNREADABLE_MARKER itself; a caller that wants to drop
 * uses the other list. Encoding it in the path is what splits one file into two
 * identities downstream (see providers/code-neighbor-chunk.ts).
 */
export function partitionPackageFrame(
  files: readonly string[],
  workdir: string | null | undefined,
  opts?: { readonly canonical?: boolean },
): { readable: string[]; unreachable: string[] } {
  const readable: string[] = [];
  const unreachable: string[] = [];
  for (const file of files) {
    const framed = toPackageFrame(file, workdir);
    if (framed !== null) {
      readable.push(framed);
    } else if (opts?.canonical) {
      unreachable.push(file);
    } else {
      readable.push(file);
    }
  }
  return { readable, unreachable };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `bun test test/unit/utils/path-frame.test.ts`
Expected: PASS — the six new cases plus every pre-existing one.

- [ ] **Step 5: Write the failing consumer test**

Create `test/unit/context/builder-parent-frame.test.ts`.

**Read `src/context/builder.ts:237-330` and an existing `test/unit/context/` suite first** and match their fixture style — the builder needs a story, a parent story with `outputFiles`, and a temp dir with real files on disk (the `exists()` gate at `:309` is a real `Bun.file().exists()`).

Fixture: consuming story `workdir: "packages/api"`, `workdirSource: "stated"`, parent `outputFiles: ["package.json", "packages/web/src/x.ts", "packages/api/src/client.ts"]`. Create real files at `<tmp>/package.json`, `<tmp>/packages/api/package.json` (**with distinguishable contents**), `<tmp>/packages/api/src/client.ts`.

Three assertions:

1. **The in-package case still works** — `src/client.ts` is injected. This is #2081's fix; regressing it fails the PR.
2. **The wrong file is not injected** — no injected element carries the contents of `<tmp>/packages/api/package.json`. Assert on *contents*, not on the path string: the defect is that a real file is read under a path that names a different file.
3. **Unreachable paths do not consume slots** — give the story six in-package context files plus the three parent outputs, and assert all five injected elements are in-package files.

- [ ] **Step 6: Run it and confirm it fails**

Run: `bun test test/unit/context/builder-parent-frame.test.ts`
Expected: FAIL on assertion 2 — the package's own `package.json` is injected.

- [ ] **Step 7: Migrate `src/context/builder.ts`**

At `:294-295`, replace the two `toPackageFrameFiles` calls:

```ts
const canonical = story.workdirSource !== undefined;
const { readable: framedContextFiles, unreachable } = partitionPackageFrame(
  contextFiles,
  storyWorkdir(story),
  { canonical },
);
const { readable: framedExpectedFiles } = partitionPackageFrame(expectedFiles, storyWorkdir(story), { canonical });
```

`framedContextFiles` now carries only reachable paths, so the existing `slice(0, FILE_INJECTION_MAX_FILES)` at `:301` no longer spends slots on guaranteed misses. **No further change to the slice is needed** — the partition happens before it.

Then log the dropped set **once**, not per file:

```ts
if (unreachable.length > 0) {
  getLogger().warn("context", "Parent context files outside this story's package were dropped", {
    storyId: story.id,
    count: unreachable.length,
    files: unreachable.slice(0, 5),
  });
}
```

The current silence is half the defect: case (iii) produced no diagnostic at all.

- [ ] **Step 8: Run and confirm pass**

Run: `bun test test/unit/context/`
Expected: PASS.

If a pre-existing builder test fails, read it before touching it. A test asserting the **old passthrough** encodes the bug and its expectation should move. A test asserting the **in-package** case is #2081's fix and must stay green. Do not update a snapshot without reading the diff.

- [ ] **Step 9: Confirm nothing else changed frame**

Run: `grep -rn "toPackageFrameFiles" src/`
Expected: exactly three hits — `path-frame.ts` (the definition), `pipeline/stages/context.ts:131`, `context/engine/stage-assembler.ts:236`. Those two are PR 2's, deliberately untouched here. If `builder.ts` still appears, Step 7 is incomplete.

- [ ] **Step 10: Full gate, then commit**

```bash
bun run typecheck && bun run lint && bun run test && bun run test:coverage
```

Paste the output. Then:

```bash
git add src/utils/path-frame.ts src/context/builder.ts \
        test/unit/utils/path-frame.test.ts test/unit/context/builder-parent-frame.test.ts
git commit -m "fix(context): drop out-of-package parent files instead of injecting a wrong file (#2089)"
```

---

## PR body

Include these lines so the issue closes on merge:

```
Closes #2089
```

Also record in the body:

- **What the fix is:** `toPackageFrameFiles`'s `?? file` passthrough emitted a path that resolved to a real but WRONG file under the consumer's root — the exact outcome `toPackageFrame`'s docblock tells callers to avoid. `partitionPackageFrame` returns the classification instead of encoding it in the string.
- **Scope note:** `toPackageFrameFiles` is deliberately left in place with its two remaining call sites (`pipeline/stages/context.ts`, `context/engine/stage-assembler.ts`). Those build `ContextRequest.touchedFiles`, which becomes git pathspecs and glob inputs; PR 2 settles that frame. Say so, or a reviewer will ask why the helper was not simply fixed.
- **Any moved test expectations**, naming each one and why the old expectation encoded the bug.

---

## Done when

- A repo-root parent output no longer resolves to the consuming package's same-named file.
- Out-of-package paths no longer consume file-injection slots.
- The drop is logged once with a count.
- `toPackageFrameFiles` is untouched and still has exactly two call sites, both owned by PR 2.
