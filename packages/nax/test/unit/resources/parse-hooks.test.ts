import { describe, expect, test } from "bun:test";
import * as resources from "@/resources";

const origin = { kind: "claude-user" } as const;
const path = "/hooks/hooks.json";

describe("parseHooksJson", () => {
  test("AC-9 lists event keys without executing hook definitions", () => {
    expect(resources.parseHooksJson(path, '{"hooks":{"PreToolUse":[],"Stop":[]}}', origin)).toEqual({
      resource: { kind: "hooks", events: ["PreToolUse", "Stop"], path, origin },
    });
  });
  test("malformed JSON returns one error diagnostic", () => {
    expect(resources.parseHooksJson(path, "broken", origin)).toEqual({
      diagnostic: { severity: "error", path, origin, message: expect.any(String) },
    });
  });
  test("absent hooks returns no resource", () => {
    expect(resources.parseHooksJson(path, "{}", origin)).toEqual({});
  });
});

describe("hooksFromSettings", () => {
  test("AC-10 absent hooks returns no resource", () => {
    expect(resources.hooksFromSettings(path, { other: true }, origin)).toEqual({});
  });
  test("extracts events only", () => {
    expect(resources.hooksFromSettings(path, { hooks: { Stop: [{ command: "never run" }] } }, origin)).toEqual({
      resource: { kind: "hooks", events: ["Stop"], path, origin },
    });
  });
  test.each([
    { settings: null },
    { settings: [] },
    { settings: { hooks: [] } },
    { settings: { hooks: null } },
    { settings: { hooks: "bad" } },
  ])("invalid hooks container %j returns diagnostic", ({ settings }) => {
    expect(resources.hooksFromSettings(path, settings, origin)).toEqual({
      diagnostic: { severity: "error", path, origin, message: expect.any(String) },
    });
  });
});
