/**
 * Tests for selector registry population — US-002 AC4
 */

import { describe, expect, test } from "bun:test";

describe("selector registry population", () => {
  test("resolveSelector('synthesis') returns synthesisSelector after registration", async () => {
    const { resolveSelector } = await import("../../../../src/debate/selectors/registry");
    const { synthesisSelector } = await import("../../../../src/debate/selectors/synthesis");
    const resolved = resolveSelector("synthesis");
    expect(resolved).toBe(synthesisSelector);
  });

  test("resolveSelector('majority-fail-closed') returns majorityFailClosedSelector after registration", async () => {
    const { resolveSelector } = await import("../../../../src/debate/selectors/registry");
    const { majorityFailClosedSelector } = await import("../../../../src/debate/selectors/majority");
    const resolved = resolveSelector("majority-fail-closed");
    expect(resolved).toBe(majorityFailClosedSelector);
  });

  test("resolveSelector('majority-fail-open') returns majorityFailOpenSelector after registration", async () => {
    const { resolveSelector } = await import("../../../../src/debate/selectors/registry");
    const { majorityFailOpenSelector } = await import("../../../../src/debate/selectors/majority");
    const resolved = resolveSelector("majority-fail-open");
    expect(resolved).toBe(majorityFailOpenSelector);
  });

  test("resolveSelector('judge') returns judgeSelector after registration", async () => {
    const { resolveSelector } = await import("../../../../src/debate/selectors/registry");
    const { judgeSelector } = await import("../../../../src/debate/selectors/judge");
    const resolved = resolveSelector("judge");
    expect(resolved).toBe(judgeSelector);
  });

  test("resolveSelector throws for unknown kind", async () => {
    const { resolveSelector } = await import("../../../../src/debate/selectors/registry");
    expect(() => resolveSelector("unknown-kind")).toThrow();
  });
});
