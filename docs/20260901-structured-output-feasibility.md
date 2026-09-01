# Structured JSON output for nax ops via nax-ai

Date: 2026-09-01
Status: analysis (read-only probe; no code written)
Scope: `@nathapp/nax-ai` 0.1.1 on `@earendil-works/pi-ai` 0.84.4, and the nax ops that require JSON output.

## Question

Several nax ops require the model to answer in a fixed JSON shape. Today that
contract is expressed only as prose plus an example inside the prompt, and
correctness is recovered afterwards by parsing, coercion and retry. Can nax-ai
ask the provider to constrain generation to the shape instead, so the JSON is
valid on arrival?

Short answer: yes, partially. The mechanism exists and is per-tool, which is
the good case. It fits two ops cleanly, does not fit the review ops, and cannot
serve the debate ops at all. The blocking work is smaller than expected because
a JSON-mode seam already exists in the op layer -- but it is dead code.

## 1. What pi-ai actually offers

There is no top-level `response_format` / `json_schema` request field. Constrained
sampling is declared **per tool definition**:

```ts
// pi-ai dist/types.d.ts
export interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
  constrainedSampling?: false | ConstrainedSamplingConfig;
}

export type ConstrainedSamplingConfig =
  | { type: "json_schema"; strict: "prefer" | "require" }
  | { type: "grammar"; variants: { openai_lark?: string; openai_regex?: string } };
```

Specificity splits across three layers:

| Layer | What is specific to it |
| --- | --- |
| Tool | Whether constrained sampling is requested, and `prefer` vs `require` |
| Model | Whether it is honoured: `supportsStrictMode` / `supportsStrictTools` / `supportsOpenAIGrammarTools`, set per model by pi-ai's generated catalog. Not settable by the caller. |
| Provider / API | Wire encoding only, already normalised by pi-ai |

Being tool-scoped is the useful property: one strict-JSON tool can sit alongside
ordinary tools in the same request.

`strict: "prefer"` degrades silently to a plain tool on an unsupporting model or
an unsupported schema. `strict: "require"` throws
(`resolveJsonSchemaStrictSampling`, `dist/api/constrained-sampling.js`).

Backends implementing it: `anthropic-messages`, `openai-completions`,
`openai-responses`, `azure-openai-responses`, `openai-codex-responses`,
`bedrock-converse-stream`, `google-shared`, `mistral-conversations`. That covers
all four protocols nax-ai registers.

### 1.1 The strict schema subset

`makeStrictJsonSchema` (`dist/api/constrained-sampling.js`) rejects the schema
outright when any of these appear:

```
$ref, $defs, definitions, allOf, oneOf, patternProperties, dependentSchemas,
dependencies, unevaluatedProperties, propertyNames, contains, prefixItems,
not, if, then, else
```

It also refuses tuple `items`, object/array unions inside `anyOf`, any
`additionalProperties` other than `false`, and a non-object root schema.

Two rewrites it performs are behaviour-visible:

- every property becomes **required**;
- every property not originally required is rewritten to `anyOf: [T, { type: "null" }]`.

So under strict mode a field can no longer be *omitted*. It must be present and
explicitly `null`.

## 2. `toolChoice` is "auto" or "none" only

`ProtocolRequest.toolChoice` in nax-ai is `"auto" | "none"`, mirroring pi-ai's
public `ToolChoice` (`dist/types.d.ts:23`). The values carry standard provider
semantics and are passed through verbatim to the provider's `tool_choice` field:

- `"auto"` -- the model decides; it may call tools or answer in text and call
  nothing. Also the behaviour when the field is omitted entirely.
- `"none"` -- the model may not call any tool. Tools are still sent, so the
  schema is visible in the prompt but unusable.

Neither means "must". Constrained sampling makes the JSON valid *when emitted*;
nothing here makes the model emit it.

**Trap worth recording:** the narrowing is type-level only. At runtime the value
flows through untouched, and the raw api-layer types already declare the wider
unions (`dist/api/anthropic-messages.d.ts:58` is `"auto" | "any" | "none" | {...}`):

```js
// dist/api/anthropic-messages.js:819-824
if (options?.toolChoice) {
  if (typeof options.toolChoice === "string") params.tool_choice = { type: options.toolChoice };
  else params.tool_choice = options.toolChoice;   // object passes through untouched
}
// dist/api/openai-completions.js:626-627 -- params.tool_choice = options.toolChoice, verbatim
// dist/api/openai-responses.js:239-240   -- same
// dist/api/openai-codex-responses.js:400 -- tool_choice: options?.toolChoice ?? "auto"
```

So forcing a tool is reachable today with a cast rather than an upstream pi-ai
release. It is nonetheless a deliberate escape hatch past a public type and can
break quietly on a pi-ai upgrade. Google would additionally need care:
`mapToolChoice` (`dist/api/google-shared.js:308`) falls back to `AUTO` on any
unrecognised string, so a wrong value degrades silently rather than erroring.
Google is not in nax-ai's protocol set today.

## 3. nax-ai currently drops the capability

`ToolDefinition` (`src/protocols/types.ts`) carries `name`, `description`,
`inputSchema` and nothing else, and the conversion forwards only those:

