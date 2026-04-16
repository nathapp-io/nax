# Context Engine v2 — Flow Diagrams

Companion to [SPEC-context-engine-v2.md](./SPEC-context-engine-v2.md).

---

## 1. Push Path — `ContextOrchestrator.assemble()`

The core hot path. Called once per pipeline stage before the agent session starts.

```
Pipeline stage (e.g. tdd-implementer)
  |
  v
orchestrator.assemble(ContextRequest)
  |
  |  1. RESOLVE STAGE CONFIG
  |     config.context.stages["tdd-implementer"] ?? defaultStage
  |     --> budgetTokens: 4096, providerTimeoutMs: 5000, pull config, kind weights
  |
  |  2. FILTER PROVIDERS
  |     Keep providers that are:
  |       - enabled for this stage+role (per enabledProviders list)
  |       - declare supports: ["push"]
  |
  |  3. COMPUTE SOFT BUDGET
  |     softBudget = stageBudget / eligibleProviderCount
  |     (each provider gets an equal share to aim for)
  |
  |  4. PARALLEL FETCH (the expensive step)
  |     +---------------------------------------------------+
  |     |  Promise.allSettled([                              |
  |     |    withTimeout(featureCtx.fetch(req, soft), 5000), |
  |     |    withTimeout(scratch.fetch(req, soft),    5000), |
  |     |    withTimeout(rules.fetch(req, soft),      5000), |
  |     |    withTimeout(gitHistory.fetch(req, soft),  5000), |
  |     |    withTimeout(neighbor.fetch(req, soft),   5000), |
  |     |  ])                                                |
  |     |  --> timed-out/failed providers silently dropped   |
  |     +---------------------------------------------------+
  |     Result: flat array of ContextChunk[]
  |
  |  5. SCORE ADJUSTMENT
  |     For each chunk:
  |       final_score = provider_score
  |                   x role_weight     (1.2 exact audience match, 0.8 for [all])
  |                   x freshness_weight (1.3 this-session ... 0.6 historical)
  |                   x kind_weight     (per-stage: rectify weights "gotcha" higher)
  |
  |  6. DEDUPE
  |     Chunks with same id OR content similarity >= 0.9:
  |       - merged into one
  |       - keep max score
  |       - union audiences
  |
  |  7. ROLE FILTER
  |     Same v1 audience logic, moved here from prompt builders:
  |       implementer sees: [all] + [implementer]
  |       test-writer sees: [all] + [test-writer]
  |       single-session sees: [all] + [implementer] + [test-writer]
  |       reviewer-semantic sees: [all] + [reviewer] + [reviewer-semantic]
  |       ... (full ROLE_AUDIENCE_MAP + REVIEWER_AUDIENCE_MAP)
  |
  |  8. KNAPSACK PACK
  |     0/1 knapsack: weight=tokens, value=score, capacity=stageBudget
  |       - DP solver with 50ms timeout
  |       - fallback: greedy by value-per-token
  |       - BUDGET FLOOR: static + feature chunks always kept
  |         (prevents RAG from crowding out project rules)
  |       - dropped chunks: recorded in manifest with reason
  |
  |  9. RENDER MARKDOWN
  |     Sections ordered by scope:
  |       ## Project Rules       (StaticRulesProvider)
  |       ## Feature Context     (FeatureContextProvider)
  |       ## Story Context       (story-scoped context.md)
  |       ## Session Notes       (SessionScratchProvider)
  |       ## Related Code        (CodeNeighborProvider, GitHistoryProvider)
  |       ## Retrieved Context   (RagProvider, GraphProvider, KbProvider)
  |
  |  10. BUILD DIGEST
  |      Deterministic (no LLM), <= 250 tokens
  |      Drawn from kept chunks where kind = "decision" or "constraint"
  |      Purpose: downstream stages inherit this as priorStageDigest
  |
  |  11. COLLECT PULL TOOLS
  |      From providers with supports: ["pull"]
  |      Gated on: agent.caps.supportsToolCalls
  |      If agent doesn't support tools: skip, increase push budgets instead
  |
  |  12. BUILD MANIFEST
  |      Every candidate chunk: kept=true/false, drop reason, score, tokens
  |      Written to: .nax/features/<id>/stories/<storyId>/context-manifest-<stage>.json
  |
  v
ContextBundle {
  pushMarkdown: string       <-- goes into the prompt
  pulledTools: ToolDescriptor[]  <-- registered with agent session
  manifest: ContextManifest  <-- audit trail
  digest: string             <-- for next stage's priorStageDigest
  budgetUsed: number
  budgetTotal: number
}
  |
  +--> attached to ctx, passed to prompt builder
  +--> manifest written to disk
```

---

