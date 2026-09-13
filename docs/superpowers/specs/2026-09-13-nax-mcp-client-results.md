# MCP client — measurement results

Companion to `2026-09-13-nax-mcp-client-design.md`, which calls in §6 for
measurement before the feature is declared worthwhile.

Feature: **MCP client support for the native agent** — `mcp` config block, connection
pool, provider, lockfile (`nax mcp lock`), audit telemetry. Implemented and committed.

Date: **2026-09-13**

Status: **Collected, with one causal result and one null result.**

The A/B ran on the `nax-context-dogfood` fixture `native-full-run`, two arms differing in
exactly one config key. The schema-bytes tax is **measured and causal**. The token/cost
comparison is **confounded by run-to-run variance and proves nothing** — stated plainly
below rather than dressed up as a delta.

## Method

| | |
|---|---|
| Fixture | `nax-context-dogfood/fixtures/native-full-run` (2 src files, 23 lines) |
| Stories | US-001 (6 ACs), US-002 (4 ACs) |
| PRD | planned **once**, frozen, byte-identical in both arms (`sha256 6d2a9106…`) |
| Model | `openrouter/deepseek/deepseek-v4-flash` on every hop (`agent.default: native`, `fallback.enabled: false`) |
| Server | `codebase-memory`, `stages: ["run"]`, `allowedTools: [search_graph, trace_path, get_code_snippet]` |
| Graph | fixture indexed: 84 nodes, 88 edges |
| Only difference | `mcp.servers.codebase-memory.enabled` `true` vs `false` |
| n | **1 run per arm** |

Both arms completed 2/2 stories in 3 iterations, exit 0.

## Results

| Metric | With MCP (`enabled: true`) | Without MCP (`enabled: false`) |
|---|---|---|
| Turn count (sessions) | 18 | 10 |
| Wall-clock | 975 s (16.2 min) | 587 s (9.7 min) |
| Total tokens (in / out) | 344,113 / 64,112 | 230,050 / 34,360 |
| Cache read | 961,222 | 646,538 |
| Total cost (ledger) | $0.05666 | $0.03650 |
| `Grep` / `Glob` call counts | 4 / 58 | 5 / 29 |
| **MCP call count** | **0** | 0 (n/a) |
| `resultBytesPreTruncation` totals | never populated (no MCP call occurred) | n/a |
| **Advertised schema bytes per hop** | **7,604** × 3 hops = **22,812 B** | 0 |

### The `run` stage in isolation

The whole-run rows above are confounded (see below). The `run` stage — the **only** stage
the server attaches to — had an identical session shape in both arms (implementer ×2,
test-writer ×1 = exactly the 3 advertised hops), so it is the one comparable slice:

| `run` stage only | A (MCP on) | B (MCP off) |
|---|---|---|
| Sessions | 3 | 3 |
| Tokens in / out | 57,393 / 9,995 | 76,377 / 11,213 |
| Cost | $0.01074 | $0.01338 |
| Tool calls | 57 | 48 |
| `Grep` + `Glob` | 8 | 5 |
| Tool result bytes | 27,048 | 58,177 |

## Findings

**1. The schema tax is real, unconditional, and was paid for nothing.** The server
connected, advertised its 3 granted tools on each of 3 `run`-stage hops at **7,604 bytes
per hop** (≈1,900 tokens; **22,812 bytes / ≈5,700 tokens total**), and the agent called it
**zero times** — while the same run issued 62 `Grep`/`Glob` and 85 `Read` calls. Cost side
confirmed, benefit side zero.

**2. The token/cost comparison is confounded and supports no conclusion.** Arm A
stochastically hit an acceptance failure and repaired it — sessions arm B never ran at all:
`diagnose` ×1, `source-fix` ×1, `test-fix` ×1, `rectification/implementer` ×2, plus double
the `reviewer-semantic` and `verifier` calls. That extra work, not MCP, accounts for
essentially the entire 114,063-token gap; the schema tax could explain at most ~5,700 of
it (5%). Arm A in fact used **fewer** run-stage input tokens than arm B (57,393 vs 76,377)
despite paying the tax — which, with zero MCP calls, can only be noise. **n=1 per arm
cannot isolate a ~5,700-token effect against ~114,000 tokens of variance.**

**3. `stages: ["run"]` is narrower than it looks.** Only 3 of 18 sessions ever saw the
tools. The reviewer, verifier, and acceptance sessions — which did much of the `Glob`/`Read`
work — never had them available. Any future attempt to show benefit must widen `stages`
or it is measuring a stage that barely explores.

## Verdict

Design §6's premise — that graph tools beat `Grep` sweeps — remains **unmeasured**, and
this fixture **cannot** measure it. On a 23-line, 84-node repo there is no structure to
query and `Grep` is free, so zero MCP calls is the by-construction outcome, not evidence
against graph tools. What this run does establish is the **cost side, with certainty**:
~1,900 tokens per attached hop, paid whether or not a tool is ever called.

Interim guidance, unchanged in direction but now with a number: keep `allowedTools`
narrowed (3 tools cost 7,604 B/hop; all 15 would cost 21,650 B/hop — a ~64% saving), and
do not attach `codebase-memory` to a stage on the assumption it pays for itself. To
actually answer §6, run the A/B on a **large indexed repo** (nax itself, ~1,288 modules)
with a story posing a genuine structural question, and with **n>1 per arm** so the
rectification-lottery variance seen here does not swamp the effect.

## Incidental defects found while running this

- **`nax plan` masks a model failure behind an internal invariant.** With
  `plan.mode: "refine"`, the model failed PRD JSON shape validation 3×; `callOp` then
  returns a raw `TurnResult` instead of throwing, so `src/plan/strategies/refine.ts:41`
  calls `writeOrRecoverPrd(ctx, null)` with no error and trips its own guard at
  `src/plan/strategies/write-prd.ts:41` (`PLAN_WRITE_PRD_MISSING_ERR`). The real cause is
  invisible. `plan.mode: "single"` succeeded on the same spec and model.
- **`nax plan --auto` / `--one-shot` silently does nothing.** `resolvePlanMode`
  (`src/cli/plan-command.ts:42`) reads `config.plan.mode` only; the CLI flag never reaches
  mode selection.
- **Run summary and cost ledger disagree.** Summary $0.0391 vs ledger $0.05666 (arm A);
  $0.0330 vs $0.03650 (arm B). The gap does not correspond to excluding any single stage.
  Not diagnosed here.

## Reproducing

Artifacts land in `~/.nax/<project>/` (`cost/`, `tool-audit/`, `mcp/`, `prompt-audit/`),
**not** in the repo `.nax/` — the repo path is only the no-`outputDir` fallback
(`src/config/paths.ts:134-155`). A second arm appends to the same tree, so separate arms
by run id or by timestamp window before analysing.
