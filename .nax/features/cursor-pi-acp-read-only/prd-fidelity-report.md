# PRD Fidelity Report (Phase 9) - cursor-pi-acp-read-only

**Spec:** docs/specs/SPEC-cursor-pi-acp-read-only.md (af9f13786)
**PRD:** .nax/features/cursor-pi-acp-read-only/prd.json (nax plan --profile cross-agent)
**Reviewed against:** /Users/williamkhoo/workspace/subrina-coder/projects/nax/repos/nax at af9f13786
**Date:** 2026-10-17
**Phases run:** 1 of 9 (Phase 9 only, by request; phases 1-8 passed in two earlier passes)
**Verdict:** ready to run, with one major to patch first (US-001 AC 13 secret literal). No blockers.

## Summary

| Check | Examined | Result |
|:--|:--|:--|
| 1. Spec AC -> PRD AC mapping | 93 spec ACs -> 136 PRD ACs | 93/93 mapped, 0 missing, 0 degraded |
| 2. Behavioural fidelity | 136 PRD ACs | 0 grep/file ACs, 0 stripped assertions; 0 deprecated tags |
| 2b. Signature reality | 9 existing-API calls with explicit args | 0 contradictions |
| 3. Orphan PRD ACs | 15 PRD ACs with no 1:1 spec AC | 0 material scope; 3 minor |
| 3b. Dependency fidelity | 6 stories, 11 edges | exact match |
| 4. File roles | 6 stories: 5 contextFiles lists, 9 Creates | 0 blockers, 0 majors |
| 5. Meta-AC / 5b correction survival | 5 corrections | all in description or AC (none analysis-only) |
| 5c. Class B satisfiability | invocation ACs: US-003 19-26, 36-37, US-004 30-31 | 0 unsatisfiable; 1 spec-level defect (M1) |
| 6. Out of scope | 12 spec bullets -> 12 prd.outOfScope | verbatim, same order; 0 inverted into ACs |
| 7. Terminal cleanup | spec has none | n/a |
| 8. Modifies -> modifiedFiles | 11 spec paths | 11/11, each with path and reason |
| 9. Forward-ref re-sweep | 21 symbols over 136 ACs + 6 descriptions | 0 drift |

## Per-story mapping (spec AC -> PRD AC)

| Story | Spec ACs | PRD ACs | Extra from atomic splits | Extra derived (non-1:1) | Missing |
|:--|:--|:--|:--|:--|:--|
| US-001 | 17 | 20 | +3 (3, 4, 13) | 0 | 0 |
| US-002 | 18 | 26 | +6 (1, 2, 6, 7x3, 13) | 2 (AC 25, 26) | 0 |
| US-003 | 23 | 37 | +12 (2, 4, 10, 13, 14, 21x6, 22) | 2 (AC 36, 37) | 0 |
| US-004 | 23 | 36 | +10 | 3 (AC 34, 35, 36) | 0 |
| US-005 | 8 | 10 | +1 (7) | 1 (AC 10) | 0 |
| US-006 | 4 | 7 | +3 (1, 2, 3) | 0 | 0 |
| Total | 93 | 136 | +35 | 8 | 0 |

Arithmetic holds: 93 + 35 + 8 = 136. The planner's own ledger in `analysis` was re-derived independently and agrees on every story.

## Spec facts that must survive

- 6 stories US-001..US-006: present.
- Dependencies: US-003 -> [US-001, US-002, US-006]; US-004 -> [US-001, US-002, US-003]; US-005 -> [US-001..US-004, US-006]; US-001, US-002, US-006 -> []. Exact set match.
- Out of Scope: 12 of 12 in `prd.outOfScope`, verbatim. No `US-00N only:` hoists exist, so none need a prefix.
- Modifies: spec and PRD both hold 11 entries (US-001 3, US-002 2, US-003 0, US-004 3, US-005 2, US-006 1). The brief said 10; the spec has 11 and all 11 are in the PRD. US-003 has no `modifiedFiles`, as required. US-006 has `packages/nax-agent/api/nax-agent.api.txt`. No entry has a comma-led reason.
- Forward-referenced symbols: all 21 appear in the PRD spelled identically (counts: policyLaunchEnv 13, opencodePermissionConfig 12, cursorCliConfig 12, piToolArgs 12, NO_RULES 16, AcpRule 9, AcpPermissionRules 10, shellCommandOf 13, shellRuleVerdict 22, SHELL_RULE_REASON 5, PI_SHELL_GATE_TITLE 10, PI_SHELL_GATE_SOURCE 6, writeCursorPolicy 6, writePiFile 9, _policyFilesDeps 15, resolveModelValue 12, CURSOR_CONFIG_OPTIONS 8, compileArgvPattern 14, matchesArgvPattern 13, CompiledPattern 8, isReadOnlyProfile 3). A regex sweep for near-miss variants found none.

## Correction survival

| Correction | Where it reaches the implementer |
|:--|:--|
| opt-allow_once / opt-reject_once (not yes/no) in pi tests | US-003 AC 19-26; US-004 AC 30, 31 (acceptanceCriteria) |
| pi review decision AC lives in US-004 | US-004 AC 30, 31, and its description ("Pi review round trips must prove...") |
| native argv prefix matching in shellRuleVerdict | US-003 AC 17, 18 and description; US-006 AC 3-4 and description |
| PermissionContext fields optional | US-003 description (Integration targets, and "new PermissionContext fields are optional") |
| Modifies trimmed, US-003 None | US-003 has no `modifiedFiles`; description states it "changes only source files" |

