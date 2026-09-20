# Strict Tool Sampling Capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface pi-ai's explicitly declared per-model strict-tool-schema capability in nax-ai's raw and resolved provider catalog, so consumers can select models known to support strict tool sampling.

**Architecture:** Add an optional `supportsStrictToolSampling` declaration to nax-ai's catalog vocabulary. `defaultProviders()` projects only an explicit pi compatibility declaration and `normaliseCatalog()` conditionally preserves it into `ResolvedModel`; absence remains unknown rather than becoming `false`. This is an enabler for issue #1796, not a structured-output API: no request, protocol, completion, tool-choice, or pi-ai behavior changes.

**Tech Stack:** TypeScript 7, Vitest, `@earendil-works/pi-ai` 0.85.1, Biome.

**Spec:** [nathapp-io/nax issue #1796](https://github.com/nathapp-io/nax/issues/1796) — the nax-ai catalog-capability unblocker identified in its current follow-up.

## Global Constraints

- Node >=22.19, ESM-only; imports in `src/` use explicit `.ts` extensions.
- Keep `exactOptionalPropertyTypes`: omit optional fields with conditional spreads; never assign `undefined`.
- Only `src/protocols/pi-client.ts`, `src/providers/pi-catalog.ts`, and `src/auth/pi-auth.ts` may import pi-ai.
- `supportsStrictToolSampling` means only strict JSON Schema **tool-argument** sampling; it must not be named or documented as structured output.
- `true` and `false` come only from an explicit pi compatibility property; missing upstream metadata remains absent/unknown.
- This field does not reproduce pi adapter defaults, endpoint auto-detection, or model-ID inference. A missing value means nax-ai makes no declaration about pi's effective runtime behavior.
- Do not modify pi-ai, add dependencies, change `ProtocolRequest.toolChoice`, synthesize output tools, or add a `structuredOutput` request/result API.
- Required quality commands: `bun run test`, `bun run typecheck`, and `bun run lint`.

## Review Focus

- An upstream model whose compatibility field is absent must produce no `supportsStrictToolSampling` property, not `false`; test this in catalog normalization.
- An Anthropic Messages model must read `compat.supportsStrictTools`, not the OpenAI-style `supportsStrictMode`; test this using the bundled catalog.
- A non-Anthropic model with explicit `compat.supportsStrictMode` must project that exact value; test this using the bundled catalog.
- A hand-written or override-supplied model declaring `true` or `false` must retain its exact declaration after normalization; test both values.
- The public documentation must not imply a model can be forced to call a tool or return a schema-shaped completion; test only the catalog capability and retain the existing `toolChoice` contract unchanged.

---

## File Structure

- Modify: `src/providers/catalog.ts` — declare the raw capability and copy it to a normalized model when present.
- Modify: `src/providers/types.ts` — expose the resolved capability and document its precise, deliberately narrow semantics.
- Modify: `src/providers/pi-catalog.ts` — project protocol-relevant explicit pi compatibility metadata into `RawModel`.
- Modify: `test/providers/catalog.test.ts` — prove true, false, and absent values survive normalization correctly.
- Modify: `test/providers/pi-catalog.test.ts` — prove bundled Anthropic and non-Anthropic model metadata is selected from the correct pi compatibility property.
- Modify: `README.md` — add one sentence to constrained-sampling documentation explaining how consumers identify models explicitly declared capable; do not promise required tool invocation or structured completions.

### Task 1: Define and preserve the provider-neutral capability

**Files:**

- Modify: `src/providers/catalog.ts:18-31, 83-95`
- Modify: `src/providers/types.ts:56-91`
- Modify: `test/providers/catalog.test.ts:235-261`

**Interfaces:**

- Consumes: `RawModel`, supplied by `defaultProviders()` or a consumer's hand-built `RawProvider` catalog.
- Produces: `RawModel.supportsStrictToolSampling?: boolean` and `ResolvedModel.supportsStrictToolSampling?: boolean`.
- Contract: `true` means the catalog explicitly declares strict JSON Schema tool-argument sampling support; `false` means it explicitly declares no support; an absent property means unknown and must not be treated as either value.

- [ ] **Step 1: Write the failing normalization tests**

Add these three cases at the end of `describe("normaliseCatalog", ...)` in `test/providers/catalog.test.ts`:

```ts
it("carries an explicitly supported strict-tool-sampling declaration into the resolved catalog", () => {
  const catalog = normaliseCatalog([{ ...DEEPSEEK, models: [{ ...DEEPSEEK.models[0]!, supportsStrictToolSampling: true }] }]);
  expect(catalog.model("deepseek", "deepseek-chat")?.supportsStrictToolSampling).toBe(true);
});

it("carries an explicitly unsupported strict-tool-sampling declaration into the resolved catalog", () => {
  const catalog = normaliseCatalog([{ ...DEEPSEEK, models: [{ ...DEEPSEEK.models[0]!, supportsStrictToolSampling: false }] }]);
  expect(catalog.model("deepseek", "deepseek-chat")?.supportsStrictToolSampling).toBe(false);
});

it("leaves strict-tool-sampling absent when the raw catalog makes no declaration", () => {
  const model = normaliseCatalog(RAW).model("deepseek", "deepseek-chat");
  expect(model).not.toHaveProperty("supportsStrictToolSampling");
});

it("retains both strict-tool-sampling declarations on override models", () => {
  const catalog = normaliseCatalog(RAW, [
    {
      provider: "deepseek",
      models: [
        {
          id: "strict-override-supported",
          provider: "deepseek",
          protocol: "openai-completions",
          pricing: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100,
          supportsTools: true,
          supportsStrictToolSampling: true,
          thinkingLevels: [],
        },
        {
          id: "strict-override-unsupported",
          provider: "deepseek",
          protocol: "openai-completions",
          pricing: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100,
          supportsTools: true,
          supportsStrictToolSampling: false,
          thinkingLevels: [],
        },
      ],
    },
  ]);
  expect(catalog.model("deepseek", "strict-override-supported")?.supportsStrictToolSampling).toBe(true);
  expect(catalog.model("deepseek", "strict-override-unsupported")?.supportsStrictToolSampling).toBe(false);
});
```

- [ ] **Step 2: Run the focused test file to verify it fails**

Run: `bun x vitest --run test/providers/catalog.test.ts`

Expected: TypeScript/Vitest failure because `supportsStrictToolSampling` is not declared on `RawModel` or `ResolvedModel`.

- [ ] **Step 3: Add the optional public catalog fields**

In `src/providers/catalog.ts`, append this member after `supportsTools` in `RawModel`:

```ts
  /**
   * Explicit per-model declaration for strict JSON Schema tool-argument
   * sampling. Absent means the catalog does not know; it is not `false`.
   */
  readonly supportsStrictToolSampling?: boolean;
```

In `src/providers/types.ts`, append the corresponding member after `supportsTools` in `ResolvedModel`:

```ts
  /**
   * Explicit per-model support for strict JSON Schema tool-argument sampling.
   * This is not structured-output support and does not imply a tool call can
   * be required. Absent means unknown, not unsupported.
   */
  readonly supportsStrictToolSampling?: boolean;
```

- [ ] **Step 4: Preserve the field without manufacturing an absent value**

In the `setModel(rawProvider.id, { ... })` object inside `normaliseCatalog()`, place this conditional spread immediately after `supportsTools`:

```ts
        ...(rawModel.supportsStrictToolSampling !== undefined
          ? { supportsStrictToolSampling: rawModel.supportsStrictToolSampling }
          : {}),
```

Do not alter the override loop: override models are already `ResolvedModel` values and `setModel()` stores them directly.

- [ ] **Step 5: Run the focused test file to verify it passes**

Run: `bun x vitest --run test/providers/catalog.test.ts`

Expected: PASS; the new cases distinguish `true`, `false`, and an omitted property.

- [ ] **Step 6: Commit the catalog vocabulary change**

```bash
git add src/providers/catalog.ts src/providers/types.ts test/providers/catalog.test.ts
git commit -m "feat: expose strict tool sampling catalog capability"
```

### Task 2: Project explicit pi compatibility metadata at the catalog boundary

**Files:**

- Modify: `src/providers/pi-catalog.ts:49-109`
- Modify: `test/providers/pi-catalog.test.ts:1-78`

**Interfaces:**

- Consumes: pi `getBuiltinModels()` entries whose protocol is `model.api` and whose optional `model.compat` exposes `supportsStrictTools` (Anthropic Messages) or `supportsStrictMode` (other supported protocols).
- Produces: `RawModel.supportsStrictToolSampling` only when the protocol-relevant pi compatibility property is explicitly boolean.
- Contract: `anthropic-messages` reads its explicit `supportsStrictTools`; all other protocols read their explicit `supportsStrictMode`. Do not infer support from `supportsTools`, model name, provider identity, pi adapter defaults, endpoint auto-detection, or model-ID logic. Thus an omitted value is deliberately not a statement about pi's effective runtime behavior.

- [ ] **Step 1: Write the failing bundled-catalog projection tests**

Add `getBuiltinModels` to the existing pi-ai import in `test/providers/pi-catalog.test.ts`, then add these tests:

```ts
it("projects Anthropic Messages strict-tool metadata from supportsStrictTools", async () => {
  const upstream = getBuiltinModels("anthropic");
  const source = upstream.find((model) => model.api === "anthropic-messages" && model.compat?.supportsStrictTools !== undefined);
  expect(source).toBeDefined();

  const [anthropic] = await piProviders(["anthropic"]);
  const projected = anthropic?.models.find((model) => model.id === source?.id);
  expect(projected?.supportsStrictToolSampling).toBe(source?.compat?.supportsStrictTools);
});

it("projects non-Anthropic strict-tool metadata from supportsStrictMode", async () => {
  const upstream = getBuiltinModels("openai");
  const source = upstream.find((model) => model.api !== "anthropic-messages" && model.compat?.supportsStrictMode !== undefined);
  expect(source).toBeDefined();

  const [openai] = await piProviders(["openai"]);
  const projected = openai?.models.find((model) => model.id === source?.id);
  expect(projected?.supportsStrictToolSampling).toBe(source?.compat?.supportsStrictMode);
});

it("does not invent a strict-tool declaration when pi exposes none", async () => {
  const upstream = getBuiltinModels("deepseek");
  const source = upstream.find((model) => model.compat?.supportsStrictMode === undefined);
  expect(source).toBeDefined();

  const [deepseek] = await piProviders(["deepseek"]);
  const projected = deepseek?.models.find((model) => model.id === source?.id);
  expect(projected).not.toHaveProperty("supportsStrictToolSampling");
});
```

- [ ] **Step 2: Run the focused test file to verify it fails**

Run: `bun x vitest --run test/providers/pi-catalog.test.ts`

Expected: TypeScript/Vitest failure because `defaultProviders()` does not project `supportsStrictToolSampling`.

- [ ] **Step 3: Add a protocol-aware projection helper**

Add this private helper immediately before `defaultProviders()` in `src/providers/pi-catalog.ts`:

```ts
function explicitStrictToolSamplingDeclaration(model: {
  readonly api: string;
  readonly compat?: { readonly supportsStrictMode?: boolean; readonly supportsStrictTools?: boolean };
}): boolean | undefined {
  return model.api === "anthropic-messages" ? model.compat?.supportsStrictTools : model.compat?.supportsStrictMode;
}
```

Replace the existing `piModels.map((model) => ({ ... }))` construction with this equivalent construction, preserving every current field:

```ts
    const models: RawModel[] = piModels.map((model) => {
      const supportsStrictToolSampling = explicitStrictToolSamplingDeclaration(model);
      return {
        id: model.id,
        protocol: model.api,
        pricing: {
          input: model.cost.input,
          output: model.cost.output,
          cacheRead: model.cost.cacheRead,
          cacheWrite: model.cost.cacheWrite,
          ...(model.cost.tiers !== undefined
            ? {
                tiers: model.cost.tiers.map(
                  (tier): PricingTier => ({
                    inputTokensAbove: tier.inputTokensAbove,
                    input: tier.input,
                    output: tier.output,
                    cacheRead: tier.cacheRead,
                    cacheWrite: tier.cacheWrite,
                  }),
                ),
              }
            : {}),
        },
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        supportsTools: true,
        ...(supportsStrictToolSampling !== undefined ? { supportsStrictToolSampling } : {}),
        thinkingLevels: getSupportedThinkingLevels(model) as readonly ThinkingLevel[],
      };
    });
```

Keep the existing model fields and their ordering unchanged. The helper must never turn an absent pi property into `false`.

- [ ] **Step 4: Run the focused test file to verify it passes**

Run: `bun x vitest --run test/providers/pi-catalog.test.ts`

Expected: PASS; the tests compare nax-ai's projection to the exact explicit pi field and prove no property is invented when pi exposes no explicit field.

- [ ] **Step 5: Run the provider test group**

Run: `bun x vitest --run test/providers/catalog.test.ts test/providers/pi-catalog.test.ts`

Expected: PASS; hand-built catalog behavior and bundled-catalog projection both remain green.

- [ ] **Step 6: Commit the pi-catalog projection**

```bash
git add src/providers/pi-catalog.ts test/providers/pi-catalog.test.ts
git commit -m "feat: project strict tool sampling metadata from pi"
```

### Task 3: Document the explicit-declaration boundary and run release-quality checks

**Files:**

- Modify: `README.md:32-38`

**Interfaces:**

- Consumes: the public `ResolvedModel.supportsStrictToolSampling?: boolean` catalog field from Tasks 1–2.
- Produces: accurate consumer guidance: `true` is an explicit catalog declaration, absent is unknown rather than a claim about pi's runtime defaults, and this capability does not require a tool call or provide structured completion output.

- [ ] **Step 1: Extend the constrained-sampling documentation**

After the existing constrained-sampling paragraph in `README.md`, add exactly this paragraph:

```md
`ResolvedModel.supportsStrictToolSampling === true` identifies a model whose catalog explicitly declares strict JSON Schema tool-argument sampling support; an absent value means nax-ai has no declaration and is not a statement about pi-ai's runtime defaults. This capability constrains arguments only when a tool is called: it does not require a tool call and does not provide structured completion output.
```

- [ ] **Step 2: Run static and behavioral verification**

Run: `bun run typecheck && bun run test && bun run lint`

Expected: all commands exit 0. `lint` must include the pi-ai import gate, confirming the new pi-ai access remains confined to `src/providers/pi-catalog.ts`.

- [ ] **Step 3: Commit documentation and final verification**

```bash
git add README.md test/providers/pi-catalog.test.ts
git commit -m "docs: clarify strict tool sampling capability"
```

## Self-Review

- **Spec coverage:** Task 1 creates and preserves the raw/resolved optional capability; Task 2 makes the pi-backed default catalog supply protocol-correct explicit values; Task 3 documents the capability boundary and verifies all repository gates. No structured-output request API, forced tool invocation, or pi-ai modification is proposed.
- **Placeholder scan:** No TBD/TODO, implicit validation, or unnamed interfaces remain. All code steps name exact fields, helper behavior, and commands.
- **Type consistency:** `supportsStrictToolSampling?: boolean` is the sole public field name in every task. `explicitStrictToolSamplingDeclaration()` returns `boolean | undefined`, feeding a conditional spread into `RawModel`; `normaliseCatalog()` conditionally copies it to `ResolvedModel`.
- **Review focus:** Task 1 tests true/false/absent normalization plus true and false override preservation. Task 2 tests the distinct Anthropic and non-Anthropic pi compatibility sources and proves pi omissions remain omitted. Task 3 documents that this is not a declaration of pi's inferred runtime support and that no forced tool invocation or structured completion is promised.
