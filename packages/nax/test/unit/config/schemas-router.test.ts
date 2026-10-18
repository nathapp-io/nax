import { describe, expect, test } from "bun:test";
import { FIELD_DESCRIPTIONS } from "@/cli/config-descriptions";
import { DEFAULT_CONFIG } from "@/config";
import { RoutingConfigSchema } from "@/config/schemas-infra";

describe("story router configuration", () => {
  test("AC-1: omitted router defaults mode to off", () => {
    expect(RoutingConfigSchema.parse({ strategy: "keyword" }).router.mode).toBe("off");
  });
  test("AC-2: omitted router defaults precedence to router", () => {
    expect(RoutingConfigSchema.parse({ strategy: "keyword" }).router.precedence).toBe("router");
  });
  test("AC-3: omitted router defaults timeout to 5000", () => {
    expect(RoutingConfigSchema.parse({ strategy: "keyword" }).router.timeoutMs).toBe(5000);
  });
  test("AC-4: root default disables the router", () => {
    expect(DEFAULT_CONFIG.routing.router?.mode).toBe("off");
  });
  test.each([
    ["AC-5", { mode: "auto" }],
    ["AC-6", { precedence: "first" }],
    ["AC-7", { timeoutMs: 0 }],
  ])("%s: invalid router settings are rejected", (_, router) => {
    expect(RoutingConfigSchema.safeParse({ strategy: "keyword", router }).success).toBe(false);
  });
  test("AC-8: explicit settings survive parsing", () => {
    const router = { mode: "apply", precedence: "plan", timeoutMs: 1500 } as const;
    expect(RoutingConfigSchema.parse({ strategy: "keyword", router }).router).toEqual(router);
  });
  test("AC-9: partial shadow settings receive inner defaults", () => {
    expect(RoutingConfigSchema.parse({ strategy: "keyword", router: { mode: "shadow" } }).router).toEqual({
      mode: "shadow",
      precedence: "router",
      timeoutMs: 5000,
    });
  });
  test("AC-10: standalone schema supplies all defaults", async () => {
    const { StoryRouterConfigSchema } = await import("@/config/schemas-router");
    expect(StoryRouterConfigSchema.parse({})).toEqual({ mode: "off", precedence: "router", timeoutMs: 5000 });
  });
  test("AC-11: mode description names all modes", () => {
    const description = FIELD_DESCRIPTIONS["routing.router.mode"];
    expect(description).toBeString();
    for (const mode of ["off", "shadow", "apply"]) expect(description).toContain(mode);
  });
  test("AC-12: precedence description names both choices", () => {
    const description = FIELD_DESCRIPTIONS["routing.router.precedence"];
    expect(description).toBeString();
    for (const precedence of ["router", "plan"]) expect(description).toContain(precedence);
  });
  test("AC-13: timeout has a nonempty description", () => {
    expect(FIELD_DESCRIPTIONS["routing.router.timeoutMs"]).toBeString();
    expect(FIELD_DESCRIPTIONS["routing.router.timeoutMs"].trim().length).toBeGreaterThan(0);
  });
  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid timeout %s", (timeoutMs) => {
    expect(RoutingConfigSchema.safeParse({ strategy: "keyword", router: { timeoutMs } }).success).toBe(false);
  });
});
