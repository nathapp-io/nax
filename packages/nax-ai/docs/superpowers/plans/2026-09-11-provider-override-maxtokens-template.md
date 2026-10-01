# Provider-override maxTokens and template selection (issue #39) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An override model's declared output ceiling always reaches the wire, and the sibling it inherits other fields from is picked by a deliberate rule rather than by catalog position.

**Architecture:** Two independent halves, both contained. (A) `ResolvedModel` gains an optional `maxTokens`; `pi-catalog.ts` fills it for every bundled model, `normaliseCatalog` carries it, and `synthesiseModel` prefers the override's value over the template's. (B) A new pure `pickTemplate()` replaces the `.find()` in `synthesiseModel` and selects the same-provider/same-api sibling with the largest `contextWindow`, breaking ties by larger `maxTokens` then by id, so a pi-ai catalog bump cannot silently change what an override inherits.

**Tech Stack:** TypeScript 7 (exact pin, `strict`, `exactOptionalPropertyTypes`, `nodenext`), Vitest, Biome. Bun is used to run scripts, never assumed at runtime.

**Spec:** GitHub issue #39 — https://github.com/nathapp-io/nax-ai/issues/39 (option "A + B"; option C was rejected there). Supersedes the behaviour documented on `synthesiseModel` in `src/protocols/pi-client.ts:439-455`.

## Global Constraints

- Node >= 22.19, ESM-only. No `Bun.*` and no `bun:` imports in `src/` (`bun run check:no-bun-apis`).
- Only `src/protocols/pi-client.ts`, `src/providers/pi-catalog.ts` and `src/auth/pi-auth.ts` may import `@earendil-works/pi-ai` (`bun run check:pi-ai-imports`). Test files may import pi-ai.
- `@earendil-works/pi-ai` stays pinned at `0.85.1`. Do not bump it in this plan.
- `exactOptionalPropertyTypes` is on: build optional properties conditionally (`...(x !== undefined ? { x } : {})`); never assign `undefined` and never fabricate a value that was not supplied.
- Imports carry explicit `.ts` extensions (`nodenext`, not bundler).
- `ResolvedModel.maxTokens` and `RawModel.maxTokens` must be **optional** so the public type stays source-compatible (issue #39, option A). Do not make them required.
- Issue #39's smaller leftover — `supportsTools` not reaching the wire because pi's `Model` has no counterpart field — is explicitly out of scope. Do not change it.
- Tests live under `test/`, mirror `src/`, and are named `*.test.ts`. Live tests under `test/live/*.live.test.ts` are excluded from `bun run test`; they need real keys and spend money, so they are not run here.
- A regression test must be run and seen to fail against the pre-change code before it counts (repo rule; the steps below build that in).
- Formatting: Biome, 2-space indent, 120 columns. `noNonNullAssertion` is an error in tests; do not use `!`.
- Commands: `bun run test`, `bun run test <path>` (Vitest file filter), `bun run typecheck`, `bun run lint`.

---

### Task 1: Carry `maxTokens` from the catalog into `ResolvedModel` (A, catalog half)

**Files:**
- Modify: `src/providers/types.ts` (`ResolvedModel`, lines 56-66)
- Modify: `src/providers/catalog.ts` (`RawModel` lines 18-26; `normaliseCatalog` model literal lines 79-89)
- Modify: `src/providers/pi-catalog.ts` (bundled model mapping, lines 66-94)
- Test: `test/providers/catalog.test.ts` (append to the `normaliseCatalog` describe, before line 234's `});`)
- Test: `test/providers/pi-catalog.test.ts` (after the test ending line 25)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ResolvedModel.maxTokens?: number` and `RawModel.maxTokens?: number`; every model returned by `defaultProviders()` / `piProviders()` carries a numeric `maxTokens`; `normaliseCatalog` copies the field only when the raw model declares one.

- [ ] **Step 1: Write the failing catalog tests**

Append to the `describe("normaliseCatalog", ...)` block in `test/providers/catalog.test.ts` (after the "accepts an api-key provider that declares no env var name" test, before the closing `});`):

```ts
  it("carries maxTokens from a raw model into the resolved catalog", () => {
    const catalog = normaliseCatalog([
      {
        id: "acme",
        baseUrl: "https://api.acme.test",
        auth: { kind: "api-key" },
        defaultProtocol: "openai-completions",
        models: [
          {
            id: "acme-one",
            pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1000,
            maxTokens: 500,
            supportsTools: true,
            thinkingLevels: [],
          },
        ],
      },
    ]);

    expect(catalog.model("acme", "acme-one")?.maxTokens).toBe(500);
  });

  it("leaves maxTokens absent when the raw model declares none", () => {
    const model = normaliseCatalog(RAW).model("deepseek", "deepseek-chat");
    expect(model).not.toHaveProperty("maxTokens");
  });
