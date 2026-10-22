import { describe, expect, test } from "bun:test";
import { buildForgeReadInstructions } from "@/prompts";

describe("buildForgeReadInstructions", () => {
  test("AC-3 names read tools and explains trust, binding and log modes", () => {
    const text = buildForgeReadInstructions();
    for (const name of ["pr", "checks", "log", "threads", "comments"]) expect(text).toContain(`nax-forge__${name}`);
    for (const term of ["read-only", "untrusted", "writer", "search", "from", "tail", "bound PR"])
      expect(text).toContain(term);
  });
});