## 2. Pull Path — Tool Calls During Agent Session

Runs DURING the agent call. Push context is already in the prompt. Agent decides
when/whether to invoke context tools. This is additive, not a replacement for push.

```
Agent (Claude/Codex/Gemini)          Adapter (ACP/CLI)         Orchestrator          Provider
         |                                  |                       |                    |
         |  [push context already           |                       |                    |
         |   injected in prompt]            |                       |                    |
         |                                  |                       |                    |
         |-- tool_call: ------------------>|                       |                    |
         |   query_rag(                     |                       |                    |
         |     "resolveFeatureId usages",   |                       |                    |
         |     k=5                          |                       |                    |
         |   )                              |                       |                    |
         |                                  |-- handleToolCall ---->|                    |
         |                                  |   ("query_rag",       |                    |
         |                                  |    input, req)        |                    |
         |                                  |                       |                    |
         |                                  |                  [budget check]            |
         |                                  |                  callCount <               |
         |                                  |                  maxCallsPerSession?       |
         |                                  |                       |                    |
         |                                  |              YES:     |                    |
         |                                  |                       |-- onTool() ------->|
         |                                  |                       |   ("query_rag",    |
         |                                  |                       |    input, req)     |
         |                                  |                       |                    |
         |                                  |                       |<-- ContextChunk[] -|
         |                                  |                       |                    |
         |                                  |                  [truncate to              |
         |                                  |                   maxTokensPerCall]        |
         |                                  |                       |                    |
         |                                  |                  [append to                |
         |                                  |                   scratch.jsonl]           |
         |                                  |                       |                    |
         |                                  |                  [record in                |
         |                                  |                   manifest.pullCalls]      |
         |                                  |                       |                    |
         |                                  |<-- formatted chunks --|                    |
         |<-- tool_result (Markdown) -------|                       |                    |
         |                                  |                       |                    |
         |                              NO (budget exhausted):      |                    |
         |<-- tool_error: --------------|                            |                    |
         |   "context tool budget       |                            |                    |
         |    exhausted"                |                            |                    |


Budget ceilings (three layers):
  - Per-call:    maxTokensPerCall    (default 2048) -- response truncated
  - Per-session: maxCallsPerSession  (default 5)   -- tool errors after
  - Per-run:     maxCallsPerRun      (default 50)  -- hard cap across all sessions
```

---

## 3. Progressive Digest — Cross-Stage Context Propagation

Each stage produces a digest (deterministic, <=250 tokens). The next stage
inherits it via `hints.priorStageDigest`. Also persisted to scratch for crash resume.

```
  plan                test-writer           implementer           verify
  +---------------+   +---------------+   +---------------+   +---------------+
  | Push:         |   | Push:         |   | Push:         |   | Push:         |
  |  rules        |   |  rules        |   |  rules        |   |  rules        |
  |  feature      |   |  feature[tw]  |   |  feature[imp] |   |  scratch      |
  |  story        |   |  story        |   |  story        |   +------+--------+
  |  git-history  |   |  scratch      |   |  scratch      |          |
  +------+--------+   |  neighbor     |   |  neighbor     |          v
         |            |  +plan.digest |   |  +tw.digest   |   digest: "Tests pass.
         v            +------+--------+   +------+--------+    Coverage 87%."
  digest: "Touching          |                   |                   |
   semantic.ts +              v                   v                   |
   builders. Isolate   digest: "New test   digest: "Impl in          |
   types."             semantic-v2.test.   semantic.ts. Moved        |
         |              Uses _deps."       types to types.ts."       |
         |                   |                   |                   |
         +----> priorStageDigest                 |                   |
                     +----> priorStageDigest     |                   |
                                 +----> priorStageDigest             |
                                                     +----> priorStageDigest
                                                                     |
                                                                     v
                                                              review-semantic
                                                              +---------------+
                                                              | Push:         |
                                                              |  rules        |
                                                              |  feature[rev] |
                                                              |  diff         |
                                                              |  scratch      |
                                                              |  +verify.dig  |
                                                              +------+--------+
                                                                     |
                                                                     v
                                                              digest: "One finding:
                                                               missing null check."
                                                                     |
                                                                     +----> rectify
                                                                            ...

All digests also written to scratch.jsonl (survives crash/resume).
```

---

## 4. Session Scratch — Write and Read Flow

Pipeline stages write observations; later stages and resumed sessions read them.
Append-only JSONL. Gitignored. May contain secrets (command output).

