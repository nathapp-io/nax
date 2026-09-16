# PR 3 — The plan write seam (#2086, #2085)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop `nax plan` drawing spurious blockers on every monorepo story, and stop `modifiedFiles` reaching the agent in a frame its file tools cannot address.

**Architecture:** Give the pre-write verifier a both-frame existence probe (reusing the one the write seam already has), and re-spell `modifiedFiles` at the prompt boundary rather than disturbing the deliberate fidelity-before-canonicalization order.

**Spec:** `docs/superpowers/specs/2026-09-16-path-frame-convention-design.md` (seam 3's plan-time half). **Overview:** [`00-overview.md`](./00-overview.md) — read its Global Constraints first.

**Base:** `main` @ `71071a035`.

**Independent** — no dependency on other PRs in this bundle.

---

## Global Constraints

See [`00-overview.md`](./00-overview.md#global-constraints). The ones that bite here:

- Never read `story.workdir` raw — use `storyWorkdir(story)`. `check:story-workdir-access` enforces it, and `src/prd/workdir-canonical.ts` is one of only four `ALLOWED` files.
- Bun-native only. `bun run typecheck && bun run lint && bun run test` green before every commit, plus `bun run test:coverage`.

---

## Part A — #2086: `checkFilesExist` joins package-relative paths onto the repo root

### The defect

```ts
// src/debate/verifiers/checks.ts:26-27
const absPath = join(workdir, filePath);
if (existsSync(absPath)) continue;
```

There is no `story.workdir` awareness anywhere in the file, though the loop at `:21-24` already iterates `prd.userStories` → `story.contextFiles`, so the story is in hand.

Both call sites run **strictly before** the PRD is written, so #2067's canonicalization (which happens at `finalizeAndWritePrd`) has not run and `filePath` is whatever the planner emitted — for a monorepo story, typically package-relative:

| Call site | `workdir` passed | Established by |
|---|---|---|
| `src/plan/critic.ts:64` | repo root | `src/cli/plan-command.ts:238`, the same value passed as `repoRoot:` to `finalizeAndWritePrd` at `:263` |
| `src/debate/verifiers/plan-checklist.ts:94` | repo root | `ctx.workdir`, the same value used for `join(ctx.workdir, ".nax", "runs", ...)` at `:74` |

Ordering is explicit in `plan-command.ts`: the critic runs at `:236-247`, and only on `verdict.outcome === "passed"` (`:249`) does `:254` reach `finalizeAndWritePrd`.

### Consequence

Every `contextFiles` entry of every non-root story fails the probe:

- **uncited** → a spurious `major` (`checks.ts:44-50`) telling the planner to move real, existing files *out of* `contextFiles`;
- **`factId`-cited** → a spurious **`blocker`** (`:31-38`) — on exactly the entries that are best grounded.

The files exist. The frame is the only thing wrong.

### The fix is dependency-compatible — do not write a third probe

`CheckDeps` (`checks.ts:14-16`) already takes an injected `existsSync`, the same shape as `ExistsProbe` (`src/prd/workdir-canonical.ts:20`), and the real probe is injected as `_persistPrdDeps.existsSync` at `src/plan/strategies/persist-prd.ts:77`.

`canonicalizeDeclaredPath` (`workdir-canonical.ts:95-106`) is already a both-frame probe:

```ts
const alreadyRepoRooted = path === workdir || path.startsWith(`${workdir}/`);
const atPackage = exists(join(repoRoot, workdir, path));
const atRoot = exists(join(repoRoot, path));
if (atPackage) return { path: toRepoFrame(path, workdir), collided: atRoot, rootOnly: false };
return { path, collided: false, rootOnly: atRoot && !alreadyRepoRooted };
```

Reuse it.

- [ ] **A1: Write the failing test**

In **`test/unit/debate/verifiers/checks.test.ts`** — match its `existsSync` mocking style. Note `checkFilesExist` is also exercised from **`test/unit/plan/critic.test.ts`**; run both.

Four cases:
1. `workdir: "packages/api"`, `contextFiles: ["src/index.ts"]`, only `/repo/packages/api/src/index.ts` exists → **zero findings**.
2. Same, but the entry carries a `factId` → **no blocker**.
3. A genuinely missing file (`neither` frame resolves) → the `major` **still fires**. The check must not be defanged into uselessness.
4. A root story (`workdir` absent / `"."`) with a real repo-root file → zero findings, unchanged behaviour.

- [ ] **A2: Run, confirm failure**

Expected: case 1 draws a `major`, case 2 draws a `blocker`.

- [ ] **A3: Implement**

Pass `storyWorkdir(story)` into the per-path probe and resolve via `canonicalizeDeclaredPath`, treating "resolves in either frame" as existing. `checks.ts` is at 142 lines; ample room.

Import from the `@/prd` barrel, not the internal path.

- [ ] **A4: Run, confirm pass**

Run: `bun test test/unit/debate/ test/unit/plan/`
Expected: PASS. A pre-existing test asserting the spurious `major` encodes the bug — move its expectation, and say so in the PR body.

---

## Part B — #2085: `modifiedFiles` is never canonicalized

### The defect

`canonicalizePrdWorkdirs` (`src/prd/workdir-canonical.ts:163-174`) re-spells `contextFiles` and `expectedFiles` only. `modifiedFiles` rides through untouched inside `...rest` at `:141` — the word does not appear in the file.

### The ordering constraint is real and documented in the same function

`src/plan/strategies/persist-prd.ts:61-77`:

```ts
// Fidelity runs BEFORE canonicalization. ...
const repaired = applyPlanFidelity(args.prd, args.specContent, args.featureName);
...
const result = canonicalizePrdWorkdirs(repaired, args.repoRoot, packages, _persistPrdDeps.existsSync);
```

`applyModifiedFiles` (`src/prd/modifies.ts:86`) runs inside `applyPlanFidelity` via `backfillModifiedFiles` (`src/operations/plan-fidelity.ts:72`) — and also in the plan op's verify hook (`src/operations/plan.ts:83-87`) and `plan-refine.ts:415`, all strictly earlier than persist. So entries are appended and then never re-framed.

Its own validation (`src/prd/schema-story.ts:425-450`, via `isSafeRelativePath` at `modifies.ts:50-57`) rejects absolute and `..` paths but is **frame-agnostic**: whatever the spec author wrote is what lands.

It is rendered verbatim into the implementer/rectifier/reviewer prompt by `src/prompts/sections/modified-files.ts:31-40`, reached from `src/prompts/sections/story.ts:27`.

### Consequence

One prompt can carry two frames: `contextFiles` package-relative and correct at the agent boundary, `modifiedFiles` in whatever frame the spec used. A repo-rooted entry names a path the agent's file tools — contained at `codingToolRoot` = the package dir — cannot address, so the authorisation it grants is unusable, which is the failure mode #1450 exists to prevent.

Blast radius is bounded: nothing stats or compares these paths, only prompt rendering. A fidelity defect, not a crash.

### Ruling: reframe at the prompt boundary

Smaller change; does not disturb the deliberate fidelity-before-canonicalization order; matches the convention's stated shape — one canonical frame internally, one re-spelling at the agent boundary. Canonicalizing at the write seam would require either reordering fidelity (which `persist-prd.ts:61` took a deviation to establish) or running the canonical pass twice.

### ⛔ Ruling F — `canonical` MUST NOT be used on `modifiedFiles`

**Supersedes an earlier revision of this plan, which said to pass `{ canonical: story.workdirSource !== undefined }` here. Do not do that.**

Spec **Ruling 8** (recorded when PR 1 merged): *a `toPackageFrame` miss is only "out-of-package" on a path set known to carry repo-rooted entries.* `modifiedFiles` is the opposite of such a set:

- `canonicalizePrdWorkdirs` contains **zero** references to `modifiedFiles` — verify yourself with `grep -c modifiedFiles src/prd/workdir-canonical.ts`, expect `0`. It re-spells `contextFiles` and `expectedFiles` only.
- `applyModifiedFiles` runs inside `applyPlanFidelity`, which `persist-prd.ts:61-77` deliberately orders **before** canonicalization. Entries are appended after the canonical pass has already run.

So `workdirSource` carries **no information** about this list's frame. That is the entire premise of #2085.

And the consequence of getting it wrong is worse here than in PR 1. Dropping an unresolvable `contextFiles` entry is harmless — the `exists()` gate would skip it anyway. **`modifiedFiles` is an authorization list.** Dropping or marking a legitimately package-relative entry revokes permission the spec granted, which is the failure mode #1450 exists to prevent.

**Ruled: use the default non-canonical passthrough.** `partitionPackageFrame(paths, storyWorkdir(story))` with no options — a repo-rooted in-package entry is re-spelled, everything else passes through untouched. No entry is ever dropped or marked.

This fixes the real defect (a repo-rooted entry naming a path the agent's tools cannot address) without inventing authority to delete an entry whose frame is genuinely unknown.

**Out-of-package `modifiedFiles` (e.g. `packages/web/src/x.ts` on a `packages/api` story) stays as-is and is a known residual.** It is indistinguishable from a legitimately package-relative path, and the safe failure is an unusable authorization line, not a revoked one. Note it in the PR body; do not try to solve it here.

**Confirmed feasible:** `src/prompts/sections/story.ts:7` imports `UserStory` from `@/prd/types`.

- [ ] **B1: Write the failing test**

In **`test/unit/prompts/sections/story.test.ts`**. The pure renderer has its own suite at **`test/unit/prompts/sections/modified-files.test.ts`** — it must stay green unchanged, since the frame decision goes in `story.ts`, not in the renderer.

Four cases for a `workdir: "packages/api"`, `workdirSource: "stated"` story:
1. `modifiedFiles: [{ path: "packages/api/src/x.ts" }]` → renders `src/x.ts`.
2. `modifiedFiles: [{ path: "src/x.ts" }]` on a story with **no** `workdirSource` → unchanged (legacy passthrough).
3. An out-of-package entry (`packages/web/src/x.ts`) on a canonical story → **rendered unchanged**, NOT dropped and NOT marked (Ruling F). This test is the guard against someone re-introducing the canonical drop here.
4. A root story → unchanged.

Preserve the `reason` text in every case — `modified-files.ts:31-40` renders `` `- \`${path}\` — ${reason}` `` and the reason must survive reframing.

- [ ] **B2: Run, confirm failure**

- [ ] **B3: Implement**

Reframe in `src/prompts/sections/story.ts:27`, inside `modifiedFilesLines`, before calling `buildModifiedFilesLines`. Use `partitionPackageFrame(paths, storyWorkdir(story))` — **no options object** (Ruling F above). `partitionPackageFrame` landed with PR 1 (`d95cfee2b`) and is exported from `@/utils/path-frame`.

**Keep `modified-files.ts` a pure renderer.** The frame decision belongs in the section that knows the story.

- [ ] **B4: Run, confirm pass**

Run: `bun test test/unit/prompts/`
Expected: PASS, including `sections/modified-files.test.ts` unchanged. Read any snapshot diff before accepting it.

- [ ] **B5: Full gate, then commit both parts**

```bash
bun run typecheck && bun run lint && bun run test
git commit -m "fix(plan): probe declared paths in both frames and reframe modifiedFiles at the prompt boundary (#2086, #2085)"
```

---

## PR body

Include these lines so both issues close on merge:

```
Closes #2086
Closes #2085
```

Also record in the body:

- **`persist-prd.ts` is unchanged.** The fidelity-before-canonicalization order at `:61-77` is a deliberate deviation from an earlier PR and was not disturbed — `modifiedFiles` is reframed at the prompt boundary instead. Paste `git diff src/plan/strategies/persist-prd.ts` showing it empty.
- **Any pre-existing test whose expectation moved.** A test asserting the spurious `major` encoded the bug; name it and say so explicitly rather than letting it look like a silent expectation change.
- **`src/prompts/sections/modified-files.ts` stays a pure renderer** — the frame decision lives in `story.ts`, which knows the story. Its own suite should be green unchanged.
- **Ruling F: no canonical drop on `modifiedFiles`.** Per spec Ruling 8, `workdirSource` says nothing about this list's frame — the write seam never touches it. Because it is an authorization list, dropping an entry revokes permission the spec granted. Out-of-package entries render unchanged; name that residual explicitly.

---

## Done when

- A monorepo story with real, existing package-relative `contextFiles` draws **zero** findings at plan time.
- A genuinely missing file still draws its `major`.
- `modifiedFiles` reaches the agent spelled for the root its file tools are contained at, with `reason` text intact.
- `persist-prd.ts`'s fidelity-before-canonicalization order is **unchanged** — verify with `git diff src/plan/strategies/persist-prd.ts` (expect no diff).