None rely on `analysis`, `storyPoints` or `tags`.

## Findings

### Blocker
None.

### Major

**M1. US-001 AC 13 (spec US-001 AC 11): the `SECRET1` literal cannot be scrubbed by the mandated mechanism.**
- Spec reference: Design "Cursor registration and model ids" (names pass through `cleanLabel(id, secrets, ...)`) and US-001 AC 11.
- Codebase reality: `packages/nax-agent-acp/src/client/text.ts` defines `MIN_SECRET_LENGTH = 8`, and `scrubSecrets` filters out shorter secrets. `SECRET1` has 7 characters, so `cleanLabel` leaves it intact, and the AC "message does not include SECRET1" fails against the design as written. This is a spec defect that earlier phases missed; the planner noticed it.
- PRD handling: US-001 description adds an unreviewed instruction ("ensure this helper's refusal cannot reveal that supplied secret while retaining cleanLabel's existing behavior"). The AC is satisfiable only by an extra scrub not in the spec's design, so an implementer could choose differently.
- Fix: use a secret of 8 or more characters in the AC (for example `SECRET12`). Patch spec US-001 AC 11 and PRD US-001 AC 13 in place, and drop the description paragraph or keep it as a hint. This is a one-line AC edit and needs no re-plan.

### Minor

**m1. US-006 test location.** The US-006 description tells the implementer to add the four checks to "an existing suitable policy test file", and `contextFiles` now holds `packages/nax-agent/test/unit/tools/policy.test.ts` (a helpful addition; it exists). Neither the spec nor `modifiedFiles` authorises editing that file, while every other story lists its test files under Creates or Modifies. The spec never says where US-006's tests go. Suggest naming the file in the spec's US-006 Modifies (or a Creates entry) so the test-writer is not blocked by test-authorship isolation.

**m2. Derived ACs with no 1:1 spec AC (8).** US-002 AC 25-26 (`acpBackend()` throws for relative `stateDir` and for bad patterns), US-003 AC 36-37, US-004 AC 34-36 and US-005 AC 10 all come from the Failure Handling table, so they are traceable and add no scope. Two are redundant with earlier PRD ACs: US-003 AC 36 repeats spec AC 7/11 unit coverage, and US-004 AC 36 repeats AC 26/28. US-005 AC 10 (an empty-pattern deny rule forwarded by `backendOptions` makes `acpBackend` throw) is the only one with no spec Failure Handling row naming `backendOptions`; it is consistent with US-002 AC 26 and harmless.

**m3. Story AC counts above maxAcCount 24.** US-002 has 26, US-003 37, US-004 36. The global `precheck.storySizeGate` has `action: "warn"` (`~/.nax/config.json`) and the project config sets only `maxAcCount: 24`, so this warns and does not refuse. Informational.

**m4. Small AC adjustments, no loss of meaning.** US-001 AC 1 adds the qualifier "at this story's registration stage (US-004 subsequently adds policy cursor)", which matches the US-004 Modifies correction. US-001 AC 15 adds "naming every matching offered ID" (from Design) and AC 14 adds "profile full" (not in spec AC 13); both are harmless.

**m5. Spec-level gap carried through.** The Design says a request of kind `other` that is not the pi gate is denied with `readOnlyReason("review")`, but no spec AC pins it. The PRD holds it only as a US-003 `suggestedCriteria` entry. Not a PRD fidelity fault; consider promoting it to an AC.

## Checks that came back clean

- Signature reality: `resolveAcpOptions(input, source)`, `launchEnvFor(profile, entry)`, `registryEntry(name)`, `acpEntry(name)`, `acpAdapterFor(name)`, `backendOptions(agent, opts, onProcess?)` all match the calls in the PRD ACs. US-005 AC 9 values (inheritEnv false, initializeTimeoutMs 30_000, cancelGraceMs 10_000) match `open-context.ts` defaults and the test `OPTS`, which sets no deadlines.
- Lexer ACs: `echo $HOME` is opaque (`bash-lex.ts` line 204), so US-003 AC 37 and the unit AC hold. Prefix semantics in `policy-match.ts` (`matchesArgvPattern`: pattern tokens a prefix of argv) support US-003 AC 17-18 and US-006 AC 3-4.
- File roles: no story's `expectedFiles` entry appears in its own `contextFiles`. US-004 keeps `rule-policy.ts` (US-002) and `shell-rules.ts` (US-003) in `contextFiles`, which is correct because they are upstream-produced and both are dependencies.
- Every path in `contextFiles` and `modifiedFiles` that is not a Creates entry exists on disk.

## Post-report patches (2026-10-17)

- **M1 fixed:** spec US-001 AC 11 and PRD US-001 AC 13 now use the 8-character secret `SECRET12` (`cleanLabel` redacts secrets of 8 or more characters); the planner's workaround sentence in the US-001 description was replaced with "ambiguous-match ids go through cleanLabel with the session secrets, as offeredModels does".
- **m1 fixed:** US-006's tests go in a new file `packages/nax-agent/test/unit/tools/policy-match-exports.test.ts`, added to the spec's US-006 Creates and the PRD's US-006 `expectedFiles`; the description no longer points at an existing policy test file.
- m2-m5 accepted as is (harmless derived ACs; storySizeGate action is `warn`; wording; m5 left to `suggestedCriteria`).
