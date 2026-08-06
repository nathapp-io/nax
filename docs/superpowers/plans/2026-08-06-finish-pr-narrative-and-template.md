# nax-finish PR Body: Narrative and Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a model-written "What changed" narrative and the repository's own PR/MR template to the PR body that `nax-finish` produces, without ever letting either one prevent the PR from opening.

**Architecture:** `nax-finish` is an [acpx](https://www.npmjs.com/package/acpx) *flow* — a graph of nodes (`action`, `compute`, `acp`) connected by edges, living in `flows/nax-finish/`. It runs a completed feature branch through acceptance tests, two LLM review loops, and quality gates, then opens a PR. Today that PR body is assembled purely from on-disk artifacts. This plan adds one `acp` (LLM) node that writes prose, placed **after** the PR is already open so its failure cannot cost the PR, plus a deterministic port of the repo-template lookup.

**Tech Stack:** TypeScript (strict), Bun 1.3.7+ runtime, `bun:test`, Biome for lint/format, Zod for config schema.

## Orientation — read this before Task 1

You are working in a git worktree at
`/Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax/.claude/worktrees/finish-pr-narrative-and-template`,
on branch `feat/finish-pr-narrative-and-template`, based on `main` @ `4e802d98`.

**The design document this plan implements is at
`docs/superpowers/specs/2026-08-06-finish-pr-narrative-and-template-design.md`. Read it
first.** It explains *why* each decision was made; this plan says *what to type*.

### First, install dependencies

The worktree has no `node_modules`. Nothing will run until you do this:

```bash
bun install
```

### The two directories, and why they cannot import each other

| Directory | Runs under | May import |
|:--|:--|:--|
| `src/` | Bun, as the `nax` CLI | anything in `src/`, `Bun.*` APIs |
| `flows/` | **Node**, inside the `acpx` binary | `acpx/flows`, `node:*` builtins, its own relatives |

`flows/` is loaded by `acpx flow run` in acpx's own process. `Bun` is **undefined** there. A
`Bun.file()` call in `flows/` throws `ReferenceError: Bun is not defined` at runtime and the
test suite will not catch it, because tests run under Bun. This is enforced statically by
`bun run check:flows-no-bun`.

**Consequences you will hit in this plan:**

- Use `node:path`, `node:fs/promises` in `flows/` — never `Bun.*`.
- `flows/` cannot import from `src/`. Task 2 therefore **ports** a 60-line file instead of
  importing it. That is intentional, not an oversight — see the design doc.
- The repo convention "all LLM prompts live in `src/prompts/builders/`" **does not apply to
  `flows/`**, for the same reason. `flows/nax-finish/review-prompts.ts` is the precedent.
  Do not try to move Task 3's prompt into `src/`.
- `flows/` uses its own `FinishError` (`flows/nax-finish/errors.ts`), never `NaxError`.

### The single most important constraint in this plan

**A failing `acp` node kills the entire flow.** acpx's `AcpNodeDefinition` exposes only
`prompt` and `parse`; `FlowEdge` is only `to` or `switch`. There is **no error edge and no
node-level retry**. When an acp node fails, `acpx flow run` exits 1 with no result file.

This is why the narrative node runs *after* `open_pr` and amends the body, rather than
running before and contributing to it. If you find yourself "simplifying" the graph by
moving the narrative node earlier, you are re-introducing the bug this design exists to
avoid. See `flows/nax-finish/verdict.ts:9-12`.

### Commands

Run these from the worktree root.

| Purpose | Command |
|:--|:--|
| One test file | `timeout 30 bun test <path> --timeout=5000` |
| One directory | `timeout 60 bun test test/unit/flows/nax-finish/ --timeout=5000` |
| Full suite | `bun run test` |
| Typecheck | `bun run typecheck` |
| Lint + all static gates | `bun run lint` |

**Never run bare `bun test <path>`** — always wrap a scoped run in `timeout`. A hung Bun
process otherwise blocks indefinitely. Treat exit 124 (timeout), 134 and 132 (Bun JSC
crashes) as terminal — investigate, do not retry.

`bun run lint` includes `check:flows-no-bun` (no `Bun.*` under `flows/`) and
`check:file-sizes` (600-line cap for source files). Both matter for this plan.

## Global Constraints

- **600-line hard limit** for source files, enforced by `bun run check:file-sizes`.
  `flows/nax-finish/nax-finish.flow.ts` is at **561 lines**. This plan adds roughly 27 to
  it. Every line of prompt text and node logic must live in a separate module.
- **800-line hard limit** for test files.
- No `Bun.*` anywhere under `flows/`.
- No `any` without a documented justification. TypeScript strict is on.
- Functions ≤30 lines, ≤3 positional parameters.
- No `console.log` — `flows/` warns through `_prBodyDeps.warn`.
- Conventional commits: `feat:`, `fix:`, `test:`, `docs:`, `chore:`.
- Test files mirror source: `flows/nax-finish/narrative.ts` → `test/unit/flows/nax-finish/narrative.test.ts`.
- Tests import flow modules through the `@flows/*` alias, e.g.
  `import { buildFinishBody } from "@flows/nax-finish/steps/pr-body"`.
- `tsconfig.json` **excludes `test/`**. Nothing under `test/unit/` is typechecked. Only
  `test/contracts/` is covered by the typecheck gate. **You do not need to add a contracts
  test in this plan** — every type this work introduces lives in `src/` or `flows/`, and
  `tsconfig.json`'s `include` covers both, so `bun run typecheck` already enforces them. Do
  not invent one.

---

### Task 1: Config surface for the narrative node

Adds two config keys and forwards them to the flow as environment variables. Entirely
within `src/`; touches no flow code. Independent of Tasks 2–5 and may be done in any order
relative to them.

**Files:**
- Modify: `src/config/schemas.ts:449-487` (the `finish.autoFlow` block)
- Modify: `src/config/runtime-types-finish.ts:16-28`
- Modify: `src/plugins/builtin/nax-finish/config.ts:16-93`
- Modify: `src/plugins/builtin/nax-finish/index.ts:247-252` (`buildFlowEnv`)
- Test: `test/unit/config/finish-autoflow-schema.test.ts`
- Test: `test/unit/plugins/builtin/nax-finish/plugin.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: environment variables `NAX_FINISH_NARRATIVE` (set to `"0"` only when disabled)
  and `NAX_FINISH_NARRATIVE_PROFILE` (an acpx profile name). Task 5 reads both.

**Background:** `finish.autoFlow` is opt-in and disabled by default. The plugin at
`src/plugins/builtin/nax-finish/index.ts` spawns `acpx flow run` as a subprocess and passes
per-node agent profiles through env vars, because the flow module reloads fresh on every
invocation and cannot see nax's config object. `NAX_FINISH_SPEC_PROFILE` is the existing
example.

**Watch out:** this schema repeats its defaults **three times** — once on the `autoFlow`
object's `.default()`, once on the enclosing `finish` object's `.default()`, and the
`timeouts` object does the same one level down. Miss one and the parsed shape silently
diverges from the declared one.

- [ ] **Step 1: Write the failing schema test**

Add to `test/unit/config/finish-autoflow-schema.test.ts`:

```typescript
test("narrative defaults to true and reviewers.narrative to null", () => {
  const parsed = NaxConfigSchema.parse({});
  expect(parsed.finish.autoFlow.narrative).toBe(true);
  expect(parsed.finish.autoFlow.reviewers.narrative).toBeNull();
});

test("narrative can be disabled and given a profile", () => {
  const parsed = NaxConfigSchema.parse({
    finish: { autoFlow: { narrative: false, reviewers: { narrative: "haiku" } } },
  });
  expect(parsed.finish.autoFlow.narrative).toBe(false);
  expect(parsed.finish.autoFlow.reviewers.narrative).toBe("haiku");
});

test("the finish-level default literal carries the narrative keys too", () => {
  // The schema repeats its defaults at three levels; a config with no `finish`
  // block at all must still parse to the same shape as one with an empty block.
  const empty = NaxConfigSchema.parse({});
  const explicit = NaxConfigSchema.parse({ finish: { autoFlow: {} } });
  expect(empty.finish.autoFlow.narrative).toBe(explicit.finish.autoFlow.narrative);
  expect(empty.finish.autoFlow.reviewers).toEqual(explicit.finish.autoFlow.reviewers);
});
```

If `NaxConfigSchema` is not already imported in that file, add
`import { NaxConfigSchema } from "@/config/schemas";` — check the file's existing imports first
and match whatever it already does.

- [ ] **Step 2: Run the test to verify it fails**

```bash
timeout 30 bun test test/unit/config/finish-autoflow-schema.test.ts --timeout=5000
```

Expected: FAIL — `expect(received).toBe(expected)` with `received: undefined` for
`parsed.finish.autoFlow.narrative`.

- [ ] **Step 3: Add the two fields to the Zod schema**

In `src/config/schemas.ts`, inside the `autoFlow` object, add `narrative` immediately after
`model`:

```typescript
            /**
             * Whether the flow spends an agent turn writing the PR body's
             * "What changed" section. Disabled → the body carries the
             * mechanical fallback (spec §Summary) or no such section at all.
             */
            narrative: z.boolean().default(true),
```

Change the `reviewers` object to carry a third key:

```typescript
            reviewers: z
              .object({
                spec: z.string().nullable().default(null),
                quality: z.string().nullable().default(null),
                /** Profile that writes the "What changed" narrative. */
                narrative: z.string().nullable().default(null),
              })
              .default({ spec: null, quality: null, narrative: null }),
```

- [ ] **Step 4: Update all three repeated default literals**

Still in `src/config/schemas.ts`. In the `autoFlow` object's own `.default({...})`, and again
in the enclosing `finish` object's `.default({ autoFlow: {...} })`, add `narrative: true` and
change the `reviewers` literal. Both literals must end up containing:

```typescript
            narrative: true,
            reviewers: { spec: null, quality: null, narrative: null },
```

Search the file for `reviewers: { spec: null, quality: null }` — there are exactly two
occurrences and **both** must change.

- [ ] **Step 5: Run the schema test to verify it passes**

```bash
timeout 30 bun test test/unit/config/finish-autoflow-schema.test.ts --timeout=5000
```

Expected: PASS.

- [ ] **Step 6: Update the runtime type**

In `src/config/runtime-types-finish.ts`, inside `interface FinishAutoFlowConfig`:

```typescript
  /** Whether the flow writes the PR body's "What changed" narrative */
  narrative: boolean;
  /** Per-node acpx profiles */
  reviewers: { spec: string | null; quality: string | null; narrative: string | null };
```

Replace the existing `reviewers` line; do not add a second one.

- [ ] **Step 7: Write the failing plugin env test**

Add to `test/unit/plugins/builtin/nax-finish/plugin.test.ts`, immediately after the existing
`"execute sets reviewer profile env vars from config.finish.autoFlow.reviewers"` test
(around line 454). `action`, `baseCtx` and `_naxFinishDeps` are already in scope in that
describe block:

```typescript
test("execute forwards the narrative profile and leaves NAX_FINISH_NARRATIVE unset when enabled", async () => {
  let capturedEnv: Record<string, string> | undefined;
  _naxFinishDeps.run = async (_cmd, opts) => {
    capturedEnv = opts.env;
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  _naxFinishDeps.readResult = async () => ({ feature: "x", status: "opened" });

  await action.execute(
    baseCtx({
      config: {
        finish: {
          autoFlow: { enabled: true, narrative: true, reviewers: { narrative: "narrator" } },
        },
      },
    }),
  );

  expect(capturedEnv?.NAX_FINISH_NARRATIVE_PROFILE).toBe("narrator");
  // Only the disabled case is signalled, so an unset var still means enabled.
  expect(capturedEnv?.NAX_FINISH_NARRATIVE).toBeUndefined();
});

test("execute sets NAX_FINISH_NARRATIVE=0 when the narrative is disabled", async () => {
  let capturedEnv: Record<string, string> | undefined;
  _naxFinishDeps.run = async (_cmd, opts) => {
    capturedEnv = opts.env;
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  _naxFinishDeps.readResult = async () => ({ feature: "x", status: "opened" });

  await action.execute(
    baseCtx({ config: { finish: { autoFlow: { enabled: true, narrative: false } } } }),
  );

  expect(capturedEnv?.NAX_FINISH_NARRATIVE).toBe("0");
});
```

- [ ] **Step 8: Run it to verify it fails**

```bash
timeout 30 bun test test/unit/plugins/builtin/nax-finish/plugin.test.ts --timeout=5000
```

Expected: FAIL — `NAX_FINISH_NARRATIVE_PROFILE` is `undefined`.

- [ ] **Step 9: Read the config through and forward it**

In `src/plugins/builtin/nax-finish/config.ts`, add to `interface FinishAutoFlowSettings`:

```typescript
  narrative: boolean;
```

and change its `reviewers` line to:

```typescript
  reviewers: { spec: string | null; quality: string | null; narrative: string | null };
```

In `DEFAULT_FINISH_AUTO_FLOW_CONFIG`, add `narrative: true,` and change the reviewers entry
to `reviewers: { spec: null, quality: null, narrative: null },`.

In `getFinishAutoFlowConfig`, add after the `model:` line:

```typescript
    // `!== false` so an older config with no `narrative` key still narrates,
    // matching the schema default rather than silently opting out.
    narrative: autoFlow.narrative !== false,
```

and extend the `reviewers` block:

```typescript
    reviewers: {
      spec: autoFlow.reviewers?.spec ?? null,
      quality: autoFlow.reviewers?.quality ?? null,
      narrative: autoFlow.reviewers?.narrative ?? null,
    },
```

In `src/plugins/builtin/nax-finish/index.ts`, in `buildFlowEnv`, after the
`NAX_FINISH_QUALITY_PROFILE` line:

```typescript
  if (cfg.reviewers.narrative) env.NAX_FINISH_NARRATIVE_PROFILE = cfg.reviewers.narrative;
  // Only the disabled case is signalled. An unset var means enabled, so a flow
  // invoked directly by `acpx flow run` still narrates.
  if (!cfg.narrative) env.NAX_FINISH_NARRATIVE = "0";
```

- [ ] **Step 10: Run both test files to verify they pass**

```bash
timeout 30 bun test test/unit/config/finish-autoflow-schema.test.ts --timeout=5000
timeout 30 bun test test/unit/plugins/builtin/nax-finish/plugin.test.ts --timeout=5000
```

Expected: PASS for both.

- [ ] **Step 11: Typecheck and lint**

```bash
bun run typecheck && bun run lint
```

Expected: both clean. If `typecheck` complains about a missing `narrative` on
`FinishAutoFlowSettings` somewhere you did not edit, that is a real call site — fix it.

- [ ] **Step 12: Commit**

```bash
git add src/config/schemas.ts src/config/runtime-types-finish.ts \
  src/plugins/builtin/nax-finish/config.ts src/plugins/builtin/nax-finish/index.ts \
  test/unit/config/finish-autoflow-schema.test.ts \
  test/unit/plugins/builtin/nax-finish/plugin.test.ts
git commit -m "feat(finish): add narrative enable flag and profile to finish.autoFlow config"
```

---

### Task 2: Port the repository PR/MR template lookup

Closes #1478. Ports a 60-line lookup from `src/` into `flows/`, threads the forge kind into
body assembly, and appends the template to the PR body.

**Files:**
- Create: `flows/nax-finish/pr-template.ts`
- Modify: `flows/nax-finish/steps/pr-body.ts`
- Modify: `flows/nax-finish/steps/pr.ts`
- Test: `test/unit/flows/nax-finish/pr-template.test.ts`
- Test: `test/unit/flows/nax-finish/pr-body.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `findPrTemplate(workdir: string, forge: Forge, deps: TemplateDeps): Promise<string | null>`
  - `interface TemplateDeps { readText: (path: string) => Promise<string | null> }`
  - `FinishPrContext.template?: string` — Task 3 adds a sibling field to the same interface.
  - `loadFinishPrContext(input, args)` where `args` gains `forge?: Forge`.
  - `openOrPromotePr(repoRoot, branch, title, body, forge?)` — a new optional 5th parameter.
  - `updatePrBody(forge, repoRoot, branch, title, body): Promise<void>` — exported from
    `steps/pr.ts`; Task 5 calls it.

**Background:** `gh pr create --body ...` and `glab mr create --description ...` *suppress*
the repository's own template. The auto-PR plugin already reads and re-embeds it; the finish
flow does not, so the two produce differently-shaped PRs for no principled reason.

**Watch out:** `detectForge` currently runs *inside* `openOrPromotePr`, which is called
*after* the body is built. The template lookup needs the forge kind *before* the body exists.
Rather than detect twice (which would let the body and the create-command disagree), the
caller detects once and passes it down. `openOrPromotePr`'s new parameter is optional so the
existing behaviour is preserved when detection itself failed.

- [ ] **Step 1: Write the failing template-lookup test**

Create `test/unit/flows/nax-finish/pr-template.test.ts`:

```typescript
/**
 * Ported repository PR/MR template lookup (#1478).
 *
 * The candidate paths are an external convention set by GitHub and GitLab, so
 * this asserts the priority order explicitly — a reordering is a behaviour change.
 */
import { describe, expect, test } from "bun:test";
import { findPrTemplate } from "@flows/nax-finish/pr-template";

const depsFor = (files: Record<string, string>) => ({
  readText: async (path: string): Promise<string | null> => files[path] ?? null,
});

describe("findPrTemplate", () => {
  test("returns the GitHub template verbatim", async () => {
    const deps = depsFor({ "/repo/.github/PULL_REQUEST_TEMPLATE.md": "## Checklist\n- [ ] tests" });
    expect(await findPrTemplate("/repo", "github", deps)).toBe("## Checklist\n- [ ] tests");
  });

  test("prefers .github/PULL_REQUEST_TEMPLATE.md over the lowercase sibling", async () => {
    const deps = depsFor({
      "/repo/.github/PULL_REQUEST_TEMPLATE.md": "upper",
      "/repo/.github/pull_request_template.md": "lower",
    });
    expect(await findPrTemplate("/repo", "github", deps)).toBe("upper");
  });

  test("falls through the full GitHub candidate list in order", async () => {
    const deps = depsFor({ "/repo/docs/PULL_REQUEST_TEMPLATE.md": "docs one" });
    expect(await findPrTemplate("/repo", "github", deps)).toBe("docs one");
  });

  test("resolves the GitLab default merge-request template", async () => {
    const deps = depsFor({ "/repo/.gitlab/merge_request_templates/Default.md": "mr body" });
    expect(await findPrTemplate("/repo", "gitlab", deps)).toBe("mr body");
  });

  test("does not read GitHub paths when the forge is GitLab", async () => {
    const deps = depsFor({ "/repo/.github/PULL_REQUEST_TEMPLATE.md": "gh only" });
    expect(await findPrTemplate("/repo", "gitlab", deps)).toBeNull();
  });

  test("returns null when no template exists — the common case", async () => {
    expect(await findPrTemplate("/repo", "github", depsFor({}))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
timeout 30 bun test test/unit/flows/nax-finish/pr-template.test.ts --timeout=5000
```

Expected: FAIL — cannot resolve module `@flows/nax-finish/pr-template`.

- [ ] **Step 3: Create the ported module**

Create `flows/nax-finish/pr-template.ts`:

```typescript
/**
 * Repository PR/MR template discovery, ported from
 * `src/plugins/builtin/auto-pr/template.ts`.
 *
 * Ported rather than imported: `flows/` is loaded by acpx in its own Node
 * process, where nax's `src/` and its `@/*` alias do not exist. This matches
 * the convention already in this directory — `errors.ts`, `exec.ts`, `types.ts`
 * and the PR body builder are all flow-local re-implementations.
 *
 * The duplication is stable: these candidate paths are an external convention
 * set by GitHub and GitLab, not internal logic that drifts with the codebase.
 *
 * Why preserve-not-fill: passing `--body` / `--description` to `gh` / `glab`
 * suppresses the repo's default template, so it must be read and re-embedded.
 */
import { join } from "node:path";
import type { Forge } from "./steps/forge";

/**
 * Candidate template paths for GitHub, in priority order.
 * Multi-template directories (`PULL_REQUEST_TEMPLATE/`) are intentionally
 * skipped because they are ambiguous unattended.
 */
const GITHUB_TEMPLATE_PATHS: readonly string[] = [
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
] as const;

/** Preferred single-template location for GitLab. */
const GITLAB_DEFAULT_TEMPLATE_PATH = ".gitlab/merge_request_templates/Default.md";

/** Only `readText` is consulted, so any caller with a file reader can supply it. */
export interface TemplateDeps {
  readText: (path: string) => Promise<string | null>;
}

async function firstExisting(workdir: string, deps: TemplateDeps, paths: readonly string[]): Promise<string | null> {
  for (const relPath of paths) {
    const content = await deps.readText(join(workdir, relPath));
    if (content !== null) return content;
  }
  return null;
}

/**
 * Locate the PR/MR template for the current repository.
 *
 * @returns Template text verbatim, or `null` when none resolves — which is the
 *          common case and never an error.
 */
export async function findPrTemplate(workdir: string, forge: Forge, deps: TemplateDeps): Promise<string | null> {
  if (forge === "github") return firstExisting(workdir, deps, GITHUB_TEMPLATE_PATHS);
  return firstExisting(workdir, deps, [GITLAB_DEFAULT_TEMPLATE_PATH]);
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
timeout 30 bun test test/unit/flows/nax-finish/pr-template.test.ts --timeout=5000
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Write the failing body-append test**

Add to `test/unit/flows/nax-finish/pr-body.test.ts`. The file already has a `baseCtx` helper
at line 40 — use it:

```typescript
describe("buildFinishBody — repository template (#1478)", () => {
  test("appends the template verbatim after every deterministic section", () => {
    const body = buildFinishBody(
      baseCtx({
        stories: [story({ id: "US-001", title: "Header", acCount: 2 })],
        template: "## Checklist\n- [ ] docs updated",
      }),
    );
    expect(body.endsWith("## Checklist\n- [ ] docs updated")).toBe(true);
    expect(body.indexOf("## Stories")).toBeLessThan(body.indexOf("## Checklist"));
  });

  test("omits the template entirely when none resolved", () => {
    const body = buildFinishBody(baseCtx({ stories: [story()] }));
    expect(body).not.toContain("## Checklist");
    expect(body.endsWith("\n\n")).toBe(false);
  });

  test("treats a whitespace-only template as absent", () => {
    const body = buildFinishBody(baseCtx({ stories: [story()], template: "   \n  " }));
    expect(body.trimEnd()).toBe(body);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

```bash
timeout 30 bun test test/unit/flows/nax-finish/pr-body.test.ts --timeout=5000
```

Expected: FAIL — TypeScript will not object (tests are untypechecked), but
`body.endsWith(...)` is `false` because nothing appends the template.

- [ ] **Step 7: Thread the template through `pr-body.ts`**

In `flows/nax-finish/steps/pr-body.ts`:

Add the import at the top, after the existing `node:path` import:

```typescript
import { findPrTemplate } from "../pr-template";
import type { Forge } from "./forge";
```

Add to `interface FinishPrContext`, after `diffstat`:

```typescript
  /** Repository PR/MR template, verbatim. Absent when none resolves. */
  template?: string;
```

Add this helper next to `runDiffstat`:

```typescript
/**
 * Resolve the repository's PR/MR template, fail-open.
 *
 * An absent template is the common case and never warns. A genuine read failure
 * is swallowed too: the body is useful without this section, and `open_pr` must
 * not lose a PR to a permissions error on a file most repos do not have.
 */
async function loadTemplate(workdir: string, forge: Forge | undefined): Promise<string | undefined> {
  if (forge === undefined) return undefined;
  try {
    return (await findPrTemplate(workdir, forge, { readText: _prBodyDeps.readText })) ?? undefined;
  } catch {
    return undefined;
  }
}
```

Change `loadFinishPrContext`'s signature and body. The `args` type becomes:

```typescript
  args: { base: string; gatesRan: string[]; forge?: Forge },
```

and the `Promise.all` gains a fifth entry:

```typescript
  const [prd, status, rounds, diffstat, template] = (await Promise.all([
    readJson(prdPath),
    readJson(join(dirname(prdPath), "status.json")),
    readRounds(input),
    runDiffstat(input.workdir, args.base),
    loadTemplate(input.workdir, args.forge),
  ])) as [PrdArtifact | undefined, StatusArtifact | undefined, FinishRound[], string | undefined, string | undefined];
```

Add `template,` to the returned object, next to `diffstat,`.

Finally, in `buildFinishBody`, append after the footer block:

```typescript
  // Appended last and verbatim: `gh` / `glab` suppress the repo's own template
  // whenever `--body` / `--description` is passed, so it has to be re-embedded.
  if (ctx.template !== undefined && ctx.template.trim().length > 0) sections.push(ctx.template.trim());
```

- [ ] **Step 8: Run the body test to verify it passes**

```bash
timeout 30 bun test test/unit/flows/nax-finish/pr-body.test.ts --timeout=5000
```

Expected: PASS.

- [ ] **Step 9: Make `openOrPromotePr` accept a forge, and export `updatePrBody`**

In `flows/nax-finish/steps/pr.ts`:

Change the signature and the first line of the body:

```typescript
export async function openOrPromotePr(
  repoRoot: string,
  branch: string,
  title: string,
  body: string,
  // Optional so a caller whose own `detectForge` threw still gets the previous
  // behaviour. Passing it in is what stops the body and the create-command from
  // disagreeing about the forge when both would otherwise detect separately.
  knownForge?: Forge,
): Promise<{ status: "opened" | "promoted" | "already-ready"; url?: string }> {
  const forge = knownForge ?? (await detectForge(_prDeps.run, repoRoot, "finish-pr"));
```

Leave the rest of the function unchanged — it already reads a local `forge`.

Rename `writeFinishMetadata` to `updatePrBody` and export it. Change its declaration:

```typescript
/**
 * Write the finish title/body onto an already-open PR/MR.
 *
 * Non-fatal by design: this runs after the PR exists, so a failed metadata
 * write must not throw away that state — the caller's returned status/url
 * stays valid either way. Exported because `amend_body` calls it after the
 * narrative node produces prose.
 */
export async function updatePrBody(
```

Update both internal call sites (`await writeFinishMetadata(forge, ...)` → `await updatePrBody(forge, ...)`).

- [ ] **Step 10: Run the whole flow test directory**

```bash
timeout 60 bun test test/unit/flows/nax-finish/ --timeout=5000
```

Expected: PASS. If `flow-graph.test.ts` fails, you changed a signature a graph test
depends on — read the failure and fix the call, not the test's intent.

- [ ] **Step 11: Typecheck and lint**

```bash
bun run typecheck && bun run lint
```

Expected: clean, including `check:flows-no-bun`.

- [ ] **Step 12: Commit**

```bash
git add flows/nax-finish/pr-template.ts flows/nax-finish/steps/pr-body.ts \
  flows/nax-finish/steps/pr.ts test/unit/flows/nax-finish/pr-template.test.ts \
  test/unit/flows/nax-finish/pr-body.test.ts
git commit -m "feat(finish): append the repository PR/MR template to the finish PR body

Closes #1478."
```

---

### Task 3: The narrative module

Creates the prompt, the parser, the fallback-resolution chain, and the spec-summary
extractor. Pure functions only — no flow wiring yet. Task 4 consumes these.

**Files:**
- Create: `flows/nax-finish/narrative.ts`
- Modify: `flows/nax-finish/steps/pr-body.ts`
- Test: `test/unit/flows/nax-finish/narrative.test.ts`
- Test: `test/unit/flows/nax-finish/pr-body.test.ts`

**Interfaces:**
- Consumes: `FinishPrContext` from Task 2 (adds a sibling field to the same interface).
- Produces:
  - `NARRATIVE_MAX_CHARS: number` (4000)
  - `buildNarrativePrompt(args: { base: string }): string`
  - `parseNarrative(text: string): string`
  - `resolveNarrative(agentText: string | undefined, specSummary: string | null): string | undefined`
  - `readSpecSummary(specPath: string | undefined, readText: (path: string) => Promise<string | null>): Promise<string | null>`
  - `FinishPrContext.narrative?: string`
  - `loadFinishPrContext` args gain `specPath?: string` and `narrative?: string`

**Background:** the narrative has two possible sources. The model writes it from the branch
diff (best — describes what shipped). When that is unavailable, the spec's `## Summary`
section is used (worse — describes what was *intended*, which can diverge). When neither
exists, the section is omitted entirely — never an empty heading.

**Watch out:** `readSpecSummary` must accept **both** `## Summary` and `## Overview`. Of the
six real `.nax/features/*/spec.md` files in this repo, five use `## Summary` and the older
`plugin-001` uses `## Overview`. Validate against those real shapes, not an invented one.

- [ ] **Step 1: Write the failing narrative tests**

Create `test/unit/flows/nax-finish/narrative.test.ts`:

```typescript
/**
 * The "What changed" narrative (#1477).
 *
 * Every guarantee here is on a pure function. The acp node that produces the
 * model text cannot be executed in tests (acpx is not a test harness), so the
 * degradation chain has to be reachable without it — that is why
 * `resolveNarrative` exists as a separate function rather than as flow wiring.
 */
import { describe, expect, test } from "bun:test";
import {
  NARRATIVE_MAX_CHARS,
  buildNarrativePrompt,
  parseNarrative,
  readSpecSummary,
  resolveNarrative,
} from "@flows/nax-finish/narrative";

describe("resolveNarrative", () => {
  test("prefers the agent's text over the spec summary", () => {
    expect(resolveNarrative("model prose", "spec prose")).toBe("model prose");
  });

  test("falls back to the spec summary when the agent produced nothing", () => {
    expect(resolveNarrative(undefined, "spec prose")).toBe("spec prose");
  });

  test("treats whitespace-only agent text as nothing", () => {
    expect(resolveNarrative("   \n  ", "spec prose")).toBe("spec prose");
  });

  test("returns undefined when neither source has content", () => {
    expect(resolveNarrative(undefined, null)).toBeUndefined();
    expect(resolveNarrative("  ", "   ")).toBeUndefined();
  });

  test("truncates an over-long narrative rather than rendering it whole", () => {
    const huge = "x".repeat(NARRATIVE_MAX_CHARS + 500);
    const resolved = resolveNarrative(huge, null) as string;
    expect(resolved.length).toBe(NARRATIVE_MAX_CHARS);
    expect(resolved.endsWith("…")).toBe(true);
  });
});

describe("parseNarrative", () => {
  test("trims the reply", () => {
    expect(parseNarrative("  prose  \n")).toBe("prose");
  });

  test("never throws on an empty reply — a throw would fail the flow", () => {
    expect(parseNarrative("")).toBe("");
  });
});

describe("readSpecSummary", () => {
  const readerFor = (files: Record<string, string>) => async (p: string) => files[p] ?? null;

  test("extracts a '## Summary' section up to the next heading", async () => {
    const spec = "# SPEC: thing\n\n## Summary\n\nIt does a thing.\n\n## Motivation\n\nBecause.\n";
    expect(await readSpecSummary("/s.md", readerFor({ "/s.md": spec }))).toBe("It does a thing.");
  });

  test("accepts '## Overview' — the older spec shape in this repo", async () => {
    const spec = "# Feature: plugin-001\n\n## Overview\n\nOlder shape.\n\n## Design\n\nx\n";
    expect(await readSpecSummary("/s.md", readerFor({ "/s.md": spec }))).toBe("Older shape.");
  });

  test("reads a summary that runs to end of file", async () => {
    const spec = "# T\n\n## Summary\n\nLast section.\n";
    expect(await readSpecSummary("/s.md", readerFor({ "/s.md": spec }))).toBe("Last section.");
  });

  test("returns null when the heading is absent", async () => {
    expect(await readSpecSummary("/s.md", readerFor({ "/s.md": "# T\n\n## Design\n\nx\n" }))).toBeNull();
  });

  test("returns null for an empty summary body", async () => {
    expect(await readSpecSummary("/s.md", readerFor({ "/s.md": "## Summary\n\n## Next\n" }))).toBeNull();
  });

  test("returns null when the spec file is missing or the path is unset", async () => {
    expect(await readSpecSummary("/nope.md", readerFor({}))).toBeNull();
    expect(await readSpecSummary(undefined, readerFor({}))).toBeNull();
  });

  test("returns null rather than throwing when the reader throws", async () => {
    const throwing = async () => {
      throw new Error("EACCES");
    };
    expect(await readSpecSummary("/s.md", throwing)).toBeNull();
  });
});

describe("buildNarrativePrompt", () => {
  test("names the diff range the agent must read", () => {
    expect(buildNarrativePrompt({ base: "origin/main" })).toContain("git diff origin/main...HEAD");
  });

  test("declares every deterministic section off-limits", () => {
    // #1477: the model restating artifact-derived sections is how the two
    // halves of the body drift apart. This is the enforceable form of that
    // requirement — an assertion on the builder's output, not a grep of source.
    const prompt = buildNarrativePrompt({ base: "main" });
    for (const forbidden of ["Stories table", "Verification", "Review rounds", "Out of scope"]) {
      expect(prompt).toContain(forbidden);
    }
    expect(prompt).toContain("Do NOT restate");
  });

  test("states the length budget", () => {
    expect(buildNarrativePrompt({ base: "main" })).toContain(String(NARRATIVE_MAX_CHARS));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
timeout 30 bun test test/unit/flows/nax-finish/narrative.test.ts --timeout=5000
```

Expected: FAIL — cannot resolve module `@flows/nax-finish/narrative`.

- [ ] **Step 3: Create the narrative module**

Create `flows/nax-finish/narrative.ts`:

```typescript
/**
 * The PR body's "What changed" section — prompt, parse, and the chain that
 * decides what text (if any) the section carries.
 *
 * Prompt building lives here rather than in `src/prompts/builders/` because
 * `flows/` is loaded by acpx in its own Node process and imports nothing from
 * `src/`. `review-prompts.ts` sits beside this file for the same reason.
 *
 * `resolveNarrative` is a standalone pure function, not flow wiring, because
 * the acp node that produces the model text cannot be executed in tests. The
 * degradation chain is the part that must never break, so it lives where a
 * test can reach it.
 */

/** Longest narrative rendered into a PR body, in characters, including the ellipsis. */
export const NARRATIVE_MAX_CHARS = 4000;

const TRUNCATION_SUFFIX = "…";

/** Headings a spec uses for its lead paragraph, in priority order. */
const SUMMARY_HEADINGS = ["summary", "overview"] as const;

/**
 * Prompt for the narrative node.
 *
 * Two jobs: point the agent at the real diff (never the spec, which describes
 * intent rather than what shipped), and forbid restating the sections the body
 * already renders deterministically.
 */
export function buildNarrativePrompt(args: { base: string }): string {
  return [
    'Write the "What changed" section of a pull request body.',
    "",
    `Read the branch diff yourself: \`git diff ${args.base}...HEAD\`.`,
    "Read whatever source files you need to understand it.",
    "",
    "The PR body ALREADY renders these deterministically, from run artifacts:",
    "- a Stories table (story id, title, acceptance-criteria count)",
    "- a Verification block (acceptance status, regression status, gates run, diffstat)",
    "- a Review rounds block (every finding, with its severity)",
    "- an Out of scope list",
    "",
    "Do NOT restate, summarise, or refer to any of them. Repeating them is how the",
    "written and the generated halves of this body drift apart.",
    "",
    "Describe what the change actually does, in prose: the shape of the change, and",
    "anything a reviewer would otherwise have to reconstruct from the diff by hand.",
    `Hard limit: ${NARRATIVE_MAX_CHARS} characters.`,
    "Do not write a heading — the heading is added for you.",
    "Return the prose only. No JSON, no code fences, no preamble.",
  ].join("\n");
}

/**
 * `parse` for the narrative acp node.
 *
 * Never throws. A throw inside `parse` fails the node, and acpx has no error
 * edge — see `verdict.ts`. Here that would mean the flow dying *after* the PR
 * was already opened.
 */
export function parseNarrative(text: string): string {
  return typeof text === "string" ? text.trim() : "";
}

function truncate(text: string): string {
  if (text.length <= NARRATIVE_MAX_CHARS) return text;
  return text.slice(0, NARRATIVE_MAX_CHARS - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

/**
 * Pick the narrative text, best source first.
 *
 * The spec summary is the fallback rather than the primary source because a
 * spec describes intent: when an implementation deviates and the deviation is
 * accepted, a spec-derived narrative confidently describes code that does not
 * exist.
 *
 * `undefined` means "render no section at all" — never an empty heading.
 */
export function resolveNarrative(agentText: string | undefined, specSummary: string | null): string | undefined {
  const fromAgent = agentText?.trim();
  if (fromAgent) return truncate(fromAgent);
  const fromSpec = specSummary?.trim();
  if (fromSpec) return truncate(fromSpec);
  return undefined;
}

function sectionBody(lines: string[], heading: string): string | null {
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return body.length > 0 ? body : null;
}

/**
 * First `## Summary` or `## Overview` block in the spec, or `null`.
 *
 * Both headings are accepted because both occur in this repository's real
 * specs — five of six use `## Summary`, the older `plugin-001` uses
 * `## Overview`. Fail-open on every read error: a missing or unreadable spec
 * costs the section, never the PR.
 */
export async function readSpecSummary(
  specPath: string | undefined,
  readText: (path: string) => Promise<string | null>,
): Promise<string | null> {
  if (!specPath) return null;
  let text: string | null;
  try {
    text = await readText(specPath);
  } catch {
    return null;
  }
  if (text === null) return null;
  const lines = text.split(/\r?\n/);
  for (const heading of SUMMARY_HEADINGS) {
    const body = sectionBody(lines, heading);
    if (body !== null) return body;
  }
  return null;
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
timeout 30 bun test test/unit/flows/nax-finish/narrative.test.ts --timeout=5000
```

Expected: PASS.

- [ ] **Step 5: Verify the extractor against the repo's real specs**

This is not a test — it is a manual check that the heading list is right. Run:

```bash
for f in .nax/features/*/spec.md; do
  echo "$f -> $(grep -m1 -E '^## (Summary|Overview)' "$f" || echo 'NO MATCH')"
done
```

Expected: five `## Summary` and one `## Overview` (`plugin-001`), zero `NO MATCH`. If any
spec reports `NO MATCH`, add its heading to `SUMMARY_HEADINGS` and add a test for it before
continuing.

- [ ] **Step 6: Write the failing body-section test**

Add to `test/unit/flows/nax-finish/pr-body.test.ts`:

```typescript
describe("buildFinishBody — What changed section (#1477)", () => {
  test("renders the narrative first, above the Stories table", () => {
    const body = buildFinishBody(
      baseCtx({ stories: [story()], narrative: "Replaced the widget cache." }),
    );
    expect(body.indexOf("## What changed")).toBe(0);
    expect(body).toContain("Replaced the widget cache.");
    expect(body.indexOf("## What changed")).toBeLessThan(body.indexOf("## Stories"));
  });

  test("omits the heading entirely when there is no narrative", () => {
    // #1477 forbids an empty heading. Heading and text are produced by one
    // function so this is structural, not a rule someone has to remember.
    const body = buildFinishBody(baseCtx({ stories: [story()] }));
    expect(body).not.toContain("## What changed");
  });

  test("treats a whitespace-only narrative as absent", () => {
    const body = buildFinishBody(baseCtx({ stories: [story()], narrative: "  \n " }));
    expect(body).not.toContain("## What changed");
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

```bash
timeout 30 bun test test/unit/flows/nax-finish/pr-body.test.ts --timeout=5000
```

Expected: FAIL — `body.indexOf("## What changed")` is `-1`.

- [ ] **Step 8: Add the narrative to the body builder**

In `flows/nax-finish/steps/pr-body.ts`:

Extend the import from Task 3's module:

```typescript
import { readSpecSummary, resolveNarrative } from "../narrative";
```

Add to `interface FinishPrContext`, next to `template`:

```typescript
  /** Resolved "What changed" prose. Absent when neither source produced text. */
  narrative?: string;
```

Add this section builder next to `buildOutOfScopeSection`:

```typescript
/**
 * Heading and text are produced together, so "no text" cannot render a bare
 * `## What changed` heading — the empty-heading case #1477 forbids.
 */
function buildNarrativeSection(narrative: string | undefined): string | null {
  const text = narrative?.trim();
  if (!text) return null;
  return ["## What changed", text].join("\n\n");
}
```

In `buildFinishBody`, insert **before** the stories block:

```typescript
  const narrativeSection = buildNarrativeSection(ctx.narrative);
  if (narrativeSection !== null) sections.push(narrativeSection);
```

Widen `loadFinishPrContext`'s `args` to:

```typescript
  args: { base: string; gatesRan: string[]; forge?: Forge; specPath?: string; narrative?: string },
```

Add a sixth entry to the `Promise.all` — the spec read is independent of the PRD read and
must not serialise behind it:

```typescript
    readSpecSummary(args.specPath, _prBodyDeps.readText),
```

Destructure it as `specSummary` and widen the `as [...]` tuple with a final
`string | null`. Then add to the returned object:

```typescript
    narrative: resolveNarrative(args.narrative, specSummary),
```

- [ ] **Step 9: Run the flow test directory to verify it passes**

```bash
timeout 60 bun test test/unit/flows/nax-finish/ --timeout=5000
```

Expected: PASS.

- [ ] **Step 10: Typecheck and lint**

```bash
bun run typecheck && bun run lint
```

Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add flows/nax-finish/narrative.ts flows/nax-finish/steps/pr-body.ts \
  test/unit/flows/nax-finish/narrative.test.ts test/unit/flows/nax-finish/pr-body.test.ts
git commit -m "feat(finish): add the What changed narrative section and its fallback chain"
```

---

### Task 4: `open_pr` resolves the forge and routes to the narrative

Wires Tasks 2 and 3 into the existing `open_pr` node: detect the forge once, pass `specPath`
through so the PR opens carrying the mechanical fallback, and emit a route the new nodes
will hang off in Task 5.

**Files:**
- Modify: `flows/nax-finish/flow-ctx.ts`
- Modify: `flows/nax-finish/nax-finish.flow.ts:402-436` (the `open_pr` node)
- Test: `test/unit/flows/nax-finish/flow-graph-open-pr-metadata.test.ts`

**Interfaces:**
- Consumes: `loadFinishPrContext(input, { base, gatesRan, forge, specPath, narrative })`
  from Tasks 2 and 3; `openOrPromotePr(..., knownForge?)` from Task 2.
- Produces:
  - `narrativeOf(ctx): string | undefined` exported from `flow-ctx.ts` — Task 5 calls it.
  - `open_pr` returns `route: "narrate" | "done"`. Task 5 switches on it.
  - Module-level `NARRATIVE_ENABLED` constant in the flow file.

**Background:** `open_pr` already wraps body assembly in a try/catch that falls back to a
one-line body, because a corrupt artifact must not cost the PR. The forge detection goes
*inside* that try; if it throws, `forge` stays `undefined` and `openOrPromotePr` detects for
itself exactly as it does today. That preserves current behaviour on the failure path.

**Watch out:** the `nothing-to-finish` branch returns early and must keep returning
`route: "done"` — there is no diff to narrate.

- [ ] **Step 1: Write the failing test**

Add these inside the existing `describe("open_pr node — finish metadata ...")` block in
`test/unit/flows/nax-finish/flow-graph-open-pr-metadata.test.ts`. Its `mockCleanCommit()`,
`captureCreateTitleBody()`, `ctxOf`, `nodeRun`, `minimalCtx` and the `afterEach` restore are
already in scope, and `captureCreateTitleBody` already answers `git remote get-url` with
`git@github.com:o/r`, so `detectForge` resolves to `"github"` without shelling out:

```typescript
test("routes to narrate once the PR is open, so the narrative runs after it", async () => {
  mockCleanCommit();
  captureCreateTitleBody();
  _openPrDeps.loadFinishPrContext = async () => minimalCtx();

  const out = await nodeRun<{ route: string }>("open_pr").run(
    ctxOf({ outputs: { load_ctx: { route: "proceed", base: "origin/main", specPath: "/s.md" } } }),
  );

  expect(out.route).toBe("narrate");
});

test("routes to done for a nothing-to-finish run — there is no diff to narrate", async () => {
  _resultDeps.writeText = async () => {};

  const out = await nodeRun<{ route: string }>("open_pr").run(
    ctxOf({ outputs: { load_ctx: { route: "nothing-to-finish" } } }),
  );

  expect(out.route).toBe("done");
});

test("hands one detected forge to both the body builder and the PR opener", async () => {
  // Detecting separately in each would let the body and the create command
  // disagree about the forge.
  mockCleanCommit();
  captureCreateTitleBody();
  let forgeSeenByBody: string | undefined;
  _openPrDeps.loadFinishPrContext = async (_input, args) => {
    forgeSeenByBody = (args as { forge?: string }).forge;
    return minimalCtx();
  };

  await nodeRun("open_pr").run(
    ctxOf({ outputs: { load_ctx: { route: "proceed", base: "origin/main" } } }),
  );

  expect(forgeSeenByBody).toBe("github");
});

test("threads load_ctx.specPath into the body builder for the mechanical fallback", async () => {
  mockCleanCommit();
  captureCreateTitleBody();
  let specPathSeen: string | undefined;
  _openPrDeps.loadFinishPrContext = async (_input, args) => {
    specPathSeen = (args as { specPath?: string }).specPath;
    return minimalCtx();
  };

  await nodeRun("open_pr").run(
    ctxOf({ outputs: { load_ctx: { route: "proceed", base: "origin/main", specPath: "/spec.md" } } }),
  );

  expect(specPathSeen).toBe("/spec.md");
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
timeout 30 bun test test/unit/flows/nax-finish/flow-graph-open-pr-metadata.test.ts --timeout=5000
```

Expected: FAIL — `route` is `"done"` where `"narrate"` was expected, and both
`forgeSeenByBody` and `specPathSeen` are `undefined`.

- [ ] **Step 3: Add the `narrativeOf` reader**

In `flows/nax-finish/flow-ctx.ts`, next to `gateOutputs`:

```typescript
/**
 * The narrative node's parsed prose.
 *
 * Absent when the node was skipped by config, died, or produced only
 * whitespace — `amend_body` treats all three identically, so there is one
 * branch downstream rather than three.
 */
export function narrativeOf(ctx: OutputsCtx): string | undefined {
  const out = (ctx.outputs as Record<string, unknown>).narrative;
  return typeof out === "string" && out.trim().length > 0 ? out : undefined;
}
```

- [ ] **Step 4: Add the enable constant and rework `open_pr`**

In `flows/nax-finish/nax-finish.flow.ts`:

Extend the existing import from `"./steps"` to include `detectForge`, and add the `Forge`
type import:

```typescript
import type { Forge } from "./steps/forge";
```

Add this constant next to the other module-level reads, below the imports:

```typescript
/**
 * Disabled only on an explicit "0". An unset variable means enabled, so a flow
 * invoked directly by `acpx flow run` — outside the plugin that sets the env —
 * still writes the narrative.
 */
const NARRATIVE_ENABLED = process.env.NAX_FINISH_NARRATIVE !== "0";
```

Replace the body-assembly block inside `open_pr` (currently lines 415-434) with:

```typescript
        const fallbackTitle = `nax-finish: ${i.feature}`;
        const fallbackBody = `Automated finish of \`${i.feature}\`.`;
        let title = fallbackTitle;
        let body = fallbackBody;
        // Detected once, here, and handed to both the body builder (which needs
        // it for the repo template) and the opener. Detecting in both would let
        // them disagree. On a throw it stays undefined and `openOrPromotePr`
        // detects for itself, exactly as it did before.
        let forge: Forge | undefined;
        try {
          forge = await detectForge(_prBodyDeps.run, i.workdir, "finish-pr");
          const prCtx = await _openPrDeps.loadFinishPrContext(i, {
            base: loadCtx.base ?? "",
            gatesRan: gateOutputs(ctx).ran ?? [],
            forge,
            specPath: loadCtx.specPath,
          });
          title = _openPrDeps.buildFinishTitle(prCtx);
          body = _openPrDeps.buildFinishBody(prCtx);
        } catch (error) {
          _prBodyDeps.warn("[finish-pr] Falling back to default PR title/body", { path: i.prdPath, error });
          title = fallbackTitle;
          body = fallbackBody;
        }

        const r = await openOrPromotePr(i.workdir, i.branch, title, body, forge);
        await writeResult(i, { feature: i.feature, status: r.status, url: r.url });
        // The PR now exists with the mechanical narrative already in place.
        // Anything the narrative node does from here is an improvement on a
        // body that is already correct.
        return { route: NARRATIVE_ENABLED ? "narrate" : "done", committed: sync.committed, ...r };
```

Note `_prBodyDeps.run` rather than `_prDeps.run` — they are deliberately the *same object*
(see the comment in `steps/pr.ts`), and `_prBodyDeps` is already imported here.

Leave the `nothing-to-finish` early return exactly as it is.

- [ ] **Step 5: Run the test to verify it passes**

```bash
timeout 30 bun test test/unit/flows/nax-finish/flow-graph-open-pr-metadata.test.ts --timeout=5000
```

Expected: PASS.

- [ ] **Step 6: Run the whole flow directory and check the file cap**

```bash
timeout 60 bun test test/unit/flows/nax-finish/ --timeout=5000
wc -l flows/nax-finish/nax-finish.flow.ts
```

Expected: tests PASS; line count around 570 and **under 600**.

- [ ] **Step 7: Typecheck and lint**

```bash
bun run typecheck && bun run lint
```

Expected: clean, including `check:file-sizes`.

- [ ] **Step 8: Commit**

```bash
git add flows/nax-finish/flow-ctx.ts flows/nax-finish/nax-finish.flow.ts \
  test/unit/flows/nax-finish/flow-graph-open-pr-metadata.test.ts
git commit -m "feat(finish): resolve the forge once in open_pr and route to the narrative"
```

---

### Task 5: The narrative node, `amend_body`, and their edges

Adds the three new graph nodes and closes #1477.

**Files:**
- Create: `flows/nax-finish/steps/pr-narrative.ts`
- Modify: `flows/nax-finish/steps/index.ts`
- Modify: `flows/nax-finish/nax-finish.flow.ts`
- Test: `test/unit/flows/nax-finish/pr-narrative.test.ts`
- Test: `test/unit/flows/nax-finish/flow-graph.test.ts`

**Interfaces:**
- Consumes: `narrativeOf` and the `narrate` / `done` routes from Task 4;
  `buildNarrativePrompt` / `parseNarrative` from Task 3; `updatePrBody` from Task 2.
- Produces: nothing consumed by a later task — this is the last one.

**Background:** the graph gains
`open_pr --narrate--> narrative --> amend_body` and `open_pr --done--> finish_done`.
`finish_done` exists because an acpx `switch` case must name a real node; it is inert.

**Watch out:** `amend_body` must **never throw**. It runs after the PR is open and the result
file is written. A throw there fails the flow after all its real work succeeded. Every
failure path warns and returns.

- [ ] **Step 1: Write the failing `amend_body` tests**

Create `test/unit/flows/nax-finish/pr-narrative.test.ts`:

```typescript
/**
 * `amend_body` — rewriting the PR body once the narrative node produced prose.
 *
 * Runs after the PR is already open, so every assertion here is about NOT
 * failing: a throw would fail the flow after its real work succeeded.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { amendPrBodyNode } from "@flows/nax-finish/steps/pr-narrative";
import { _prBodyDeps } from "@flows/nax-finish/steps/pr-body";
import { makeFlowCtx } from "@test/helpers";

const INPUT = { feature: "x", workdir: "/repo", branch: "feat/x", prdPath: "p", escalateTelegram: false };

const origRun = _prBodyDeps.run;
const origWarn = _prBodyDeps.warn;
afterEach(() => {
  _prBodyDeps.run = origRun;
  _prBodyDeps.warn = origWarn;
});

const ctxWith = (narrative?: unknown) =>
  makeFlowCtx({
    input: INPUT,
    outputs: { load_ctx: { route: "proceed", base: "origin/main" }, narrative },
  });

describe("amendPrBodyNode", () => {
  test("issues no forge call when the narrative node produced nothing", async () => {
    const calls: string[][] = [];
    _prBodyDeps.run = async (cmd) => {
      calls.push(cmd);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const out = await amendPrBodyNode(ctxWith(undefined));
    expect(out).toEqual({ route: "done", amended: false });
    expect(calls).toEqual([]);
  });

  test("treats a whitespace-only narrative as nothing", async () => {
    const out = await amendPrBodyNode(ctxWith("   \n  "));
    expect(out.amended).toBe(false);
  });

  test("warns instead of throwing when the forge edit fails", async () => {
    const warnings: string[] = [];
    _prBodyDeps.warn = (message) => warnings.push(message);
    _prBodyDeps.run = async () => {
      throw new Error("gh exploded");
    };
    const out = await amendPrBodyNode(ctxWith("real prose"));
    expect(out).toEqual({ route: "done", amended: false });
    expect(warnings.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
timeout 30 bun test test/unit/flows/nax-finish/pr-narrative.test.ts --timeout=5000
```

Expected: FAIL — cannot resolve `@flows/nax-finish/steps/pr-narrative`.

- [ ] **Step 3: Create the `amend_body` step**

Create `flows/nax-finish/steps/pr-narrative.ts`:

```typescript
/**
 * `amend_body` — rewrite the PR body once the narrative node has produced prose.
 *
 * Runs *after* the PR is open and its result file written, which is the whole
 * point: acpx has no error edge, so an acp node placed before `open_pr` could
 * kill the flow and cost the PR. Here the worst case is a body missing one
 * section.
 *
 * Every failure is warned and swallowed for the same reason — a throw would
 * fail a flow whose real work already succeeded.
 */
import { gateOutputs, inputOf, loadCtxOf, narrativeOf } from "../flow-ctx";
import { detectForge } from "./forge";
import { _prBodyDeps, buildFinishBody, buildFinishTitle, loadFinishPrContext } from "./pr-body";
import { updatePrBody } from "./pr";

export async function amendPrBodyNode(ctx: {
  input: unknown;
  outputs: unknown;
}): Promise<{ route: "done"; amended: boolean }> {
  const narrative = narrativeOf(ctx);
  // Nothing to add: the body already in place is correct, and rewriting it
  // identically would spend a forge call to change nothing.
  if (!narrative) return { route: "done", amended: false };

  const i = inputOf(ctx);
  const loadCtx = loadCtxOf(ctx);
  try {
    const forge = await detectForge(_prBodyDeps.run, i.workdir, "finish-pr");
    const prCtx = await loadFinishPrContext(i, {
      base: loadCtx.base ?? "",
      gatesRan: gateOutputs(ctx).ran ?? [],
      forge,
      specPath: loadCtx.specPath,
      narrative,
    });
    await updatePrBody(forge, i.workdir, i.branch, buildFinishTitle(prCtx), buildFinishBody(prCtx));
    return { route: "done", amended: true };
  } catch (error) {
    _prBodyDeps.warn("[finish-pr] Failed to amend the PR body with the narrative", { path: i.branch, error });
    return { route: "done", amended: false };
  }
}
```

Add to `flows/nax-finish/steps/index.ts`:

```typescript
export * from "./pr-narrative";
```

- [ ] **Step 4: Run it to verify it passes**

```bash
timeout 30 bun test test/unit/flows/nax-finish/pr-narrative.test.ts --timeout=5000
```

Expected: PASS.

- [ ] **Step 5: Write the failing graph-shape tests**

Add to `test/unit/flows/nax-finish/flow-graph.test.ts`. The file already has `switchOf` and
`toOf` helpers at lines 23-31 — use them:

```typescript
test("narrative nodes exist and the acp node is isolated", () => {
  for (const n of ["narrative", "amend_body", "finish_done"]) {
    expect(flow.nodes[n]).toBeDefined();
  }
  expect(flow.nodes.narrative.nodeType).toBe("acp");
  expect((flow.nodes.narrative as { session?: { isolated?: boolean } }).session?.isolated).toBe(true);
  expect(flow.nodes.amend_body.nodeType).toBe("action");
});

test("open_pr routes narrate to the narrative node and done to the terminal", () => {
  expect(switchOf("open_pr").cases.narrate).toBe("narrative");
  expect(switchOf("open_pr").cases.done).toBe("finish_done");
});

test("the narrative runs after the PR is open, never before it", () => {
  // acpx has no error edge: an acp node before open_pr could fail the flow and
  // cost the PR entirely (#1476). This edge direction is the guarantee.
  expect(switchOf("quality_gates").cases.green).toBe("open_pr");
  expect(toOf("narrative")).toBe("amend_body");
});

test("amend_body and finish_done are terminal", () => {
  for (const id of ["amend_body", "finish_done"]) {
    expect(flow.edges.find((e) => e.from === id)).toBeUndefined();
  }
});

test("the key amend_body reads is the key the narrative node writes", () => {
  // A string-keyed handoff asserted from only one side is how ACs go green
  // while nothing is wired. `narrativeOf` reads `ctx.outputs.narrative`; the
  // node id below is what acpx keys that output by.
  expect(flow.nodes.narrative).toBeDefined();
  expect(narrativeOf({ outputs: { narrative: "prose" } })).toBe("prose");
  expect(narrativeOf({ outputs: {} })).toBeUndefined();
});
```

Add `import { narrativeOf } from "@flows/nax-finish/flow-ctx";` to the file's imports.

- [ ] **Step 6: Run it to verify it fails**

```bash
timeout 30 bun test test/unit/flows/nax-finish/flow-graph.test.ts --timeout=5000
```

Expected: FAIL — `flow.nodes.narrative` is `undefined`.

- [ ] **Step 7: Add the three nodes and two edges**

In `flows/nax-finish/nax-finish.flow.ts`:

Add imports:

```typescript
import { buildNarrativePrompt, parseNarrative } from "./narrative";
```

and extend the existing `"./steps"` import to include `amendPrBodyNode`.

Add these nodes immediately after the `open_pr` node:

```typescript
    narrative: {
      nodeType: "acp",
      session: { isolated: true },
      profile: process.env.NAX_FINISH_NARRATIVE_PROFILE || undefined,
      prompt: (ctx) => buildNarrativePrompt({ base: loadCtxOf(ctx).base ?? "origin/main" }),
      parse: parseNarrative,
    },
    amend_body: {
      nodeType: "action",
      run: amendPrBodyNode,
    },
    // Inert terminal. acpx switch cases must name a real node, so the `done`
    // route out of open_pr needs somewhere to land.
    finish_done: {
      nodeType: "compute",
      run: () => ({ route: "done" }),
    },
```

Add these edges to the `edges` array, after the `quality_gates` switch:

```typescript
    // The narrative runs only once the PR exists. acpx has no error edge, so an
    // acp node before `open_pr` would be able to fail the flow and cost the PR.
    { from: "open_pr", switch: { on: "$.route", cases: { narrate: "narrative", done: "finish_done" } } },
    { from: "narrative", to: "amend_body" },
```

- [ ] **Step 8: Run the full flow directory and check the file cap**

```bash
timeout 60 bun test test/unit/flows/nax-finish/ --timeout=5000
wc -l flows/nax-finish/nax-finish.flow.ts
```

Expected: tests PASS; line count under 600. If it is over, move the `narrative` node's
`prompt` arrow function into a named export in `narrative.ts` and reference it — do **not**
raise the cap.

- [ ] **Step 9: Full verification**

```bash
bun run typecheck && bun run lint && bun run test
```

Expected: all clean. `bun run lint` must pass `check:flows-no-bun` and `check:file-sizes`.

- [ ] **Step 10: Commit**

```bash
git add flows/nax-finish/steps/pr-narrative.ts flows/nax-finish/steps/index.ts \
  flows/nax-finish/nax-finish.flow.ts test/unit/flows/nax-finish/pr-narrative.test.ts \
  test/unit/flows/nax-finish/flow-graph.test.ts
git commit -m "feat(finish): write a What changed narrative and amend the PR body with it

Closes #1477."
```

---

## Final verification before opening the PR

- [ ] **Full gates green**

```bash
bun run typecheck && bun run lint && bun run test
```

- [ ] **Confirm the flow file is under the cap**

```bash
wc -l flows/nax-finish/nax-finish.flow.ts
```

Expected: under 600.

- [ ] **Confirm no `Bun.*` leaked into `flows/`**

```bash
bun run check:flows-no-bun
```

- [ ] **Re-read the design doc's error-handling table** and confirm each row is true of the
  code you wrote. The rows are the acceptance criteria for #1477's "must never block the PR"
  constraint.

- [ ] **Open the PR** referencing both issues:

```bash
git push -u origin feat/finish-pr-narrative-and-template
gh pr create --title "feat(finish): PR body narrative and repository template" \
  --body "Closes #1477. Closes #1478.

See docs/superpowers/specs/2026-08-06-finish-pr-narrative-and-template-design.md"
```

## Known gaps a reviewer should be told about

State these plainly in the PR rather than letting a reviewer discover them.

1. **The narrative node's behaviour is not tested end-to-end.** acpx is not a test harness
   and this repo does not execute acpx in tests. Every guarantee is on a pure function or on
   the graph's declared shape. Nothing here proves the model writes a *good* narrative — only
   that a bad or absent one cannot damage the PR.
2. **`amend_body` re-reads the PRD, status, spec and diffstat** that `open_pr` just read.
   Nothing changes on disk between them, so the rebuild is deterministic; it costs one extra
   `git diff --stat` and three file reads to avoid carrying a whole PR body through flow
   state.
3. **The PR body is written twice** on the happy path — once at create/promote, once at
   amend. That is a second `gh pr edit` call and a second entry in the PR's edit history.