```ts
// nax-ai src/protocols/pi-client.ts:81-88
function toPiTool(tool): PiTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as PiTool["parameters"],
  };
}
```

There is no way for a caller to request constrained sampling. This is the only
change strictly required on the nax-ai side.

## 4. The nax op schemas

Two different mechanisms are in use.

### 4.1 `SchemaDescriptor` -- example-based, low fidelity

`src/prompts/core/sections/json-schema.ts:10`:

```ts
export interface SchemaDescriptor {
  name: string;          // "RoutingDecision"
  description: string;   // "Respond with JSON only -- no explanation text"
  example: unknown;      // JS object literal, JSON.stringify'd into the prompt
}
```

Used by decompose (`src/prompts/builders/decompose-builder.ts:18,41`) and
routing (`src/routing/strategies/llm.ts:47,53`). The examples double as
documentation in ways a real schema would not survive -- enum descriptions
appear in value position:

```ts
example: { complexity: "simple|medium|complex|expert", modelTier: "fast|balanced|powerful", reasoning: "<one line>" }
```

**Incidental defect found while surveying:** `DECOMPOSE_SPEC_SCHEMA` and
`DECOMPOSE_PLAN_SCHEMA` each carry `// Optional: set to a profile id from the
Agent Profiles table above, or omit if no profiles are listed` as a JavaScript
comment inside the example object literal. `JSON.stringify` drops it. The model
only ever sees `"agentProfileId": ""`. The optionality hint has never reached
the prompt. Unrelated to structured output; worth fixing on its own.

### 4.2 Inline template-string schemas -- high fidelity

The ops that matter most write the schema directly into the prompt. These are
precise and would translate to JSON Schema cleanly.

`SEMANTIC_OUTPUT_SCHEMA`, `src/prompts/builders/review-builder.ts:67`:

```
{ "passed": boolean,
  "inspectedFiles": ["relative/path/you/actually/opened.ts"],
  "acks": [{ "priorFinding": ..., "status": "addressed" | "never-an-issue", "note": ... }],
  "findings": [{ "severity": "error" | "warning" | "info" | "unverifiable",
                 "category": <enum>, "file", "line", "issue", "suggestion",
                 "acQuote": "<optional>", "acIndex": 3,
                 "verifiedBy": { "command", "file", "line", "observed" } }] }
```

Adversarial review (`src/prompts/builders/adversarial-review-builder.ts`) adds
`scopeQuote`, `scopeIndex` and `actionRequired` to the same finding shape.

Acceptance refinement (`src/prompts/builders/acceptance-builder.ts:333-345`)
returns a top-level array of `{ original, refined, testable, storyId }`.

Debate (`src/prompts/builders/debate-builder.ts:29-33`):

```ts
const FINDING_SCHEMA = `{ ruleId: string; severity: "critical" | "error" | "warning" | "info" | "low"; file: string; line: number; message: string }`;
const REVIEW_JSON_DIRECTIVE = `Respond with JSON: { passed: boolean; findings: Array<${FINDING_SCHEMA}>; findingReasoning: { [ruleId: string]: string } }`;
```

### 4.3 Fit against the strict subset

| Op | Root | Blocker |
| --- | --- | --- |
| `classify-route` | object | none -- flat, all-enum. Good fit. |
| `acceptance-refine` | **array** | needs an object wrapper plus an unwrap in `parse`. Otherwise flat, no conditionals. Good fit. |
| `decompose` | **array** | wrapper needed; schema must be authored (example only today). |
| semantic review | object | conditional requirements (below). Shape-only benefit. |
| adversarial review | object | same, plus more conditional fields. |
| debate | object | `findingReasoning` is inexpressible. Blocked. |

Three structural collisions:

**Conditional requirements cannot be expressed.** The review prompts state
rules like "`acIndex` is required when severity is `error`. Omit both for
`warning`, `info`, `unverifiable`", and equivalently for
`scopeQuote`/`scopeIndex` under `category: "out-of-scope"`, and for the
`actionRequired: false` versus `suggestion` pairing. Each is an if/then across
fields, needing `if`/`then`/`else`, `allOf` or `oneOf` -- all rejected by
`makeStrictJsonSchema`. These rules stay prompt-enforced regardless of what we
adopt. Since they are the substance of the review contracts, constrained
sampling buys those ops shape validity only.

**"Omit" becomes impossible.** Strict marks every property required and
rewrites optionals to `anyOf: [T, null]`. `acQuote`, `acIndex`, `acks`,
`scopeQuote`, `scopeIndex`, `actionRequired` would arrive as explicit `null`
rather than absent, inverting the instruction the prompt gives. Every
`=== undefined` check on these shapes would need auditing first.

**Open dictionaries are inexpressible.** `findingReasoning: { [ruleId: string]:
string }` has runtime-invented keys. Strict requires `additionalProperties:
false` with all properties enumerated. The debate ops cannot use
`json_schema` constrained sampling on their current contract.

### 4.4 Cost of the status quo

