# Route `nax plan --decompose` through the PRD-write seam (#2080) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `planDecomposeCommand` persist its PRD through `finalizeAndWritePrd`, so decompose-created sub-stories get `workdirSource` stamped and their declared paths re-spelled into the repo frame — without re-deriving or re-resolving anything on the stories that are already in the PRD.

**Architecture:** `finalizeAndWritePrd` (`src/plan/strategies/persist-prd.ts`) is the single seam where the #2067 workdir canonicalization runs. Decompose bypasses it with a raw `_planDeps.writeFile`. The fix is **not** "make the seam idempotent" — it is to give the seam an optional **story scope**. A scoped write applies the transformations only to the named story ids and leaves every other story as the identical object reference. Three transformations must not re-run over stories already in a partly-executed PRD, and the scope is what stops each of them: feature-level spec fidelity (decompose has no spec), workdir *derivation* (the filesystem answer changes once earlier stories have created files), and routing resolution (it overwrites `routing.agent`, which would reset an escalated story's recorded agent). Declared-path re-spelling is already idempotent but is scoped with the rest so one set governs the whole write.

**Tech Stack:** TypeScript, Bun, `bun:test`, Biome. Path alias `@/` → `src/`, `@test/` → `test/`.

**Spec:** GitHub issue [nathapp-io/nax#2080](https://github.com/nathapp-io/nax/issues/2080). Its predecessor — which built the seam this plan extends — is `docs/superpowers/plans/2026-09-16-2067-workdir-canonicalization.md`. Read both before starting.

## Global Constraints

- **Branch:** work on `feat/2080-decompose-persist-seam` (already created, worktree at `projects/nax/worktrees/nax-2080`, branched from `origin/main` @ `e0f9637ca`).
- **Test commands — use the repo scripts, never bare `bun test`.** Bare `bun test` and `bun run nax` give confident false signals in this repo.
  - Whole unit suite: `bun run test:unit`
  - One file: `bun test ./test/unit/path/to/file.test.ts --timeout=60000`
  - One test by name: `bun test ./test/unit/path/to/file.test.ts --timeout=60000 -t "substring of the test name"`
- **Gates that must be green before the final commit:** `bun run typecheck`, `bun run lint`, `bun run check:all`, `bun run test:unit`. `bun run lint` includes `check:import-cycles`, `check:file-sizes` (600-line limit on `src/`), and `check:story-workdir-access`.
- **No new files are created by this plan.** All five source/test files already exist.
- **File-size headroom is fine:** `src/plan/strategies/persist-prd.ts` is 136 lines, `src/prd/workdir-canonical.ts` is 178. Both stay far under 600.
- **Raw `story.workdir` reads are gated** by `scripts/check-story-workdir-access.ts`. `src/prd/workdir-canonical.ts` is on its `ALLOWED` list (it is the plan-time writer), so the reads this plan adds there are legal. **Do not add a raw `story.workdir` read anywhere else** — use `storyWorkdir()` / `storyPackageDir()` from `@/utils/path-frame`.
- **Test escape hatches are ratcheted at zero:** no `as unknown as`, no `as never`. Use the shared factories `makePRD`, `makeStory`, `makeNaxConfig` from `@test/helpers`.
- **Commit style:** conventional commits (`feat:`, `fix:`, `test:`, `refactor:`). No attribution trailer.

## Orientation: read these first

Before Task 1, read these four files end to end. They are small and the plan's correctness depends on them:

1. `src/prd/workdir-canonical.ts` (178 lines) — the pure derivation + re-spelling module.
2. `src/plan/strategies/persist-prd.ts` (136 lines) — the seam. Its module docblock explains why fidelity runs *before* canonicalization; that ordering must not change.
3. `src/plan/strategies/finalize-routing.ts` (48 lines).
4. `src/cli/plan-decompose.ts` (288 lines) — specifically the tail from `const subStoriesWithParent` to the end of `planDecomposeCommand`.

### Facts already verified — do not re-derive them

- `applyPlanFidelity(prd, "", feature)` is a **total no-op**: `demoteStoryScopedOutOfScope` early-returns when `extractStoryScopedOutOfScope("")` is empty, `findMissingOutOfScope` returns `[]`, and `applyModifiedFiles` extracts nothing. So skipping fidelity on a scoped write changes no behaviour for decompose, which already passes `specContent: ""` to its op. Skipping it is stated explicitly rather than relied on implicitly.
- Declared-path re-spelling is **already idempotent**: `canonicalizeDeclaredPath("packages/app/src/a.ts", "packages/app", ...)` probes `repoRoot/packages/app/packages/app/src/a.ts`, which does not exist, so it falls through unchanged, and `alreadyRepoRooted` keeps it out of `rootOnly`.
- Workdir **derivation is not** idempotent across a partially-executed PRD. That is the hazard `derive: false` closes.
- `finalizePrdRouting` preserves `initialAgent` / `initialProfileId` but **overwrites `routing.agent`** from current config — which would reset an escalated story mid-run. That is the hazard the routing `only` set closes.
- `storyPackageDir()` returns `undefined` (not `"."`) for a root story, so `mapDecomposedStoriesToUserStories` never writes a literal `"."` workdir. The omit-at-root contract holds.
- `src/cli/plan-command.ts` already imports from `../plan/strategies`, so importing `finalizeAndWritePrd` into `src/cli/plan-decompose.ts` introduces no new import cycle.

---

### Task 1: Scope and derivation control in `canonicalizePrdWorkdirs`

**Files:**
- Modify: `src/prd/workdir-canonical.ts:124-177` (the `canonicalizePrdWorkdirs` function)
- Test: `test/unit/prd/workdir-canonical.test.ts` (append a new `describe` block at the end)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export interface CanonicalizeOptions {
    readonly only?: ReadonlySet<string>;
    readonly derive?: boolean;
  }

  export function canonicalizePrdWorkdirs(
    prd: PRD,
    repoRoot: string,
    packages: readonly string[],
    exists: ExistsProbe,
    opts?: CanonicalizeOptions,
  ): { prd: PRD; collisions: string[]; defaulted: string[]; rootOnly: string[] }
  ```
  `only` absent ⇒ every story. `derive` absent ⇒ `true`. Both absent ⇒ byte-identical to today.

- [ ] **Step 1: Write the failing tests**

Append this block to the end of `test/unit/prd/workdir-canonical.test.ts`. The file already defines `REPO`, `PACKAGES` and `probeOf` at the top — reuse them, do not redefine.

```ts
describe("canonicalizePrdWorkdirs — scoped canonicalization (nax#2080)", () => {
  test("leaves a story outside `only` as the identical reference", () => {
    const untouched = makeStory({ id: "US-001", contextFiles: ["src/a.ts"] });
    const target = makeStory({ id: "US-002", contextFiles: ["src/b.ts"] });
    const prd = makePRD({ userStories: [untouched, target] });
    const exists = probeOf("packages/app/src/a.ts", "packages/app/src/b.ts");

    const { prd: out } = canonicalizePrdWorkdirs(prd, REPO, PACKAGES, exists, { only: new Set(["US-002"]) });

    // Identity, not deep equality: an untouched story must not even be respread,
    // or a caller cannot tell "we left it alone" from "we recomputed the same value".
    expect(out.userStories[0]).toBe(untouched);
    expect(out.userStories[0]?.workdirSource).toBeUndefined();
    expect(out.userStories[1]?.workdir).toBe("packages/app");
    expect(out.userStories[1]?.contextFiles).toEqual(["packages/app/src/b.ts"]);
  });

  test("does not report an out-of-scope story as defaulted", () => {
    const prd = makePRD({ userStories: [makeStory({ id: "US-001" }), makeStory({ id: "US-002" })] });

    const { defaulted } = canonicalizePrdWorkdirs(prd, REPO, PACKAGES, probeOf(), { only: new Set(["US-002"]) });

    expect(defaulted).toEqual(["US-002"]);
  });

  test("derive:false defaults an unstated story without probing the filesystem", () => {
    const prd = makePRD({ userStories: [makeStory({ id: "US-001", contextFiles: ["src/a.ts"] })] });
    const probed: string[] = [];
    const exists = (abs: string): boolean => {
      probed.push(abs);
      return true;
    };

    const { prd: out, defaulted } = canonicalizePrdWorkdirs(prd, REPO, PACKAGES, exists, { derive: false });

    expect(out.userStories[0]?.workdir).toBeUndefined();
    expect(out.userStories[0]?.workdirSource).toBe("defaulted");
    expect(defaulted).toEqual(["US-001"]);
    // Zero probes: derivation is skipped, and workdir "." short-circuits
    // canonicalizeDeclaredPath before it probes either location.
    expect(probed).toEqual([]);
  });

  test("derive:false still re-spells the paths of a story that states its workdir", () => {
    const prd = makePRD({
      userStories: [makeStory({ id: "US-001", workdir: "packages/app", contextFiles: ["src/a.ts"] })],
    });

    const { prd: out } = canonicalizePrdWorkdirs(prd, REPO, PACKAGES, probeOf("packages/app/src/a.ts"), {
      derive: false,
    });

    expect(out.userStories[0]?.workdirSource).toBe("stated");
    expect(out.userStories[0]?.contextFiles).toEqual(["packages/app/src/a.ts"]);
  });

  test("is a fixed point over an already-canonical story", () => {
    const prd = makePRD({
      userStories: [makeStory({ id: "US-001", workdir: "packages/app", contextFiles: ["src/a.ts"] })],
    });
    const exists = probeOf("packages/app/src/a.ts");

    const once = canonicalizePrdWorkdirs(prd, REPO, PACKAGES, exists).prd;
    const twice = canonicalizePrdWorkdirs(once, REPO, PACKAGES, exists).prd;

    expect(twice.userStories[0]).toEqual(once.userStories[0]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ./test/unit/prd/workdir-canonical.test.ts --timeout=60000 -t "nax#2080"`

Expected: the first four fail. `canonicalizePrdWorkdirs` takes four parameters today, so TypeScript rejects the fifth argument and the assertions on `only` / `derive` behaviour do not hold. ("is a fixed point" may already pass — that is fine, it is a regression pin for a property the implementation must not lose.)

- [ ] **Step 3: Implement the options bag**

In `src/prd/workdir-canonical.ts`:

Add `UserStory` to the type import at the bottom of the import block:

```ts
import type { PRD, UserStory, WorkdirSource } from "./types";
```

Add this interface immediately above `canonicalizePrdWorkdirs`:

```ts
/** Options for {@link canonicalizePrdWorkdirs}. Both default to today's whole-PRD behaviour. */
export interface CanonicalizeOptions {
  /**
   * Restrict canonicalization to these story ids. A story outside the set is
   * returned by IDENTITY -- not respread -- and contributes to none of the three
   * returned reports.
   *
   * `nax plan --decompose` (nax#2080) writes into a PRD whose other stories may
   * already have executed. Re-spelling their paths is harmless, but re-deciding
   * anything about them is not, and one scope for the whole write is simpler to
   * reason about than three separate guards.
   */
  readonly only?: ReadonlySet<string>;
  /**
   * Derive a workdir for a story that did not state one. Default true.
   *
   * `false` is for a caller writing into a PRD that has partly executed:
   * derivation reads the filesystem, and the answer changes once earlier stories
   * have created files, so a story that legitimately defaulted at plan time would
   * silently acquire a package. A sub-story inherits its parent's workdir
   * (ADR-025: decompose inherits, it does not re-select), so there is nothing
   * left for derivation to decide there anyway.
   */
  readonly derive?: boolean;
}
```

Then change the function signature and body. Replace the existing `const userStories = prd.userStories.map((story) => { ... })` header and the workdir decision with the version below; everything from `const reframe = ...` onward is unchanged.

```ts
export function canonicalizePrdWorkdirs(
  prd: PRD,
  repoRoot: string,
  packages: readonly string[],
  exists: ExistsProbe,
  opts?: CanonicalizeOptions,
): { prd: PRD; collisions: string[]; defaulted: string[]; rootOnly: string[] } {
  const collisions: string[] = [];
  const defaulted: string[] = [];
  const rootOnly: string[] = [];
  const deriveEnabled = opts?.derive ?? true;

  // normalizeWorkdir collapses "", ".", "./" and absent to "." so a planner that
  // literally emits "." is treated as root, not as a stated package.
  const decideWorkdir = (
    story: UserStory,
    declared: readonly string[],
  ): { workdir: string; source: WorkdirSource } => {
    const statedWorkdir = normalizeWorkdir(story.workdir);
    if (statedWorkdir !== ".") return { workdir: statedWorkdir, source: "stated" };
    if (!deriveEnabled) return { workdir: ".", source: "defaulted" };
    return deriveWorkdir(declared, repoRoot, packages, exists);
  };

  const userStories = prd.userStories.map((story) => {
    if (opts?.only && !opts.only.has(story.id)) return story;

    // `workdir` is destructured off `rest` rather than left to the conditional
    // spread below: spreading `...story` would re-introduce the raw value (a
    // literal ".", "" or "./") that normalizeWorkdir collapsed, landing it in the
    // written PRD and contradicting the omit-at-root contract. The raw field is
    // still read directly -- this module is the plan-time writer -- which is why
    // it is ALLOWED in scripts/check-story-workdir-access.ts.
    const { workdir: _rawWorkdir, ...rest } = story;
    const declared = [
      ...(story.contextFiles ?? []).map((f) => (typeof f === "string" ? f : f.path)),
      ...(story.expectedFiles ?? []),
    ];

    const { workdir, source } = decideWorkdir(story, declared);
    if (source === "defaulted") defaulted.push(story.id);

    const reframe = (path: string): string => {
      const result = canonicalizeDeclaredPath(path, workdir, repoRoot, exists);
      if (result.collided) collisions.push(`${story.id}:${path}`);
      if (result.rootOnly) rootOnly.push(`${story.id}:${path}`);
      return result.path;
    };

    const contextFiles = story.contextFiles?.map((entry) =>
      typeof entry === "string" ? reframe(entry) : { ...entry, path: reframe(entry.path) },
    );
    const expectedFiles = story.expectedFiles?.map(reframe);

    return {
      ...rest,
      ...(workdir === "." ? {} : { workdir }),
      workdirSource: source,
      ...(contextFiles !== undefined ? { contextFiles } : {}),
      ...(expectedFiles !== undefined ? { expectedFiles } : {}),
    };
  });

  return { prd: { ...prd, userStories }, collisions, defaulted, rootOnly };
}
```

Also extend the function's existing docblock with one sentence before the closing `*/`:

```
 * `opts.only` restricts the whole pass to a subset of stories and `opts.derive`
 * turns derivation off; see {@link CanonicalizeOptions} for why a scoped caller
 * needs both. Omitting `opts` is the whole-PRD behaviour `nax plan` uses.
```

- [ ] **Step 4: Export the new type**

In `src/prd/index.ts`, find the existing line:

```ts
export { canonicalizeDeclaredPath, canonicalizePrdWorkdirs } from "./workdir-canonical";
```

and add the type export alongside it:

```ts
export type { CanonicalizeOptions } from "./workdir-canonical";
export { canonicalizeDeclaredPath, canonicalizePrdWorkdirs } from "./workdir-canonical";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test ./test/unit/prd/workdir-canonical.test.ts --timeout=60000`
Expected: PASS, whole file — the pre-existing tests in it are the no-`opts` regression suite and must stay green.

- [ ] **Step 6: Commit**

```bash
git add src/prd/workdir-canonical.ts src/prd/index.ts test/unit/prd/workdir-canonical.test.ts
git commit -m "feat(prd): scope and derivation options for canonicalizePrdWorkdirs (#2080)"
```

---

### Task 2: Scope in `finalizePrdRouting`

**Files:**
- Modify: `src/plan/strategies/finalize-routing.ts:12-19` (signature) and `:20` (the map body)
- Test: `test/unit/plan/strategies/finalize-routing.test.ts` (append two tests to the existing `describe`)

**Interfaces:**
- Consumes: nothing from Task 1 (independent).
- Produces:
  ```ts
  export function finalizePrdRouting(
    prd: PRD,
    agentRouting: AgentRoutingConfig | undefined,
    profileName: string | undefined,
    models: ModelsConfig,
    defaultAgent: string,
    only?: ReadonlySet<string>,
  ): PRD
  ```
  A sixth **optional positional** parameter; all five existing call sites and tests are unaffected. `routingProfile` is stamped at PRD root regardless of `only`.

- [ ] **Step 1: Write the failing tests**

Append these two tests inside the existing `describe("finalizePrdRouting", ...)` block in `test/unit/plan/strategies/finalize-routing.test.ts`. The file already defines `models`, `agentRouting` and `prdWith` — reuse them.

```ts
  test("leaves a story outside `only` as the identical reference (nax#2080)", () => {
    const input = prdWith({ agentProfileId: "claude-final" });
    const untouched = input.userStories[0];

    const out = finalizePrdRouting(input, agentRouting, "cross-agent", models, "claude", new Set(["US-999"]));

    expect(out.userStories[0]).toBe(untouched);
    expect(out.userStories[0].routing?.agent).toBeUndefined();
    // The PRD-root stamp is not story-scoped.
    expect(out.routingProfile).toBe("cross-agent");
  });

  test("resolves a story that IS in `only` (nax#2080)", () => {
    const out = finalizePrdRouting(
      prdWith({ agentProfileId: "claude-final" }),
      agentRouting,
      "cross-agent",
      models,
      "claude",
      new Set(["US-001"]),
    );

    expect(out.userStories[0].routing?.agent).toBe("claude");
    expect(out.userStories[0].routing?.initialProfileId).toBe("claude-final");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ./test/unit/plan/strategies/finalize-routing.test.ts --timeout=60000 -t "nax#2080"`
Expected: FAIL — `finalizePrdRouting` takes five parameters today, so TypeScript rejects the sixth argument.

- [ ] **Step 3: Implement**

In `src/plan/strategies/finalize-routing.ts`, add the parameter and the guard:

```ts
export function finalizePrdRouting(
  prd: PRD,
  agentRouting: AgentRoutingConfig | undefined,
  profileName: string | undefined,
  models: ModelsConfig,
  defaultAgent: string,
  only?: ReadonlySet<string>,
): PRD {
  const userStories = prd.userStories.map((story) => {
    // nax#2080: a scoped write (decompose) adds stories to a PRD that may already
    // be executing. Re-resolving an existing story would overwrite `routing.agent`
    // from current config, resetting an escalated story's recorded agent back to
    // its profile default -- `initialAgent` is sticky, but `agent` is not.
    if (only && !only.has(story.id)) return story;

    const assignment = resolveAgentAssignment(
```

Leave the rest of the body and the final `return { ...prd, userStories, routingProfile: profileName ?? "default" };` unchanged.

Extend the docblock with:

```
 * `only`, when given, restricts resolution to those story ids; every other story
 * is returned by identity. `routingProfile` is stamped regardless -- it is a PRD
 * property, not a story one.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test ./test/unit/plan/strategies/finalize-routing.test.ts --timeout=60000`
Expected: PASS, whole file.

- [ ] **Step 5: Commit**

```bash
git add src/plan/strategies/finalize-routing.ts test/unit/plan/strategies/finalize-routing.test.ts
git commit -m "feat(plan): optional story scope for finalizePrdRouting (#2080)"
```

---

### Task 3: `scope` on the write seam

**Files:**
- Modify: `src/plan/strategies/persist-prd.ts` — `PersistPrdArgs` (around `:38-56`) and `finalizeAndWritePrd` (around `:60-119`)
- Test: `test/unit/plan/strategies/persist-prd-workdir.test.ts` (append a new `describe` at the end)

**Interfaces:**
- Consumes: `CanonicalizeOptions` from Task 1, the sixth parameter of `finalizePrdRouting` from Task 2.
- Produces: `PersistPrdArgs.scope?: ReadonlySet<string>`. When present, `finalizeAndWritePrd` skips `applyPlanFidelity` entirely, passes `{ only: scope, derive: false }` to `canonicalizePrdWorkdirs`, and passes `scope` to `finalizePrdRouting`. When absent, behaviour is unchanged. `persistPrd(ctx, prd)` never sets it.

- [ ] **Step 1: Write the failing tests**

Append this block to the end of `test/unit/plan/strategies/persist-prd-workdir.test.ts`. The file already defines `MODELS`, `makePrd()`, `captureWarnings()` and the `_persistPrdDeps` save/restore hooks — reuse them. Widen the existing config type import at the top of the file:

```ts
import type { AgentRoutingConfig, ModelsConfig } from "@/config";
```

```ts
describe("finalizeAndWritePrd — scoped write (nax#2080)", () => {
  /** A PRD shaped like the one decompose hands the seam: one executed story, one fresh sub-story. */
  function makeMixedPrd(): PRD {
    return makePRD({
      userStories: [
        makeStory({
          id: "US-001",
          status: "decomposed",
          workdir: "packages/app",
          workdirSource: "stated",
          contextFiles: ["packages/app/src/a.ts"],
          routing: {
            complexity: "medium",
            testStrategy: "tdd-simple",
            reasoning: "r",
            agent: "opencode",
            initialAgent: "claude",
          },
        }),
        makeStory({
          id: "US-001-A",
          parentStoryId: "US-001",
          workdir: "packages/app",
          contextFiles: ["src/b.ts"],
        }),
      ],
    });
  }

  /**
   * An ENABLED routing config with a real profile. Required, not decoration:
   * `resolveAgentAssignment` returns null the moment `enabled !== true` or
   * `profiles` is empty (src/agents/shared/agent-profile-resolver.ts:23-26), so
   * with routing off the "executed story keeps its agent" assertion below would
   * pass even without the `only` guard -- a test that cannot fail.
   */
  const ROUTING: AgentRoutingConfig = {
    enabled: true,
    strategy: "off",
    default: "claude-default",
    profiles: [{ id: "claude-default", target: { agent: "claude", model: "balanced" }, strengths: ["design"] }],
  };

  async function persistScoped(prd: PRD, scope: ReadonlySet<string>): Promise<PRD> {
    let written = "";
    await finalizeAndWritePrd({
      prd,
      specContent: "",
      featureName: "f",
      projectName: "p",
      agentRouting: ROUTING,
      profileName: undefined,
      models: MODELS,
      defaultAgent: "claude",
      outputPath: "/repo/.nax/features/f/prd.json",
      repoRoot: "/repo",
      scope,
      writeFile: async (_path, content) => {
        written = content;
      },
    });
    return JSON.parse(written) as PRD;
  }

  test("canonicalizes the scoped sub-story and leaves the executed story alone", async () => {
    _persistPrdDeps.discoverWorkspacePackages = async () => ["packages/app"];
    _persistPrdDeps.existsSync = (p: string) => p === "/repo/packages/app/src/b.ts";

    const parsed = await persistScoped(makeMixedPrd(), new Set(["US-001-A"]));

    const sub = parsed.userStories.find((s) => s.id === "US-001-A");
    expect(sub?.workdirSource).toBe("stated");
    expect(sub?.contextFiles).toEqual(["packages/app/src/b.ts"]);

    const parent = parsed.userStories.find((s) => s.id === "US-001");
    expect(parent?.status).toBe("decomposed");
    expect(parent?.contextFiles).toEqual(["packages/app/src/a.ts"]);
    // The executed story's recorded agent survives: re-resolution would reset it
    // to ROUTING's "claude". initialAgent is sticky either way, so `agent` is the
    // only field that proves the guard fired.
    expect(parent?.routing?.agent).toBe("opencode");
    expect(parent?.routing?.initialAgent).toBe("claude");
    // Positive control: the SCOPED story IS resolved, so the assertion above is
    // about the scope, not about routing being inert.
    expect(sub?.routing?.agent).toBe("claude");
  });

  test("does not re-derive a workdir for a story the repo has since grown a file for", async () => {
    // The probe says every path resolves under packages/app -- exactly the state a
    // partially-executed repo reaches. With derive off, the sub-story still defaults.
    _persistPrdDeps.discoverWorkspacePackages = async () => ["packages/app"];
    _persistPrdDeps.existsSync = () => true;

    const prd = makePRD({
      userStories: [makeStory({ id: "US-001-A", contextFiles: ["src/b.ts"] })],
    });
    const parsed = await persistScoped(prd, new Set(["US-001-A"]));

    expect(parsed.userStories[0]?.workdir).toBeUndefined();
    expect(parsed.userStories[0]?.workdirSource).toBe("defaulted");
    expect(parsed.userStories[0]?.contextFiles).toEqual(["src/b.ts"]);
  });

  test("skips fidelity entirely on a scoped write", async () => {
    _persistPrdDeps.discoverWorkspacePackages = async () => [];
    _persistPrdDeps.existsSync = () => false;

    // A spec whose out-of-scope statement the PRD does not carry. An unscoped write
    // backfills it and warns; a scoped write must not touch feature-level fields.
    const spec = ["## Out of scope", "", "- Rewriting the scheduler"].join("\n");
    let written = "";
    const cap = captureWarnings();
    try {
      await finalizeAndWritePrd({
        prd: makePRD({ userStories: [makeStory({ id: "US-001-A" })] }),
        specContent: spec,
        featureName: "f",
        projectName: "p",
        agentRouting: undefined,
        profileName: undefined,
        models: MODELS,
        defaultAgent: "claude",
        outputPath: "/repo/.nax/features/f/prd.json",
        repoRoot: "/repo",
        scope: new Set(["US-001-A"]),
        writeFile: async (_path, content) => {
          written = content;
        },
      });
    } finally {
      cap.restore();
    }

    const parsed: PRD = JSON.parse(written);
    expect(parsed.outOfScope ?? []).toEqual([]);
    expect(cap.calls.some((c) => c.message.includes("backfilled verbatim"))).toBe(false);
  });

  test("still stamps project and routingProfile on a scoped write", async () => {
    _persistPrdDeps.discoverWorkspacePackages = async () => [];
    _persistPrdDeps.existsSync = () => false;

    let written = "";
    await finalizeAndWritePrd({
      prd: makePRD({ userStories: [makeStory({ id: "US-001-A" })] }),
      specContent: "",
      featureName: "f",
      projectName: "decompose-project",
      agentRouting: undefined,
      profileName: "cross-agent",
      models: MODELS,
      defaultAgent: "claude",
      outputPath: "/repo/.nax/features/f/prd.json",
      repoRoot: "/repo",
      scope: new Set(["US-001-A"]),
      writeFile: async (_path, content) => {
        written = content;
      },
    });

    const parsed: PRD = JSON.parse(written);
    expect(parsed.project).toBe("decompose-project");
    expect(parsed.routingProfile).toBe("cross-agent");
  });
});
```

> If `makePRD` / `makeStory` do not accept `workdirSource` or `parentStoryId` in their `Partial<>` overrides, that is a type error to fix by widening nothing — both are real optional fields on `UserStory` (`src/prd/types.ts:257` for `workdirSource`), so `Partial<UserStory>` already covers them. If `outOfScope` does not default to `[]` on `makePRD`, the `expect(parsed.outOfScope ?? []).toEqual([])` form above already tolerates `undefined`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ./test/unit/plan/strategies/persist-prd-workdir.test.ts --timeout=60000 -t "nax#2080"`
Expected: FAIL — `scope` is not a property of `PersistPrdArgs`, so TypeScript rejects the object literal.

- [ ] **Step 3: Implement**

In `src/plan/strategies/persist-prd.ts`, add to `PersistPrdArgs`, immediately after the `repoRoot` field:

```ts
  /**
   * Restrict every transformation to these story ids (nax#2080).
   *
   * Set by a caller that ADDS stories to an existing PRD -- today only
   * `nax plan --decompose`. Absent for `nax plan`, which owns the whole PRD.
   */
  readonly scope?: ReadonlySet<string>;
```

In `finalizeAndWritePrd`, replace the fidelity line:

```ts
  const repaired = applyPlanFidelity(args.prd, args.specContent, args.featureName);
```

with:

```ts
  // nax#2080: fidelity is a FEATURE-level repair keyed on the spec -- it backfills
  // `prd.outOfScope` and attaches `### Modifies` entries by story id. A scoped
  // caller has neither: decompose runs with no spec content, and its sub-story ids
  // are new, so every spec entry would orphan-warn. The parent PRD's fidelity was
  // already applied at plan time; re-running it here would only risk re-deciding
  // feature-level fields on a PRD that has started executing.
  const repaired = args.scope ? args.prd : applyPlanFidelity(args.prd, args.specContent, args.featureName);
```

Replace the canonicalization call:

```ts
    const result = canonicalizePrdWorkdirs(repaired, args.repoRoot, packages, _persistPrdDeps.existsSync);
```

with:

```ts
    // nax#2080: a scoped write turns DERIVATION off as well as narrowing the story
    // set. Path re-spelling is idempotent, but derivation reads the filesystem, and
    // once earlier stories have created files a story that legitimately defaulted at
    // plan time would silently acquire a package. A sub-story inherits its parent's
    // workdir (ADR-025), so there is nothing for derivation to decide.
    const result = canonicalizePrdWorkdirs(repaired, args.repoRoot, packages, _persistPrdDeps.existsSync, {
      only: args.scope,
      derive: args.scope === undefined,
    });
```

Replace the routing call:

```ts
  const finalized = finalizePrdRouting(
    { ...canonical, project: args.projectName },
    args.agentRouting,
    args.profileName,
    args.models,
    args.defaultAgent,
  );
```

with:

```ts
  const finalized = finalizePrdRouting(
    { ...canonical, project: args.projectName },
    args.agentRouting,
    args.profileName,
    args.models,
    args.defaultAgent,
    args.scope,
  );
```

Finally, extend the module docblock at the top of the file with a paragraph after the existing one:

```
 * nax#2080 adds `scope`: a caller that ADDS stories to an existing PRD names them,
 * and every transformation applies only to those. Not an idempotency knob -- two of
 * the three transformations (workdir derivation, routing resolution) are
 * deliberately NOT safe to re-run over a PRD that has started executing, so the
 * scope is what stops them rather than a fixed-point property of each.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test ./test/unit/plan/strategies/persist-prd-workdir.test.ts --timeout=60000`
Expected: PASS, whole file — the pre-existing unscoped tests are the regression suite for the `scope`-absent path.

- [ ] **Step 5: Verify no unscoped caller changed behaviour**

Run: `bun test ./test/unit/plan/ --timeout=60000`
Expected: PASS. If anything here fails, the `scope`-absent path is not byte-identical — fix that rather than the test.

- [ ] **Step 6: Commit**

```bash
git add src/plan/strategies/persist-prd.ts test/unit/plan/strategies/persist-prd-workdir.test.ts
git commit -m "feat(plan): scoped writes through finalizeAndWritePrd (#2080)"
```

---

### Task 4: Route `planDecomposeCommand` through the seam

**Files:**
- Modify: `src/cli/plan-decompose.ts` — the import block and the tail of `planDecomposeCommand` (the `updatedPrd` / `writeFile` block, around `:196-207`)
- Test: `test/unit/cli/plan-decompose-writeback.test.ts` (append a new `describe` at the end)

**Interfaces:**
- Consumes: `PersistPrdArgs.scope` from Task 3.
- Produces: no new exports. `planDecomposeCommand`'s signature and return value are unchanged; only the write path changes.

- [ ] **Step 1: Write the failing tests**

Append this block to the end of `test/unit/cli/plan-decompose-writeback.test.ts`. It reuses the file's existing `FEATURE`, `makePrd`, `makeSubStory`, `toDecomposedStory`, `makeMockDecomposeManager` and `_planDeps` save/restore. **The seam reads `_persistPrdDeps`, not `_planDeps`** — stub both.

```ts
describe("planDecomposeCommand — writes through the plan-write seam (nax#2080)", () => {
  let tmpDir: string;
  let capturedWriteArgs: Array<[string, string]>;
  let origPersistExistsSync: typeof _persistPrdDeps.existsSync;
  let origPersistDiscover: typeof _persistPrdDeps.discoverWorkspacePackages;

  beforeEach(async () => {
    tmpDir = makeTempDir("nax-decompose-seam-");
    capturedWriteArgs = [];
    await mkdir(join(tmpDir, ".nax", "features", FEATURE), { recursive: true });
    origPersistExistsSync = _persistPrdDeps.existsSync;
    origPersistDiscover = _persistPrdDeps.discoverWorkspacePackages;
  });

  afterEach(() => {
    mock.restore();
    _planDeps.readFile = origReadFile;
    _planDeps.writeFile = origWriteFile;
    _planDeps.scanSourceRoots = origScanSourceRoots;
    _planDeps.createRuntime = origCreateRuntime;
    _planDeps.existsSync = origExistsSync;
    _planDeps.createDebateRunner = origCreateDebateRunner;
    _planDeps.discoverWorkspacePackages = origDiscoverWorkspacePackages;
    _planDeps.readPackageJson = origReadPackageJson;
    _planDeps.readPackageJsonAt = origReadPackageJsonAt;
    _planDeps.spawnSync = origSpawnSync;
    _planDeps.mkdirp = origMkdirp;
    _persistPrdDeps.existsSync = origPersistExistsSync;
    _persistPrdDeps.discoverWorkspacePackages = origPersistDiscover;
    cleanupTempDir(tmpDir);
  });

  function setup(prd: PRD, stories: UserStory[]) {
    const prdPath = join(tmpDir, ".nax", "features", FEATURE, "prd.json");
    _planDeps.existsSync = mock((path: string) => path === prdPath);
    _planDeps.readFile = mock(async (path: string) => (path === prdPath ? JSON.stringify(prd) : ""));
    _planDeps.writeFile = mock(async (path: string, content: string) => {
      capturedWriteArgs.push([path, content]);
    });
    _planDeps.scanSourceRoots = mock(async () => []);
    _planDeps.discoverWorkspacePackages = mock(async () => []);
    _planDeps.readPackageJson = mock(async () => ({ name: "test-project" }));
    _planDeps.readPackageJsonAt = mock(async () => null);
    _planDeps.spawnSync = mock(() => ({ stdout: Buffer.from(""), exitCode: 1 }));
    _planDeps.mkdirp = mock(async () => {});
    _planDeps.createRuntime = mock(() =>
      makeMockRuntime({
        agentManager: makeMockDecomposeManager(async () => ({ stories: stories.map(toDecomposedStory) })),
      }),
    );
    return prdPath;
  }

  test("stamps workdirSource and repo-frames the sub-story's contextFiles", async () => {
    const parent = makeStory({ id: "US-001", workdir: "packages/app", workdirSource: "stated" });
    setup(makePrd([parent]), [makeSubStory("US-001-A", { contextFiles: ["src/foo.ts"] })]);

    _persistPrdDeps.discoverWorkspacePackages = async () => ["packages/app"];
    _persistPrdDeps.existsSync = (p: string) => p === join(tmpDir, "packages/app/src/foo.ts");

    await planDecomposeCommand(tmpDir, makeNaxConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    const sub = written.userStories.find((s) => s.id === "US-001-A");
    assertDefined(sub, "sub-story US-001-A");
    expect(sub.workdir).toBe("packages/app");
    expect(sub.workdirSource).toBe("stated");
    expect(getContextFiles(sub)).toEqual(["packages/app/src/foo.ts"]);
  });

  /**
   * `makeNaxConfig()` ships `routing.agents = { enabled: true, strategy: "off", profiles: [] }`,
   * and `resolveAgentAssignment` returns null on an empty `profiles` list
   * (src/agents/shared/agent-profile-resolver.ts:25-26). Under that default the
   * "sibling keeps its agent" assertion below would hold with or without the scope
   * guard. A real profile is what makes it a test.
   */
  function makeRoutedConfig() {
    return makeNaxConfig({
      routing: {
        agents: {
          enabled: true,
          strategy: "off",
          default: "claude-default",
          profiles: [{ id: "claude-default", target: { agent: "claude", model: "balanced" }, strengths: ["design"] }],
        },
      },
    });
  }

  test("leaves an already-executed sibling untouched", async () => {
    const parent = makeStory({ id: "US-001" });
    const done = makeStory({
      id: "US-002",
      status: "completed",
      contextFiles: ["src/bar.ts"],
      routing: { complexity: "medium", testStrategy: "tdd-simple", reasoning: "r", agent: "opencode" },
    });
    setup(makePrd([parent, done]), [makeSubStory("US-001-A")]);

    // A probe that would happily re-frame and re-derive everything if it were asked.
    _persistPrdDeps.discoverWorkspacePackages = async () => ["packages/app"];
    _persistPrdDeps.existsSync = () => true;

    await planDecomposeCommand(tmpDir, makeRoutedConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    const sibling = written.userStories.find((s) => s.id === "US-002");
    assertDefined(sibling, "sibling US-002");
    expect(sibling.status).toBe("completed");
    expect(sibling.workdirSource).toBeUndefined();
    expect(sibling.workdir).toBeUndefined();
    expect(getContextFiles(sibling)).toEqual(["src/bar.ts"]);
    expect(sibling.routing?.agent).toBe("opencode");

    // Positive control: the new sub-story IS resolved by the seam, so the sibling
    // assertion above is about the scope rather than about routing being inert.
    const sub = written.userStories.find((s) => s.id === "US-001-A");
    expect(sub?.routing?.agent).toBe("claude");
  });

  test("preserves the PRD project field and still stamps routingProfile", async () => {
    setup(makePrd([makeStory({ id: "US-001" })]), [makeSubStory("US-001-A")]);
    _persistPrdDeps.discoverWorkspacePackages = async () => [];
    _persistPrdDeps.existsSync = () => false;

    const before = makePrd([makeStory({ id: "US-001" })]);
    await planDecomposeCommand(tmpDir, makeNaxConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    expect(written.project).toBe(before.project);
    expect(written.routingProfile).toBe("default");
  });
});
```

Add `_persistPrdDeps` to the file's imports:

```ts
import { _persistPrdDeps } from "@/plan/strategies";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ./test/unit/cli/plan-decompose-writeback.test.ts --timeout=60000 -t "nax#2080"`
Expected: FAIL — `sub?.workdirSource` is `undefined` and `contextFiles` is still `["src/foo.ts"]`, because decompose writes raw.

- [ ] **Step 3: Implement**

In `src/cli/plan-decompose.ts`, add the seam import. Place it with the other `../` imports, after the `../operations` line:

```ts
import { finalizeAndWritePrd } from "../plan/strategies";
```

Then replace the tail of `planDecomposeCommand` — everything from the `// Delta C4: record the loader-resolved config profile name` comment through the `await _planDeps.writeFile(...)` line — with:

```ts
  // nax#2080: the decompose write goes through the same seam as `nax plan`, so
  // sub-stories get `workdirSource` stamped and their declared paths re-spelled
  // into the repo frame. Scoped to the sub-stories: the rest of this PRD may
  // already be executing, and re-deriving a workdir or re-resolving routing over
  // it would rewrite decisions that have already had effects.
  //
  // `specContent` is "" because decompose has no spec -- and with a scope set the
  // seam skips fidelity outright, so the value is never read.
  //
  // Delta C4: `finalizePrdRouting` inside the seam records the loader-resolved
  // config profile name (`config.profile`) at PRD root, which is what this
  // function used to stamp by hand, so `nax run` can still detect ladder drift.
  await finalizeAndWritePrd({
    prd: { ...prd, userStories: finalStories },
    specContent: "",
    featureName: options.feature,
    projectName: prd.project,
    agentRouting: config.routing?.agents,
    profileName: config.profile,
    models: config.models,
    defaultAgent: config.agent?.default ?? "claude",
    outputPath: prdPath,
    repoRoot: workdir,
    scope: new Set(subStoriesWithParent.map((s) => s.id)),
    writeFile: _planDeps.writeFile,
  });
  return () => {};
```

Note what disappears: the `const updatedPrd: PRD = { ...prd, userStories: finalStories, routingProfile: ... }` binding. If `PRD` is now an unused type import in this file, remove it from the import list (`import type { PRD, StoryStatus, UserStory } from "../prd/types";` → drop `PRD` only if nothing else references it; `prd` is still typed via the `JSON.parse(...) as PRD` cast near the top, so it almost certainly stays).

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `bun test ./test/unit/cli/plan-decompose-writeback.test.ts --timeout=60000`
Expected: PASS, whole file.

- [ ] **Step 5: Run the whole decompose suite and reconcile**

Run: `bun test ./test/unit/cli/ --timeout=60000`

Expected: PASS. Two pre-existing behaviours now change for sub-stories, and some assertions in the sibling decompose test files may need updating:
- sub-stories gain a `workdirSource` field (additive — most deep-equality assertions on whole stories will need it added);
- sub-story `routing` is now resolved by `finalizePrdRouting`, so `routing.agent` / `initialAgent` may be populated where they previously were not.

These are the **intended** effects of the fix. Update the assertions to match, and add a one-line comment at each edited assertion saying the field arrives from the seam (nax#2080). Do **not** weaken an assertion to `toMatchObject` just to make it pass — state the new expected value.

If a test fails for any *other* reason, stop and treat it as a defect in the implementation.

- [ ] **Step 6: Commit**

```bash
git add src/cli/plan-decompose.ts test/unit/cli/
git commit -m "fix(plan): route plan --decompose through finalizeAndWritePrd (#2080)"
```

---

### Task 5: Gates, changelog, and the PR

**Files:**
- Modify: `CHANGELOG.md`
- Verify only: everything else

- [ ] **Step 1: Run the full typecheck**

Run: `bun run typecheck`
Expected: exit 0. It checks both `tsconfig.json` and `tsconfig.test.json`.

- [ ] **Step 2: Run lint and every structural check**

Run: `bun run lint`
Expected: exit 0. This includes `check:import-cycles` (the new `src/cli` → `src/plan/strategies` import), `check:file-sizes`, and `check:story-workdir-access` (the `decideWorkdir` helper reads `story.workdir` raw, which is legal only because `src/prd/workdir-canonical.ts` is on that script's `ALLOWED` list — if it fires, you put the read in the wrong file).

- [ ] **Step 3: Run the remaining repo checks**

Run: `bun run check:all`
Expected: exit 0. Includes `check:test-as-unknown-as` and `check:test-escape-hatches`, both ratcheted at zero in `test/`.

- [ ] **Step 4: Run the whole unit suite**

Run: `bun run test:unit`
Expected: PASS. Paste the final summary line into the PR body — do not claim green without it.

- [ ] **Step 5: Add the changelog entry**

Add to the `Unreleased` section of `CHANGELOG.md`, under `### Fixed` (create the heading if the section has none):

```markdown
- `nax plan --decompose` now persists through `finalizeAndWritePrd` instead of writing the PRD raw, so decompose-created sub-stories get `workdirSource` stamped and their declared paths re-spelled into the repo frame (#2080). The write is scoped to the new sub-stories: workdir derivation and routing resolution do not re-run over stories already in the PRD, which may have executed.
```

- [ ] **Step 6: Commit and push**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for #2080"
git push -u origin feat/2080-decompose-persist-seam
```

- [ ] **Step 7: Code review BEFORE opening the PR**

Run a code review over the branch diff (`git diff origin/main...HEAD`) and resolve findings before opening anything. Review first, PR second — not the other way round.

- [ ] **Step 8: Open the PR**

```bash
gh pr create --repo nathapp-io/nax \
  --title "fix(plan): route plan --decompose through finalizeAndWritePrd (#2080)" \
  --body "$(cat <<'BODY'
Closes #2080.

`planDecomposeCommand` wrote the PRD via a raw `_planDeps.writeFile`, bypassing `finalizeAndWritePrd` — the single plan-write seam where the #2067 workdir canonicalization runs. Sub-stories inherited the parent's package via `storyPackageDir`, so they were not wrong, but they carried no `workdirSource` and their declared paths were never re-spelled into the repo frame.

The fix is a **story scope** on the seam rather than idempotency. Three transformations must not re-run over stories already in a PRD that may have started executing:

- **fidelity** is feature-level and keyed on a spec decompose does not have (it already runs with `specContent: ""`, under which `applyPlanFidelity` is a verified total no-op). A scoped write skips it outright.
- **workdir derivation** reads the filesystem. Once earlier stories have created files, a story that legitimately defaulted at plan time would silently acquire a package. `derive: false` closes it.
- **routing resolution** overwrites `routing.agent` from current config, which would reset an escalated story's recorded agent back to its profile default (`initialAgent` is sticky; `agent` is not). The `only` set closes it.

Declared-path re-spelling is already idempotent, but it is scoped with the rest so one set governs the whole write.

`scope` absent is the existing behaviour, unchanged, and `nax plan` never sets it.

### Done when
- [ ] `nax plan --decompose` writes through `finalizeAndWritePrd`; no raw `writeFile` remains in `planDecomposeCommand`.
- [ ] A sub-story comes out with `workdirSource` stamped and its `contextFiles` re-spelled into the repo frame.
- [ ] A story outside the scope is returned by identity — same `status`, `workdir`, `contextFiles` and `routing.agent` — under a probe that would re-frame and re-derive everything if asked.
- [ ] `project` and `routingProfile` survive the write (the hand-rolled Delta C4 stamp is now the seam's).
- [ ] `bun run typecheck`, `bun run lint`, `bun run check:all`, `bun run test:unit` all green.
BODY
)"
```

---

## Notes the implementer should not have to rediscover

- **`workdirSource: "stated"` on an inherited workdir.** A sub-story carries the parent's `workdir` (written by `mapDecomposedStoriesToUserStories`), so canonicalization reads it as `stated`. That is accurate enough — the parent stated it — and it avoids widening the `WorkdirSource` union (`"stated" | "derived" | "defaulted"`, `src/prd/types.ts:43`) and every consumer of it. Do **not** add an `"inherited"` variant as part of this change.
- **The `.nax/mono` defaulted-warning will now fire for sub-stories of a root-scoped parent.** That is correct and useful: it names both consequences (whole rule corpus, root `quality.commands`) at the one moment the author can act. Leave it.
- **`_persistPrdDeps` vs `_planDeps`.** The seam probes the filesystem through `_persistPrdDeps` (`src/plan/strategies/persist-prd.ts:34`); the decompose command uses `_planDeps`. A decompose test that stubs only `_planDeps.discoverWorkspacePackages` will silently hit the real filesystem inside the seam. Stub both, restore both.
- **Scope is a `ReadonlySet<string>`, not an array.** Membership is checked once per story per transformation; an array turns each pass quadratic and invites duplicate ids.

---

## Review log (2026-09-17)

The plan was reviewed against the codebase after drafting, with the doubtful claims executed rather than reasoned about. What that changed:

- **Two assertions were vacuous and are now real.** `resolveAgentAssignment` returns `null` when `agentRouting?.enabled !== true` **or** `profiles` is empty (`src/agents/shared/agent-profile-resolver.ts:23-26`), and `makeNaxConfig()` ships `routing.agents = { enabled: true, strategy: "off", profiles: [] }`. Both the Task 3 and Task 4 "the out-of-scope story keeps its agent" tests were originally written with routing that resolves to `null` for *every* story, so they would have passed with the `only` guard deleted. Both now pass a routing config with a real profile, and both gained a positive control asserting the **scoped** story *is* resolved.
- **The fidelity-skip test was confirmed non-vacuous.** `extractSpecOutOfScope("## Out of scope\n\n- Rewriting the scheduler")` returns `["Rewriting the scheduler"]` and `applyPlanFidelity` backfills it onto `prd.outOfScope` — verified by execution. So asserting the scoped write leaves `outOfScope` empty is a real assertion.
- **Both config literals were compiled.** `AgentRoutingConfig` with `strengths` and the `makeNaxConfig({ routing: { agents: { profiles: [...] } } })` DeepPartial override both typecheck under `tsconfig.test.json`, and the `profiles` array survives the merge (length 1, not erased).
- **Verified by reading, not assumed:** `makePRD` has no `outOfScope` default (so `?? []` is the right assertion form); `src/prd/index.ts:53` is the export line to extend; `src/plan/strategies/index.ts:8` already exports `_persistPrdDeps`; `canonicalizeDeclaredPath` returns early on `workdir === "."` (so the zero-probe assertion in Task 1 holds); `src/cli/plan-command.ts` already imports from `../plan/strategies` (no new import cycle).

One step remains genuinely discovery-dependent and is marked as such: **Task 4 Step 5**, reconciling sibling decompose tests whose sub-story assertions now see `workdirSource` and a resolved `routing`. It states the two expected causes and the stop condition.
