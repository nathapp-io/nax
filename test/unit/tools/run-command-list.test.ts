import { describe, expect, test } from "bun:test";
import { substituteCommandSpec } from "@/tools/run-command";

describe("substituteCommandSpec", () => {
  test("substitutes into a string spec", () => {
    expect(substituteCommandSpec("bun test {{files}}", { files: "a.test.ts" })).toBe("bun test 'a.test.ts'");
  });

  test("substitutes into every entry of a list spec, ignoring entries that don't declare the placeholder", () => {
    expect(substituteCommandSpec(["tsc --noEmit", "bun test {{files}}"], { files: "a.test.ts" })).toEqual([
      "tsc --noEmit",
      "bun test 'a.test.ts'",
    ]);
  });

  test("propagates an error from any entry", () => {
    const out = substituteCommandSpec(["ok", "echo '{{files}}'"], { files: "a.ts" });
    expect(typeof out).toBe("object");
    expect(out).toHaveProperty("error");
  });

  test("leaves a list without placeholders untouched", () => {
    expect(substituteCommandSpec(["tsc --noEmit", "tsc -p tsconfig.test.json"], {})).toEqual([
      "tsc --noEmit",
      "tsc -p tsconfig.test.json",
    ]);
  });
});