`src/prd/schema.ts` is 629 lines, a large share of it coercing malformed output
back into shape: `ST001` -> `ST-001`, stripping markdown backticks off IDs,
case-normalising `complexity`, auto-downgrading `testStrategy` when
`noTestJustification` reads like a real justification (BUG-26). That is the
running cost of prose-schema-plus-retry, and it is what constrained sampling
removes for the ops it fits.

## 5. `jsonMode` is a dead seam

A JSON-mode flag already threads from op definition to completion options, and
nothing consumes it:

```ts
// src/operations/types.ts:289   readonly jsonMode?: boolean;
// src/operations/call.ts:94     jsonMode: completeOp.jsonMode ?? false,
// src/agents/types.ts:236       /** Request JSON-formatted output (adds --output-format json) */
//                               jsonMode?: boolean;
```

Grepping all of `src/` for `jsonMode` returns exactly those three sites plus the
op declarations. No adapter reads it. The doc comment promises
`--output-format json`; nothing implements it.

Only two ops set it `true` -- `acceptance-refine` and `classify-route` -- and
those are precisely the two ops that fit the strict subset. The review ops do
not set it at all.

Consequence to note independently of this work: those two ops have been running
without the JSON enforcement their definitions claim. Whether that is a latent
bug or a leftover from the acpx path should be established before building on
the flag.

## 6. Available asset

nax already depends on **zod 4.3.6**, which ships `z.toJSONSchema()` (verified at
runtime). No op output is zod-modelled today -- `z.object` appears in
`src/config/**` only, and nowhere in `src/prd/`, `src/operations/`,
`src/review/` or `src/routing/`. Modelling the two candidate ops in zod and
deriving JSON Schema avoids hand-maintaining two artifacts that drift.

## 7. Recommendation

Adopt constrained sampling for the two ops that already declare `jsonMode`, and
leave the review and debate ops on prose-plus-retry.

Keep `toolChoice` at `"auto"`. The ops already have retry strategies, so a model
that answers in prose instead of calling the tool is already handled. Widening
`toolChoice` is reachable but is an escape hatch past a public pi-ai type; hold
it until there is evidence the retry rate justifies the fragility.

Sequencing: land the nax-ai passthrough first (it is additive and independently
releasable), then wire one nax op end to end as a proving ground, measuring the
retry rate before and after.

## 8. Planned nax-ai changes

Additive and backward compatible. No existing caller changes behaviour.

1. **`src/protocols/types.ts`** -- add `ConstrainedSampling` to the protocol
   vocabulary and an optional field on `ToolDefinition`. Named for the concept,
   not for a provider, consistent with the file's stated rule. The `grammar`
   variant is OpenAI-specific encoding; carry only the `json_schema` variant
   until there is a caller for grammars.

2. **`src/protocols/pi-client.ts`** -- spread the field in `toPiTool` when
   present, matching the existing conditional-spread idiom used in
   `toPiContext` / `toPiOptions`.

3. **Tests** -- `toPiTool` forwards the field when set and omits the key
   entirely when unset (absent, not `undefined`, so pi-ai's `if (!config)`
   branch is reached); a tool without the field is byte-identical to today's
   output.

4. **Docs** -- README note that support is per-model and that `"prefer"`
   degrades silently, so callers must not treat a valid-looking response as
   proof the constraint was applied.

Deliberately out of scope: widening `toolChoice`; the `grammar` variant;
surfacing `supportsStrictMode` through nax-ai's catalog (`ProviderModel`
currently exposes `supportsTools` only). Each is separable and none blocks the
above.

## 9. Open questions

- Which models does nax route `classify-route` and `acceptance-refine` to?
  `supportsStrictMode` / `supportsStrictTools` is per-model catalog metadata, so
  a fast-tier model may not honour `"prefer"` at all and the change would be
  inert there.
- What is the current retry and repair rate on those two ops? If it is already
  near zero, the change buys little and the sequencing above should stop after
  step 1.
- Is `jsonMode` a latent bug or an intentional leftover?

## Verified sources

pi-ai 0.84.4: `dist/types.d.ts` (23, 219-221, 363-384, 504, 525, 582, 600);
`dist/api/constrained-sampling.js`; `dist/api/anthropic-messages.js:819-824`;
`dist/api/openai-completions.js:626-627`; `dist/api/openai-responses.js:239-240`;
`dist/api/openai-codex-responses.js:400`; `dist/api/google-shared.js:308-329`;
`dist/api/anthropic-messages.d.ts:58`.

nax-ai 0.1.1: `src/protocols/types.ts`; `src/protocols/pi-client.ts:81-88,175,181`;
`src/providers/types.ts:63`.

nax: `src/operations/types.ts:289`; `src/operations/call.ts:94`;
`src/agents/types.ts:236`; `src/prompts/core/sections/json-schema.ts:10`;
`src/prompts/builders/review-builder.ts:67,220`;
`src/prompts/builders/adversarial-review-builder.ts:210,236`;
`src/prompts/builders/debate-builder.ts:29-33`;
`src/prompts/builders/acceptance-builder.ts:333-345`;
`src/prompts/builders/decompose-builder.ts:18,41`;
`src/routing/strategies/llm.ts:47,53`; `src/prd/schema.ts`.
