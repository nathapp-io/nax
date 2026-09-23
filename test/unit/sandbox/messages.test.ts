import { describe, expect, test } from "bun:test";
import { denialHintLine, LIKELY_SANDBOX_DENIAL, rawBashRefusalReason, sandboxSentence } from "@/sandbox";

describe("sandbox messages", () => {
  test("network phrasing for open, none and an allow-list", () => {
    expect(sandboxSentence("open")).toContain("network access is unrestricted");
    expect(sandboxSentence([])).toContain("network access is disabled");
    expect(sandboxSentence(["registry.npmjs.org"])).toContain("network access is limited to registry.npmjs.org");
  });

  test("the raw refusal names the fallback modes", () => {
    const r = rawBashRefusalReason("bwrap missing");
    expect(r).toStartWith("sandbox unavailable (bwrap missing): raw bash requires the sandbox");
    expect(r).toContain("gated or escalate");
  });

  test("the hint lists the roots", () => {
    expect(denialHintLine(["/a", "/b"])).toEndWith("writable roots: /a, /b.");
  });

  test("denial detection matches both platforms' wording", () => {
    expect(LIKELY_SANDBOX_DENIAL.test("sh: /x: Operation not permitted")).toBe(true);
    expect(LIKELY_SANDBOX_DENIAL.test("cannot create /x: Read-only file system")).toBe(true);
    expect(LIKELY_SANDBOX_DENIAL.test("No such file or directory")).toBe(false);
  });
});