```

Add to `test/providers/pi-catalog.test.ts` after the "carries model metadata through into our own shape" test:

```ts
  it("carries every bundled model's output ceiling", async () => {
    const [deepseek] = await piProviders(["deepseek"]);
    const models = deepseek?.models ?? [];
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.maxTokens).toBeGreaterThan(0);
    }
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test test/providers/catalog.test.ts test/providers/pi-catalog.test.ts`

Expected: FAIL on "carries maxTokens from a raw model into the resolved catalog" (`undefined` not `500`) and on "carries every bundled model's output ceiling" (`undefined` not > 0). The absence test passes — it is a shape guard for the conditional spread, not a regression test.

- [ ] **Step 3: Implement the type and the two mappings**

In `src/providers/types.ts`, add to `ResolvedModel` after `contextWindow: number;` (line 62):

```ts
  /**
   * The output ceiling this model declares, when one is known. Absent for a
   * hand-built catalog that does not state it; every model from
   * `defaultProviders()` carries pi-ai's value. A consumer can size requests
   * against it, and an override that declares one is no longer clamped to a
   * templated sibling's smaller value at the wire.
   */
  readonly maxTokens?: number;
```

In `src/providers/catalog.ts`, add to `RawModel` after `contextWindow: number;` (line 23):

```ts
  /**
   * Output ceiling. Optional: a hand-built catalog need not state it, and
   * nax-ai never invents a value it was not given.
   */
  readonly maxTokens?: number;
```

In the same file, inside `normaliseCatalog`'s raw-model literal, add after `contextWindow: rawModel.contextWindow,` (line 85):

```ts
        ...(rawModel.maxTokens !== undefined ? { maxTokens: rawModel.maxTokens } : {}),
```

In `src/providers/pi-catalog.ts`, add after `contextWindow: model.contextWindow,` (line 88) in the `RawModel` mapping:

```ts
      maxTokens: model.maxTokens,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run test test/providers/catalog.test.ts test/providers/pi-catalog.test.ts`

Expected: PASS, all tests in both files.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck`
Expected: no output, exit 0.

```bash
git add src/providers/types.ts src/providers/catalog.ts src/providers/pi-catalog.ts test/providers/catalog.test.ts test/providers/pi-catalog.test.ts
git commit -m "feat(providers): carry maxTokens into ResolvedModel (#39)"
```

---

### Task 2: The override's own `maxTokens` reaches the wire (A, wire half)

**Files:**
- Modify: `src/protocols/pi-client.ts` (`synthesiseModel`, doc lines 439-455, return lines 464-477)
- Modify: `test/live/provider-overrides.live.test.ts` (override literal lines 25-40; assertions around line 59)
- Test: `test/protocols/pi-client-overrides.test.ts` (add after the first test, which ends line 107)

**Interfaces:**
- Consumes: `ResolvedModel.maxTokens?: number` from Task 1.
- Produces: the model `createPiDeps().resolveModel()` returns for an override carries `model.maxTokens` when the override declared it, otherwise `template.maxTokens`.

- [ ] **Step 1: Write the failing wire test**

Add to the `describe("provider overrides at the protocol seam", ...)` block in `test/protocols/pi-client-overrides.test.ts`, after the test ending at line 107:

```ts
  it("sends the override's own maxTokens when it declares one", async () => {
    const stub = stubStream();
    const deps = createPiDeps(
      { providerOverrides: [{ provider: "openai", models: [{ ...PHANTOM_MODEL, maxTokens: 2048 }] }] },
      stub.streamSimple,
    );

    await drive(deps, PHANTOM, "openai");

    expect(stub.models[0]?.maxTokens).toBe(2048);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test test/protocols/pi-client-overrides.test.ts`

Expected: FAIL on the new test — received `8192` (the current first-in-catalog template, `gpt-4`, wins because `synthesiseModel` never sets `maxTokens`), not `2048`.

- [ ] **Step 3: Implement the precedence in `synthesiseModel`**

In `src/protocols/pi-client.ts`, in the returned literal of `synthesiseModel`, add after `contextWindow: model.contextWindow,` (line 472):

```ts
    // The override's own ceiling wins; the template's is only a fallback for
    // an override that states none. pi clamps to `model.maxTokens` in
    // buildBaseOptions whenever a request omits its own cap, and anthropic's
    // thinking adjustment clamps to it even when a caller supplies one, so
    // inheriting a smaller sibling's value is a silent truncation.
    maxTokens: model.maxTokens ?? template.maxTokens,
```

Then update the doc comment paragraph (currently lines 442-447) so it no longer lists `maxTokens` as missing. Replace:

