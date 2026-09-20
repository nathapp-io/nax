/**
 * Curator Config Schema Tests — US-004 (Size-gate automatic rollup retention)
 *
 * AC1 and AC2 pin the schema defaults for the new `retention` field on
 * `CuratorConfigSchema`. Before this story `CuratorConfigSchema` carries
 * no `retention`, so `result.data.retention` is `undefined` and these
 * assertions fail with `undefined !== 67108864` / `undefined !== 50`.
 * The implementer adds the field with `.default(...)` in
 * `src/config/schemas-infra.ts`.
 */

import { describe, expect, test } from "bun:test";
import { CuratorConfigSchema } from "@/config/schemas-infra";

describe("CuratorConfigSchema — retention defaults (US-004)", () => {
  test("AC1: parsed retention.pruneThresholdBytes defaults to 67108864 (64 MiB) when unset", () => {
    const result = CuratorConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    const retention = (result.data as { retention?: { pruneThresholdBytes?: number; keepRuns?: number } }).retention;
    expect(retention).toBeDefined();
    expect(retention?.pruneThresholdBytes).toBe(67108864);
  });

  test("AC2: parsed retention.keepRuns defaults to 50 when unset", () => {
    const result = CuratorConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    const retention = (result.data as { retention?: { pruneThresholdBytes?: number; keepRuns?: number } }).retention;
    expect(retention).toBeDefined();
    expect(retention?.keepRuns).toBe(50);
  });
});
