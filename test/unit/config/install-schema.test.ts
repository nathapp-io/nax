import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "@/config/schemas";

describe("install.allowScripts schema", () => {
  test("defaults to false", () => {
    const parsed = NaxConfigSchema.parse({});
    expect(parsed.install.allowScripts).toBe(false);
  });

  test("can be turned on explicitly", () => {
    const parsed = NaxConfigSchema.parse({ install: { allowScripts: true } });
    expect(parsed.install.allowScripts).toBe(true);
  });
});