```ts
 * `ResolvedModel` is deliberately narrower than pi's `Model`: it carries no
 * `name`, `maxTokens`, `baseUrl`, `input` or `compat`, and those are not
 * optional on the wire side. Inventing values for them would be guessing at
 * provider behaviour, so instead every field the override does not speak about
 * is inherited from a bundled model of the same provider on the same api — the
 * closest thing to "what this provider's models look like" that exists.
```

with:

```ts
 * `ResolvedModel` is deliberately narrower than pi's `Model`: it carries no
 * `name`, `baseUrl`, `input` or `compat`, and those are not optional on the
 * wire side. Inventing values for them would be guessing at provider behaviour,
 * so instead every field the override does not speak about is inherited from a
 * bundled model of the same provider on the same api — the closest thing to
 * "what this provider's models look like" that exists. `maxTokens` is not in
 * that list: `ResolvedModel` carries it, so an override that declares one has
 * it sent (`model.maxTokens ?? template.maxTokens`) rather than clamped to the
 * template's.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test test/protocols/pi-client-overrides.test.ts`

Expected: PASS, all tests in the file.

- [ ] **Step 5: Make the live fixture exercise the declared ceiling, typecheck, commit**

In `test/live/provider-overrides.live.test.ts`, add `maxTokens: 8_192,` after `contextWindow: 128_000,` (line 34), and after `expect(model.contextWindow).toBe(128_000);` (line 60) add:

```ts
    expect(model.maxTokens).toBe(8_192);
```

Do not run the live suite (`bun run test:live` needs provider keys and spends money).

Run: `bun run typecheck`
Expected: no output, exit 0.

```bash
git add src/protocols/pi-client.ts test/protocols/pi-client-overrides.test.ts test/live/provider-overrides.live.test.ts
git commit -m "fix(protocols): honour an override model's own maxTokens (#39)"
```

---

### Task 3: Pick the template by largest context window (B)

**Files:**
- Modify: `src/protocols/pi-client.ts` (add `pickTemplate` above `synthesiseModel`; replace the `.find()` at line 457)
- Test: `test/protocols/pi-client.test.ts` (import line 3; add tests before `describe("toPiOptions", ...)` at line 180)
- Test: `test/protocols/pi-client-overrides.test.ts` (add after the Task 2 test)

**Interfaces:**
- Consumes: `synthesiseModel`'s doc/return from Task 2; `ResolvedModel.maxTokens` from Task 1.
- Produces: `export function pickTemplate(models: readonly Model<Api>[], protocol: string): Model<Api> | undefined` — the single sibling-selection rule used by `synthesiseModel`.

