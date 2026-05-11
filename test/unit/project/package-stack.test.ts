import { describe, expect, test } from "bun:test";
import { inferFrameworkAndTestRunner } from "@/project";

describe("inferFrameworkAndTestRunner", () => {
  test("prefers bun:test when scripts.test uses bun test even with e2e frameworks present", () => {
    const inferred = inferFrameworkAndTestRunner({
      scripts: { test: "bun test" },
      devDependencies: {
        "@playwright/test": "^1.0.0",
        cypress: "^13.0.0",
      },
    });

    expect(inferred.testRunner).toBe("bun:test");
  });

  test("uses unit runner from manifest when bun test script is absent", () => {
    const inferred = inferFrameworkAndTestRunner({
      scripts: { test: "vitest run" },
      devDependencies: {
        vitest: "^2.0.0",
        "@playwright/test": "^1.0.0",
      },
    });

    expect(inferred.testRunner).toBe("vitest");
  });

  test("preserves ava fallback for summary runner", () => {
    const inferred = inferFrameworkAndTestRunner({
      devDependencies: {
        ava: "^6.0.0",
      },
    });

    expect(inferred.testRunner).toBe("ava");
  });

  test("does not throw when scripts.test is non-string", () => {
    const inferred = inferFrameworkAndTestRunner({
      scripts: { test: { cmd: "bun test" } },
      dependencies: {
        react: "^19.0.0",
      },
    });

    expect(inferred.testRunner).toBe("");
    expect(inferred.framework).toBe("React");
  });
});
