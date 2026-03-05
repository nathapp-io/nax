import { describe, expect, test } from "bun:test";
import { validateModulePath } from "../../../src/utils/path-security";
import { resolve } from "node:path";

describe("path-security utility", () => {
  const projectRoot = "/home/project";
  const globalRoot = "/home/global";
  const roots = [projectRoot, globalRoot];

  test("allows relative path within project root", () => {
    // Relative paths are resolved relative to the first allowed root by our validator
    const result = validateModulePath("./plugins/my-plugin.ts", roots);
    expect(result.valid).toBe(true);
    expect(result.absolutePath).toBe(resolve(projectRoot, "plugins/my-plugin.ts"));
  });

  test("allows absolute path within global root", () => {
    const result = validateModulePath("/home/global/plugins/my-plugin.ts", roots);
    expect(result.valid).toBe(true);
    expect(result.absolutePath).toBe("/home/global/plugins/my-plugin.ts");
  });

  test("blocks traversal out of root (../)", () => {
    // resolve handles the ../ then our startsWith check fails
    const result = validateModulePath("../../etc/passwd", roots);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("outside allowed roots");
  });

  test("blocks absolute path outside roots", () => {
    const result = validateModulePath("/usr/bin/node", roots);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("outside allowed roots");
  });

  test("handles root itself", () => {
    const result = validateModulePath("/home/project", roots);
    expect(result.valid).toBe(true);
    expect(result.absolutePath).toBe("/home/project");
  });

  test("blocks empty path", () => {
    const result = validateModulePath("", roots);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("empty");
  });
});
