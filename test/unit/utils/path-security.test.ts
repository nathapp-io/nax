import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { validateModulePath } from "../../../src/utils/path-security";

// ─────────────────────────────────────────────────────────────────────────────
// Temp directory for symlink tests
// ─────────────────────────────────────────────────────────────────────────────

let tmpAllowed: string;
let tmpOutside: string;

try {
  tmpAllowed = mkdtempSync(join(tmpdir(), "nax-sec1-allowed-"));
  tmpOutside = mkdtempSync(join(tmpdir(), "nax-sec1-outside-"));
} catch {
  tmpAllowed = "";
  tmpOutside = "";
}

afterAll(() => {
  try { rmSync(tmpAllowed, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(tmpOutside, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─────────────────────────────────────────────────────────────────────────────

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

describe("path-security utility — symlink bypass (SEC-1)", () => {
  test("rejects symlink inside allowed root pointing outside (SEC-1)", () => {
    if (!tmpAllowed || !tmpOutside) return; // skip if temp dirs unavailable

    const linkPath = join(tmpAllowed, "evil-link");
    try {
      symlinkSync(tmpOutside, linkPath);
    } catch {
      // If symlink creation fails (e.g. permissions), skip the test
      return;
    }

    const result = validateModulePath(linkPath, [tmpAllowed]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("outside allowed roots");
  });

  test("allows real path inside allowed root", () => {
    if (!tmpAllowed) return;

    const result = validateModulePath(tmpAllowed, [tmpAllowed]);
    expect(result.valid).toBe(true);
  });
});
