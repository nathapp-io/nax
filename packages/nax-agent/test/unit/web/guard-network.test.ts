import { expect, test } from "bun:test";
import { createWebExposure } from "#src/web/exposure";
import { createWebExposureGuard } from "#src/web/guard";

function fixture(configuredAllowedDomains?: readonly string[]) {
  const exposure = createWebExposure();
  const guard = createWebExposureGuard({
    exposure,
    configuredAllowedDomains,
    exposedAllowedDomains: ["b.example", "c.example", "*.example.com"],
  });
  return { exposure, guard, mark: () => exposure.markExposed(new Date(0)) };
}

test("AC-1: no network restriction before exposure", () => {
  expect(fixture().guard.exposedNetwork()).toBeUndefined();
});
for (const [name, configured] of [
  ["AC-2: unset", undefined],
  ["AC-3: every host", ["*"]],
] as const) {
  test(`${name} narrows to exposed domains`, () => {
    const { guard, mark } = fixture(configured);
    mark();
    expect(guard.exposedNetwork()).toEqual(["b.example", "c.example", "*.example.com"]);
  });
}
test("AC-4: configured domains intersect exactly", () => {
  const { guard, mark } = fixture(["a.example", "b.example"]);
  mark();
  expect(guard.exposedNetwork()).toEqual(["b.example"]);
});
test("wildcards match only identical strings", () => {
  const { guard, mark } = fixture(["x.example.com", "*.example.com"]);
  mark();
  expect(guard.exposedNetwork()).toEqual(["*.example.com"]);
});
test("AC-5: listener receives the first exposure", () => {
  const { guard, mark } = fixture();
  let calls = 0;
  guard.onExposed(() => calls++);
  expect(calls).toBe(0);
  mark();
  expect(calls).toBe(1);
});
test("AC-6: second mark and other changes never repeat the listener", () => {
  const { guard, mark, exposure } = fixture();
  let calls = 0;
  guard.onExposed(() => calls++);
  mark();
  mark();
  exposure.countSearch();
  exposure.recordUrls(["https://a.example"]);
  expect(calls).toBe(1);
});
test("AC-7: already exposed notifies at registration once", () => {
  const { guard, mark, exposure } = fixture();
  mark();
  let calls = 0;
  guard.onExposed(() => calls++);
  expect(calls).toBe(1);
  exposure.countSearch();
  expect(calls).toBe(1);
});
test("AC-8: unsubscribed listener is never called", () => {
  const { guard, mark } = fixture();
  let calls = 0;
  const unsubscribe = guard.onExposed(() => calls++);
  unsubscribe();
  mark();
  expect(calls).toBe(0);
});
