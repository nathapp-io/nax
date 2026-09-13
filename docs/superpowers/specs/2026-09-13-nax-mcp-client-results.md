# MCP client — measurement results

Companion to `2026-09-13-nax-mcp-client-design.md`, which calls in §6 for
measurement before the feature is declared worthwhile.

Feature: **MCP client support for the native agent** — `mcp` config block, connection
pool, provider, lockfile (`nax mcp lock`), audit telemetry. Implemented and committed.

Date: **2026-09-13**

Status: **Measurement not collected.**

The A/B measurement was **not run**. The plan's standing rule requires the repo owner's
explicit approval at launch time for any real `nax run`; at the launch moment the owner
declined. The instrumentation to collect every metric below ships and is wired, but no
number in this document is real — every cell in the results table reads "not collected".

## What was to be measured

Design §6 is explicit: the premise that graph tools beat `Grep` sweeps is plausible and
unmeasured — nax#1990's "48 % needs measuring, not assuming" applies. The planned A/B
runs one story twice, once with `mcp.servers.codebase-memory.enabled: true` and once with
it `false`, and compares:

| Metric | Source |
|---|---|
| Turn count per story | run summary |
| Wall-clock per story | run summary |
| Total tokens, total cost | cost ledger |
| `Grep` / `Glob` call counts | tool-audit ledger |
| MCP call count | tool-audit ledger |
| `resultBytesPreTruncation` totals | tool-audit ledger — bytes before the `maxBytes` slice, so elision is visible |
| Advertised schema bytes per hop | `[provider] advertised` debug lines — the fixed per-hop tax paid whether or not a tool is called |

## Results

| Metric | With MCP (`enabled: true`) | Without MCP (`enabled: false`) |
|---|---|---|
| Turn count per story | not collected | not collected |
| Wall-clock per story | not collected | not collected |
| Total tokens | not collected | not collected |
| Total cost | not collected | not collected |
| `Grep` / `Glob` call counts | not collected | not collected |
| MCP call count | not collected | not collected |
| `resultBytesPreTruncation` totals | not collected | not collected |
| Advertised schema bytes per hop | not collected | not collected |

## Verdict

The premise that graph tools beat `Grep` sweeps remains **plausible and unmeasured**. The
instrumentation to answer it — pre-truncation byte counts, the per-hop schema-bytes tax,
and the per-run server rollup — ships and is wired, so the measurement can be run at any
time with the owner's approval.

The honest interim guidance: the `codebase-memory` server is configured in
`.nax/config.json` (attached to `run`, `allowedTools` narrowed to
`["search_graph", "trace_path", "get_code_snippet"]`) and `.nax/mcp-lock.json` pins its 15
advertised tools — all committed. But its value is **unproven**: either run the A/B before
relying on it, or narrow `allowedTools` / leave it unattached until measured.

## How to run the measurement when approved

Two runs of the same story, identical except for one config key:

1. Run with `mcp.servers.codebase-memory.enabled: true`.
2. Run with `mcp.servers.codebase-memory.enabled: false`.

Collect from the run artifacts:

- **Turn count and wall-clock per story** — the run summary.
- **Total tokens and cost** — the cost ledger.
- **`Grep` / `Glob` call counts** — the tool-audit ledger.
- **MCP call count and `resultBytesPreTruncation` totals** — the tool-audit ledger.
- **Advertised schema bytes per hop** — the `[provider] advertised` debug log lines (the
  fixed per-hop tax, paid whether or not a tool is called).

Compare the two runs and replace the table above with real numbers.