**Why the id tie-break (a plan decision beyond the issue's wording):** in the pinned 0.85.1 snapshot, 38 of 50 provider/api groups have more than one sibling at the maximum `contextWindow` (openai-responses alone ties at 1,050,000 between `gpt-5.4-pro` and `gpt-5.5-pro`). Largest-context-window alone therefore leaves the choice position-dependent for most providers. `contextWindow` → `maxTokens` → id makes the pick a total order, which is what actually removes the catalog-ordering instability the issue asks B to remove. id is the last key and is explicitly a stability measure, not a quality ranking.

- [ ] **Step 1: Write the failing integration test**

Add to `test/protocols/pi-client-overrides.test.ts`, after the Task 2 test:

```ts
  it("templates an override from the provider's largest-context sibling, not the first in catalog order", async () => {
    const stub = stubStream();
    const deps = createPiDeps({ providerOverrides: OVERRIDES }, stub.streamSimple);

    await drive(deps, PHANTOM, "openai");

    const wire = stub.models[0];
    // The first openai-responses sibling in catalog order is gpt-4: 8192
    // context, 8192 output, text-only input. The largest is a 1,050,000-context
    // sibling with a 128,000 output ceiling that accepts images.
    expect(wire?.maxTokens).toBe(128_000);
    expect(wire?.input).toEqual(["text", "image"]);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test test/protocols/pi-client-overrides.test.ts`

Expected: FAIL on the new test — `maxTokens` received `8192` and `input` received `["text"]`, because the override (which declares no `maxTokens` of its own) still inherits from the catalog-order first sibling.

- [ ] **Step 3: Write the failing unit tests for the selection rule**

In `test/protocols/pi-client.test.ts`, add `pickTemplate` to the import on line 3, then insert before `describe("toPiOptions", ...)` (line 180):

```ts
function sibling(id: string, contextWindow: number, maxTokens: number, api: Api = "openai-completions"): Model<Api> {
  return { ...MODEL, id, name: id, api, contextWindow, maxTokens };
}

describe("pickTemplate", () => {
  it("returns undefined when no sibling is on the requested protocol", () => {
    const only = sibling("a", 1000, 100, "anthropic-messages");
    expect(pickTemplate([only], "openai-completions")).toBeUndefined();
  });

  it("picks the largest contextWindow even when a smaller sibling comes first", () => {
    const candidates = [sibling("small", 8192, 8192), sibling("large", 128000, 32000)];
    expect(pickTemplate(candidates, "openai-completions")?.id).toBe("large");
  });

  it("breaks a contextWindow tie by the larger output ceiling", () => {
    const candidates = [sibling("low", 1000, 100), sibling("high", 1000, 2000)];
    expect(pickTemplate(candidates, "openai-completions")?.id).toBe("high");
  });

  it("breaks a full tie by id so array order cannot decide it", () => {
    const candidates = [sibling("b", 1000, 100), sibling("a", 1000, 100)];
    expect(pickTemplate(candidates, "openai-completions")?.id).toBe("a");
  });
});
```

- [ ] **Step 4: Run the unit tests to verify they fail**

Run: `bun run test test/protocols/pi-client.test.ts`

Expected: FAIL — `pickTemplate` is not exported from `src/protocols/pi-client.ts`.

- [ ] **Step 5: Implement `pickTemplate` and use it**

In `src/protocols/pi-client.ts`, insert directly above the `synthesiseModel` doc comment (line 439):

```ts
/**
 * The bundled sibling an override model is templated from.
 *
 * The rule is deliberate rather than positional. Taking the first model on the
 * api meant the choice was an artefact of the snapshot's array order: a pi-ai
 * bump that reordered or inserted models silently changed which `input`,
 * `compat` and `thinkingLevelMap` an existing override inherited. Largest
 * `contextWindow` is the closest data-driven proxy for "the model this
 * override is a sibling of"; larger `maxTokens` breaks a context tie, and id is
 * the final key so the pick is a total order that cannot move when the catalog
 * is merely reordered. The id key is a stability measure, not a quality
 * ranking.
 */
export function pickTemplate(models: readonly Model<Api>[], protocol: string): Model<Api> | undefined {
  let best: Model<Api> | undefined;
  for (const candidate of models) {
    if (candidate.api !== protocol) continue;
    if (best === undefined || isBetterTemplate(candidate, best)) best = candidate;
  }
  return best;
}

function isBetterTemplate(candidate: Model<Api>, best: Model<Api>): boolean {
  if (candidate.contextWindow !== best.contextWindow) return candidate.contextWindow > best.contextWindow;
  if (candidate.maxTokens !== best.maxTokens) return candidate.maxTokens > best.maxTokens;
  return candidate.id < best.id;
}
```

Replace line 457 inside `synthesiseModel`:

```ts
  const template = base.getModels().find((candidate) => candidate.api === model.protocol);
```

with:

```ts
  const template = pickTemplate(base.getModels(), model.protocol);
```

Leave the `undefined` guard and its error message unchanged — `test/protocols/pi-client-overrides.test.ts` pins that message by regex.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun run test test/protocols/pi-client.test.ts test/protocols/pi-client-overrides.test.ts`

Expected: PASS, all tests in both files, including the four `pickTemplate` unit tests and the integration test from Step 1.

- [ ] **Step 7: Run the full gates and commit**

Run, in order:

```bash
bun run test
bun run typecheck
bun run lint
```

Expected: full suite PASS (live tests excluded by config); `typecheck` exits 0 with no output; `lint` prints `check-pi-ai-imports: clean` and `check-no-bun-apis: clean` (or equivalent clean output) and exits 0.

```bash
git add src/protocols/pi-client.ts test/protocols/pi-client.test.ts test/protocols/pi-client-overrides.test.ts
git commit -m "fix(protocols): template override models by largest context window (#39)"
```

---

## Final verification (no commit)

Run once more from the repo root after Task 3's commit:

```bash
bun run test
bun run typecheck
bun run lint
```

Expected: all three green. Then confirm the two behaviours from the issue by hand if desired:

- A: an override model that declares `maxTokens: 2000` resolves (client side and at `createPiDeps().resolveModel()`) with `maxTokens === 2000`.
- B: an override for `openai` on `openai-responses` that declares no `maxTokens` inherits `128000` (the largest-context sibling), not `8192` (gpt-4), and inherits that sibling's `input` (`["text", "image"]`).

## Self-review notes

- **Spec coverage:** A → Tasks 1 (catalog/type) and 2 (wire precedence); B → Task 3. C is rejected in the issue and not implemented. `supportsTools` is out of scope per Global Constraints. The issue's two silent pi-ai paths (caller omits `maxTokens`; anthropic thinking clamps even an explicit cap) are both addressed by `synthesiseModel` sending the override's own value.
- **Placeholder scan:** none — every step names exact files, code, commands and expected results.
- **Type consistency:** `maxTokens?: number` on both `ResolvedModel` and `RawModel`; `pickTemplate(models: readonly Model<Api>[], protocol: string): Model<Api> | undefined`; the test helper `sibling` produces `Model<Api>` compatible with `MODEL`.
