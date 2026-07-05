# PRD Fidelity Report — empirical-routing

**Spec:** `docs/specs/SPEC-empirical-routing.md`
**PRD:** `.nax/features/empirical-routing/prd.json` (profile `cross-agent-mm`)
**Phase:** spec-review Phase 9 (spec → PRD fidelity)
**Verdict:** ✅ PASS — 0 blockers, 0 majors, 1 faithful addition

## AC mapping (32 spec ACs → 33 PRD ACs)

| Story | Spec ACs | PRD ACs | Notes |
|:------|:--------:|:-------:|:------|
| US-001 config foundation | 6 | 6 | 1:1, behavioral, symbols preserved |
| US-002 band-stat computation | 4 | 5 | **+1 faithful:** PRD AC5 (empty `RunMetrics[]` → empty `BandStat[]`) — completeness edge traceable to the design's no/short-history handling; still ≤ cap 10 |
| US-003 adjustment proposal | 8 | 8 | 1:1 |
| US-004 CLI | 7 | 7 | 1:1 |
| US-005 auto-route plugin | 7 | 7 | 1:1 |

Every spec AC has a PRD destination; none dropped. Every PRD AC is a Given/When/Then
runtime test with the same symbol, inputs, and expected output/invocation as its spec source.
No behavioral AC was degraded into a file-content/grep assertion. No orphan PRD AC introduces
material scope (no new enum values, status codes, config keys, or validation behavior).

## File-role audit (`contextFiles` vs `expectedFiles`)

- **US-001** — `expectedFiles: []` (modifies `src/config/schemas.ts`, creates nothing); matches
  spec `Creates: none`. `contextFiles` all exist.
- **US-002** — `expectedFiles` = `src/routing/calibrate/{types,band-stats}.ts` (+ test); matches
  spec `Creates`. No self-created file in `contextFiles`.
- **US-003** — `expectedFiles` = `src/routing/calibrate/{propose,index}.ts` (+ test). `contextFiles`
  include `src/routing/calibrate/{types,band-stats}.ts` — created by upstream **US-002**
  (`dependencies: ["US-002"]`); correct per §4c (exists at consumer runtime), not a finding.
- **US-004** — `expectedFiles` = `src/cli/routing-calibrate.ts` (+ test). `contextFiles` include
  `src/routing/calibrate/index.ts` (upstream **US-003**, in deps); rest exist.
- **US-005** — `expectedFiles` = `src/plugins/builtin/auto-route/{types,index}.ts` (+ test);
  matches spec `Creates`. `contextFiles` include `src/routing/calibrate/index.ts` (upstream
  **US-003**, in deps); rest exist.

No self-`Creates` file placed in `contextFiles`; no upstream-produced file dropped or
mis-moved into a consumer's `expectedFiles`.

## Dependency DAG

`US-001 []`, `US-002 []` → `US-003 [US-002]` → `US-004 [US-001, US-003]`, `US-005 [US-001, US-003]`.
Acyclic; matches the spec's declared dependency chain.

## Other checks

- **Meta-AC survival:** spec has no meta-ACs — N/A.
- **Terminal-cleanup story:** spec has no removals — N/A.
- **Sizing:** all 5 PRD stories ≤ `maxAcCount` 10 (6 / 5 / 8 / 7 / 7).

**Gate result:** ready for `nax run`.
