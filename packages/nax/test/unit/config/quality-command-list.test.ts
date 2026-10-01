import { describe, expect, test } from "bun:test";
import { QualityConfigSchema } from "@/config/schemas-execution";
import { ReviewConfigSchema } from "@/config/schemas-review";

describe("quality.commands accepts a list", () => {
  test("accepts a string (unchanged)", () => {
    const parsed = QualityConfigSchema.parse({ commands: { typecheck: "tsc --noEmit" } });
    expect(parsed.commands.typecheck).toBe("tsc --noEmit");
  });

  test("accepts a list", () => {
    const parsed = QualityConfigSchema.parse({
      commands: { typecheck: ["tsc --noEmit", "tsc --noEmit -p tsconfig.test.json"] },
    });
    expect(parsed.commands.typecheck).toEqual(["tsc --noEmit", "tsc --noEmit -p tsconfig.test.json"]);
  });

  test("rejects an empty list", () => {
    expect(() => QualityConfigSchema.parse({ commands: { typecheck: [] } })).toThrow();
  });

  test("rejects a list of non-strings", () => {
    expect(() => QualityConfigSchema.parse({ commands: { typecheck: [1, 2] } })).toThrow();
  });

  test("still strips unknown command keys", () => {
    const parsed = QualityConfigSchema.parse({ commands: { typecheck: "tsc", nonsense: "x" } });
    expect("nonsense" in parsed.commands).toBe(false);
  });
});

describe("review.commands accepts a list", () => {
  test("accepts a list", () => {
    const parsed = ReviewConfigSchema.parse({
      enabled: true,
      checks: ["typecheck"],
      commands: { typecheck: ["tsc --noEmit", "tsc -p tsconfig.test.json"] },
    });
    expect(parsed.commands.typecheck).toEqual(["tsc --noEmit", "tsc -p tsconfig.test.json"]);
  });

  test("accepts a string (unchanged)", () => {
    const parsed = ReviewConfigSchema.parse({
      enabled: true,
      checks: ["lint"],
      commands: { lint: "bun run lint" },
    });
    expect(parsed.commands.lint).toBe("bun run lint");
  });
});
