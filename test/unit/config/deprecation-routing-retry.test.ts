import { describe, expect, test } from "bun:test";
import { applyRoutingRetryDeprecationWarning } from "../../../src/config/loader";

describe("applyRoutingRetryDeprecationWarning", () => {
  test("warns when routing.llm.retries is set", () => {
    const warnings: string[] = [];
    const conf = { routing: { strategy: "llm", llm: { mode: "per-story", retries: 2 } } };
    applyRoutingRetryDeprecationWarning(conf, (msg: string) => warnings.push(msg));
    expect(warnings.some((w) => w.includes("routing.llm.retries"))).toBe(true);
    expect(warnings.some((w) => w.includes("deprecated"))).toBe(true);
  });

  test("warns when routing.llm.retryDelayMs is set", () => {
    const warnings: string[] = [];
    const conf = { routing: { strategy: "llm", llm: { mode: "per-story", retryDelayMs: 500 } } };
    applyRoutingRetryDeprecationWarning(conf, (msg: string) => warnings.push(msg));
    expect(warnings.some((w) => w.includes("routing.llm.retryDelayMs"))).toBe(true);
  });

  test("emits no warning when neither key is set", () => {
    const warnings: string[] = [];
    const conf = { routing: { strategy: "llm", llm: { mode: "per-story" } } };
    applyRoutingRetryDeprecationWarning(conf, (msg: string) => warnings.push(msg));
    expect(warnings).toHaveLength(0);
  });

  test("returns the same object unchanged (values preserved for op resolver)", () => {
    const conf = { routing: { strategy: "llm", llm: { mode: "per-story", retries: 3, retryDelayMs: 2000 } } };
    const result = applyRoutingRetryDeprecationWarning(conf, () => {});
    expect(result).toBe(conf);
  });
});
