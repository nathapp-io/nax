import { describe, test, expect } from "bun:test";
import { createConfigLoader } from "../../../src/config/loader-runtime";
import { pickSelector } from "../../../src/config/selector";
import type { NaxConfig } from "../../../src/config";

const minConfig = { routing: { strategy: "keyword" } } as unknown as NaxConfig;
const routingSel = pickSelector("routing-test", "routing");

describe("createConfigLoader", () => {
  test("current() returns the config snapshot", () => {
    const loader = createConfigLoader(minConfig);
    expect(loader.current()).toBe(minConfig);
  });

  test("select() returns narrowed config slice", () => {
    const loader = createConfigLoader(minConfig);
    const slice = loader.select(routingSel);
    expect(slice).toHaveProperty("routing");
  });

  test("select() memoizes — same selector returns same object reference", () => {
    const loader = createConfigLoader(minConfig);
    const first = loader.select(routingSel);
    const second = loader.select(routingSel);
    expect(first).toBe(second);
  });

  test("two selectors with same name return same memo cell", () => {
    const loader = createConfigLoader(minConfig);
    const sel1 = pickSelector("routing-test", "routing");
    const sel2 = pickSelector("routing-test", "routing");
    expect(loader.select(sel1)).toBe(loader.select(sel2));
  });
});
