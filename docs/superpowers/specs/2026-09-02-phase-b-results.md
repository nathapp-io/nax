# Phase B results — native sessions and the pull-tool loop, measured

Date: 2026-09-02
Spec: `docs/superpowers/specs/2026-09-02-native-sessions-phase-b-design.md`
Decision record: `docs/adr/ADR-028-native-sessions-and-tool-loop.md`
Fixture: `tdd-calc` (1 story, 7 acceptance criteria), acceptance stage disabled.
Every arm ran `agent.default: opencode` — no Claude anywhere, deliberately, on cost grounds.

## Headline

**Phase B works.** The native transport carried real multi-turn review sessions with
structured tool calls, reached the same verdict as the acpx baseline, and did it for
**about a tenth of the cost of the review ops themselves**.

**One op was mis-selected by the spec.** `tdd-verifier` is not a Phase B op. It needs
agent-side filesystem tools, which is Phase C.

## Arms

| arm | ops on native | model | result | time | cost |
|---|---|---|---|---|---|
| 1 | verifier + both reviews | `openrouter/deepseek/deepseek-v4-flash` | passed, 1 review **failed open** | 5m43s | $0.0839 |
| 2 | verifier + both reviews | `minimax/MiniMax-M2.7` | **failed 0/1** | 5m03s | $0.0911 |
| 3 | **reviews only** | `openrouter/deepseek/deepseek-v4-flash-0731` | **passed, 0 warnings** | **4m01s** | **$0.0628** |
| baseline | none (pure acpx) | `minimax/MiniMax-M2.7` | passed, 0 warnings | 6m19s | $0.1156 |

## What the mechanism proved

- **Transport**: every native arm created `NativeAgentAdapter`, opened sessions and ran
  multi-turn turns. No transport-level failure in any arm.
- **Tool loop**: `pull-tool | invoked` fired **8 times** in arm 1 and **6 times** in arm 3.
  `query_feature_context` reached the model as a structured tool definition and was
  called through the tool channel — the regex text protocol is genuinely replaced on
  this path. The model reasoned about its own budget: *"the only tool I have is
  `query_feature_context`, which I've exhausted."*
- **Arm 3 ran clean**: zero errors, zero warnings, zero fail-open or fail-stale.

## The spec defect: `tdd-verifier` is a Phase C op

Arms 1 and 2 both failed the verifier, in the same way, on two different models from two
different providers:

| model | provider | invented syntax |
|---|---|---|
| deepseek-v4-flash | openrouter | `<｜DSML｜tool_calls><｜DSML｜invoke name="exec_command">` |
| MiniMax-M2.7 | minimax | `[TOOL_CALL] {tool => "bash", ...}` |

Different vendors, different hallucinated formats, identical intent: **both reached for a
`bash` tool to inspect the project.** Two models failing identically is not a model
problem.

The cause is the op's prompt. It instructs the agent to *"Write the verdict file at the
project root: `.nax-verifier-verdict.json`"* and to perform *"Read-only TDD integrity
inspection"* — Write plus filesystem access. ACP agents have those built in; the native
path deliberately does not. The op's own failure message names both paths it accepts:
*"unparseable stdout **and no verdict file on disk**"*. Native can satisfy only the first.

The spec chose the verifier because it declares no **pull tools**, calling it "toolless
and multi-turn, so it exercises the transcript store in isolation". That conflated two
different things: nax's pull-tool catalogue, and what an op's prompt asks the agent to
do. ADR-029 already draws this line — Read/Write/Bash are Phase C — and the verifier
sits on the far side of it.

In arm 2 the verifier failed first and short-circuited the story, so the review ops
never ran at all (*"Configured review phase(s) never ran"*). Arm 2 therefore says
nothing about the review ops; it only re-proves the verifier finding.

## Native vs acpx, on the ops that are genuinely Phase B

Arm 3 against the baseline, same fixture, same story, reviews only.

**Per-op cost, which is the comparison that means something:**

| | native (0731) | acpx (opencode/M2.7) |
|---|---|---|
| semantic review | $0.000451 | $0.010369 |
| adversarial review | $0.001905 | $0.014868 |
| **review subtotal** | **$0.002356** | **$0.025237** |
| cost confidence | `estimated` / fallback-rates | `exact` / wire |
| input / output tokens | 2792+5424 / 938+1746 | 7+0 / 46+43 |

**Native is ~10.7x cheaper on the ops under test.**

Whole-run totals are a much weaker comparison and are recorded only for context:
$0.0628 (native arm) against $0.1156 (baseline), 4m01s against 6m19s. Both figures
include the test-writer, implementer and verifier work, which ran on opencode in **both**
arms — so most of each total is shared cost that has nothing to do with the transport
under test. Quoting the run totals understates the difference by roughly 6x.

Two caveats on the cost numbers themselves:

- **The native figure is an estimate, not a billed amount.** `pricingSource:
  fallback-rates` means `modelDef.pricing` was unset, so nax computed the cost from
  catalog rates. The acpx figure is `exact` / `wire` — what the agent reported it
  actually cost. A 10.7x gap is far too large to be estimation error, but the native
  side should not be quoted as billed.
- **Token counts are not comparable across transports.** opencode reports `input: 0`
  with `cacheRead: 25848` on some rows (cache-heavy wire accounting); native reports
  plain input tokens. Native's input reporting *does* work here, which is worth noting
  because an earlier probe on a different model saw `0` input on the native path.

**Same verdict, and the work behind it differed:**

The acpx reviewer ran with `permissionProfile: unrestricted` and its full toolset. It
read the files and returned a terse verdict naming what it inspected. The native
reviewer had `query_feature_context` and nothing else, and said so plainly:

> *"I don't have direct file access tools... The only tool I have is
> `query_feature_context`, which returned empty... I cannot actually open `calc.ts` or
> `calc.test.ts` to read their contents or quote verbatim excerpts."*

That is good behaviour — it reported its constraint rather than inventing an answer —
but it means the native reviewer reviewed **the diff in the prompt**, not the codebase.

## What this does and does not license

**Supported by the evidence:** for a small, diff-local change, a native reviewer reaches
the same verdict as a full-toolset acpx reviewer at roughly half the cost. Semantic and
adversarial review take a change as their primary input, so the diff is the right input
for them by design.

**Not supported:** that this holds for changes needing cross-file context. The fixture is
a 7-line function addition — precisely the case where the diff is sufficient. A review
that must trace a caller, check a sibling module, or confirm a type three files away has
no path to that information on the native path today, and the native reviewer's own
words say so.

**Not measured:** whether a native reviewer *misses* findings an acpx reviewer catches.
Both arms found nothing on a trivial change, so the comparison never had a defect to
discriminate on. A fixture with a planted flaw would answer this; `tdd-calc` cannot.

## Open items

1. **ADR-028 §3's op selection needs correcting** — the verifier is not a Phase B op.
2. **`query_feature_context` returned empty** in arm 3. Plausibly correct for a fresh
   fixture feature with no prior context, but unverified — worth confirming before
   reading anything into the review quality.
3. **A planted-defect fixture** would turn "same verdict on a clean change" into a real
   quality measurement.
