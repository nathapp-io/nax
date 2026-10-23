import { describe, expect, test } from "bun:test";
import type { SandboxConfig } from "#src/config/schemas-sandbox";
import { effectiveAllowLocalBinding } from "#src/sandbox/network";

describe("effectiveAllowLocalBinding", () => {
  test.each<[string, SandboxConfig["network"], boolean]>([
    ["AC-1 allow-list defaults on", { allowedDomains: ["x.test"] }, true],
    ["AC-2 empty allow-list defaults on", { allowedDomains: [] }, true],
    ["AC-3 explicit false wins", { allowedDomains: ["x.test"], allowLocalBinding: false }, false],
    ["AC-4 open network defaults off", {}, false],
    ["AC-5 explicit true wins", { allowLocalBinding: true }, true],
  ])("%s", (_name, network, expected) => {
    expect(effectiveAllowLocalBinding(network)).toBe(expected);
  });
});
