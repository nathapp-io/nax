#!/usr/bin/env bun
/**
 * Reports the `as unknown as` casts in test/ grouped by the buckets in
 * docs/plans/HANDOFF-1514-cast-sweep.md, so the handoff's work queue can be
 * regenerated instead of going stale (#1514 phase 1a).
 *
 * Mirrors check-test-as-unknown-as.ts's scan exactly — per match, allow-marked
 * lines and their neighbours skipped — so the buckets sum to that ratchet.
 *
 *   bun scripts/report-cast-buckets.ts
 */
import { Glob } from "bun";
const EXEMPT = new Set([
  "test/unit/scripts/check-test-typecheck.test.ts",
  "test/unit/scripts/check-test-as-unknown-as.test.ts",
]);
const P = /as unknown as\s+(typeof\s+[\w$.]+|[A-Za-z_$][\w$]*(?:<[^;=)\n]*?>)?(?:\[[^\]\n]*\])?)/g;
const RAW = /\bas\s+unknown\s+as\b/g;
const A = "test-ratchet-allow: as-unknown-as";
const A3 = [
  "NaxConfig",
  "PipelineContext",
  "PRD",
  "Partial<NaxConfig>",
  "UserStory",
  "CallContext",
  'PipelineContext["config"]',
  "NaxRuntime",
];
const A3re = [/Logger>$/, /^import\(/, /^Parameters<typeof preIterationTierCheck>\[(0|2|3)\]$/];
const B = [/spawn$/, /^ReturnType<typeof Bun\.spawn>$/, /^Parameters<typeof handleTierEscalation>/];
const Cii = [/createDebateRunner$/, /mergeEngine$/, /createOrchestrator>$/, /createClient>$/];
const Ci = [/^typeof _\w+\./, /^ReturnType<typeof _\w+\./];
const D = [/^Record<string, unknown>$/, /^string(\[\])?$/, /^Bakeoff/, /^ContestantRunnerDeps/];
const b = { a: 0, b: 0, ci: 0, cii: 0, d: 0, e: 0, tail: 0 };
const tail: Record<string, number> = {};
const g = new Glob("**/*.ts");
for await (const f of g.scan({ cwd: "test" })) {
  const rel = "test/" + f;
  if (EXEMPT.has(rel)) continue;
  const lines = (await Bun.file(rel).text()).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.includes(A) || lines[i - 1]?.includes(A) || lines[i + 1]?.includes(A)) continue;
    const raw = (l.match(RAW) || []).length;
    const ms = [...l.matchAll(P)];
    b.e += raw - ms.length;
    for (const m of ms) {
      const k = m[1]!.replace(/\s+/g, " ");
      if (A3.includes(k) || A3re.some((r) => r.test(k))) b.a++;
      else if (B.some((r) => r.test(k))) b.b++;
      else if (Cii.some((r) => r.test(k))) b.cii++;
      else if (Ci.some((r) => r.test(k))) b.ci++;
      else if (D.some((r) => r.test(k))) b.d++;
      else {
        b.tail++;
        tail[k] = (tail[k] || 0) + 1;
      }
    }
  }
}
console.log(`3a=${b.a} 3b=${b.b} 3c-i=${b.ci} 3c-ii=${b.cii} 3d=${b.d} 3e=${b.e} tail=${b.tail}`);
console.log(
  "SUM",
  Object.values(b).reduce((x, y) => x + y, 0),
  "(ratchet 681)",
);
console.log("\ntop tail:");
Object.entries(tail)
  .sort((x, y) => y[1] - x[1])
  .slice(0, 12)
  .forEach(([k, n]) => console.log(String(n).padStart(4), k.slice(0, 60)));