```
                         WRITERS (pipeline stages)
                    +-----------+-----------+-----------+
                    |  verify   |  rectify  |  review   |  autofix
                    |           |           |           |
                    | writes:   | writes:   | writes:   | writes:
                    | test out  | attempt   | findings  | check
                    | pass/fail | summary   | severity  | result
                    | coverage  | fix diff  | file refs | fix applied
                    +-----+-----+-----+-----+-----+-----+-----+
                          |           |           |           |
                          v           v           v           v
            +-----------------------------------------------------------+
            |  .nax/features/<id>/sessions/<sessionId>/scratch.jsonl    |
            |  (append-only JSONL, one entry per observation)           |
            +----------------------------+------------------------------+
                                         |
                          +--------------+--------------+
                          |                             |
                    PUSH (automatic)              PULL (on-demand)
                          |                             |
                          v                             v
                SessionScratchProvider          query_scratch(since?)
                reads most recent N entries     tool for long-running
                within soft budget              roles (implementer)
                          |
           +--------------+--------------+
           |              |              |
           v              v              v
      rectify sees    autofix sees   resumed session
      verify's        review's       sees all prior
      failure output  findings       observations


LIFECYCLE:
  Story complete  --> archive scratch
  TTL (7 days)    --> purge scratch
  Feature archive --> move to _archive/ (if manifest.archiveOnFeatureArchive)

SAFETY:
  - Always gitignored (secrets may appear)
  - Regex-based redaction on write (AWS keys, tokens, .env values)
  - Discarded at feature archive by default
```

---

## 5. Availability Fallback — Agent Swap on Failure

Two orthogonal axes. They never interleave:
  - ESCALATION: quality-driven, same agent, different tier (fast -> balanced -> powerful)
  - FALLBACK:   availability-driven, different agent, same tier

```
Agent session fails
       |
       v
  Adapter reports AdapterFailure
  { category, outcome, message, retriable }
       |
       +------- category: "quality" ---------> TIER ESCALATION
       |        (review/verify rejected)       (same agent, higher tier)
       |                                       fast -> balanced -> powerful
       |                                       Handled by src/execution/escalation/
       |                                       (no change in v2)
       |
       +------- category: "availability" ----> AVAILABILITY FALLBACK
                (quota, rate-limit, 5xx,
                 auth, timeout)
                       |
                       v
                fallback.enabled?
                  |          |
                  NO         YES
                  |          |
                  v          v
             Story fails    Lookup fallback.map[currentAgent]
             "agent-        e.g. map.claude = ["codex", "gemini"]
              unavailable"        |
                                  v
                           +---> Try next candidate
                           |            |
                           |     credentials configured?
                           |      |              |
                           |      NO             YES
                           |      |              |
                           |   skip, warn        v
                           |      |       orchestrator.rebuildForAgent(
                           |      |         priorBundle, newAgent, failure
                           +------+       )
                                          |
                                   +------+------+
                                   |             |
                             PORTABLE         NON-PORTABLE
                             (carried)        (dropped)
                                   |             |
                             feature ctx    reasoning traces
                             scratch        agent tool logs
                             digests        prior prompt framing
                             story state
                             diffs
                             RAG chunk IDs
                                   |
                                   v
                            Inject failure-note chunk
                            (deterministic string build, no LLM)
                            "Prior agent: claude became unavailable.
                             Reason: fail-quota at 14:22 UTC.
                             Work completed: plan + test-writer.
                             Resume point: implementer stage."
                                   |
                                   v
                            Re-render under new agent profile
                            (codex renderer: xml-tagged style,
                             openai tool schema dialect, etc.)
                                   |
                                   v
                            Write rebuild-manifest.json
                            (old chunk IDs -> new chunk IDs)
                                   |
                                   v
                            Start new session against CODEX
                            at SAME TIER (powerful)
                                   |
                              +---------+
                              |         |
                           success    also fails
                              |      availability
                              v         |
                           Story        v
                           continues   hops < maxHopsPerStory?
                                        |         |
                                       YES        NO
                                        |         |
                                   try next    Story fails
                                   candidate   "all-agents-unavailable"
                                               manifest records every
                                               vendor + failure reason


QUALITY FALLBACK (opt-in):
  context.fallback.onQualityFailure: true  (default: false, experimental)
  When enabled: failure-note includes full review findings.
  Tier escalation within same agent is still the preferred first response.
```

---

## 6. End-to-End — Single Story Through v2

```
Story begins
  |
  v
context.ts stage
  - resolveFeatureId(story, workdir)
  - initialize session scratch directory
  |
  v
+-- PLAN ----------------------------------------------------------------+
|  assemble(plan)                                                         |
|    push: rules, feature, story, git-history        budget: 3072        |
|    pull: none                                                           |
|  --> agent produces plan                                                |
|  --> digest written to scratch                                          |
+----+--------------------------------------------------------------------+
     |
     v
+-- TEST-WRITER ----------------------------------------------------------+
|  assemble(tdd-test-writer)                                              |
|    push: rules, feature[test-writer], story, scratch,                   |
|          neighbor(existing tests), plan.digest          budget: 3072    |
|    pull: query_neighbor                                                  |
|  --> agent writes tests                                                  |
|  --> digest written to scratch                                           |
+----+---------------------------------------------------------------------+
     |
     v
+-- IMPLEMENTER -----------------------------------------------------------+
|  assemble(tdd-implementer)                                               |
|    push: rules, feature[implementer], story, scratch,                    |
|          neighbor, test-writer.digest                    budget: 4096    |
|    pull: query_rag, query_graph, query_neighbor,                         |
|          query_feature_context                                            |
|  --> agent implements (may call pull tools)                               |
|  --> digest written to scratch                                            |
+----+----------------------------------------------------------------------+
     |
     v
+-- VERIFY ----------------------------------------------------------------+
|  assemble(verify)                                                        |
|    push: rules, scratch                                budget: 512      |
|    pull: none                                                            |
|  --> run tests                                                           |
|  --> writes test output to scratch                                       |
+----+-----+---------+----------------------------------------------------+
     |     |         |
     |    PASS      FAIL
     |     |         |
     |     |         +-----> RECTIFY
     |     |                   assemble(rectify)
     |     |                     push: feature[implementer], failure output,
     |     |                           prior fix pairs, scratch, verify.digest
     |     |                     pull: query_neighbor          budget: 2048
     |     |                   --> fix attempt
     |     |                   --> loop back to VERIFY
     |     |
     v     v
+-- REVIEW-SEMANTIC -------------------------------------------------------+
|  assemble(review-semantic)                                                |
|    push: rules, feature[reviewer-semantic], diff, scratch,               |
|          verify.digest                                   budget: 3072    |
|    pull: query_feature_context, query_kb                                  |
|  --> findings written to scratch                                          |
+----+-----+---------+-----------------------------------------------------+
     |     |         |
     |    PASS     FINDINGS
     |     |         |
     |     |         +-----> RECTIFY (with review findings in scratch)
     |     |                   --> fix --> verify --> review loop
     |     |
     v     v
Story complete
  - archive scratch (TTL: 7 days)
  - preserve manifests (if configured)


NOTE: At ANY agent session, an availability failure triggers the
      fallback flow (see diagram 5). The new agent resumes from
      the same stage with portable state preserved.
```

---

## 7. Scope Hierarchy — Where Context Lives

```
+-----------------------------------------------------------------------+
| PROJECT SCOPE (repo lifetime)                                         |
|                                                                       |
|   .nax/rules/*.md              <-- canonical rules (neutral prose)    |
|   Read by: StaticRulesProvider                                        |
|   Injection: always pushed, budget floor (never dropped by packing)   |
|                                                                       |
|   CLAUDE.md, .claude/rules/    <-- optional shims, NOT read by v2     |
|   Generated by: nax rules export --agent=claude (one-way)             |
+---+-------------------------------------------------------------------+
    |
    v
+-----------------------------------------------------------------------+
| FEATURE SCOPE (feature build --> archive)                             |
|                                                                       |
|   .nax/features/<id>/context.md    <-- human-authored entries         |
|   .nax/features/<id>/context.lock.json                                |
|   Read by: FeatureContextProvider                                     |
|   Injection: pushed, role-filtered by audience tags                   |
+---+-------------------------------------------------------------------+
    |
    v
+-----------------------------------------------------------------------+
| STORY SCOPE (story lifetime)                                          |
|                                                                       |
|   .nax/features/<id>/stories/<storyId>/context.md                     |
|     (auto-extracted, story-specific -- new in v2)                     |
|                                                                       |
|   .nax/features/<id>/stories/<storyId>/context-manifest-<stage>.json  |
|     (audit trail: every chunk considered, kept/dropped + reason)       |
|                                                                       |
|   .nax/features/<id>/stories/<storyId>/rebuild-manifest.json          |
|     (written on availability fallback: old IDs -> new IDs)            |
+---+-------------------------------------------------------------------+
    |
    v
+-----------------------------------------------------------------------+
| SESSION SCOPE (ACP session lifetime / crash --> resume)                |
|                                                                       |
|   .nax/features/<id>/sessions/<sessionId>/scratch.jsonl               |
|     (append-only observations, gitignored, may contain secrets)       |
|   Read by: SessionScratchProvider                                     |
|   Injection: pushed (most recent N within budget), pull via tool      |
|   Lifecycle: archived on story complete, purged after TTL (7 days)    |
+-----------------------------------------------------------------------+

    All four scopes feed into:

    +-------------------+
    | ContextOrchestrator |  -->  ContextBundle  -->  prompt builder  -->  agent
    +-------------------+
```
