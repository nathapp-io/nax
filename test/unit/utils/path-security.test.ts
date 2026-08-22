import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isRelativeAndSafe, validateModulePath } from "@/utils/path-security";
import { makeTempDir } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Temp directory for symlink tests
// ─────────────────────────────────────────────────────────────────────────────

let tmpAllowed: string;
let tmpOutside: string;

try {
  tmpAllowed = makeTempDir("nax-sec1-allowed-");
  tmpOutside = makeTempDir("nax-sec1-outside-");
} catch {
  tmpAllowed = "";
  tmpOutside = "";
}

afterAll(() => {
  try {
    rmSync(tmpAllowed, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  try {
    rmSync(tmpOutside, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
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

  // STYLE-30 (D-23): the substring `includes("..")` check rejected legit
  // filenames containing two dots (e.g. `src/foo..bar.ts`, version-snapshot
  // patterns). Switched to a segment-wise check that mirrors the rationale
  // at src/prd/modifies.ts:50-57.
  describe("isRelativeAndSafe — STYLE-30 segment-wise check", () => {
    test("allows a relative path whose filename contains two dots", () => {
      expect(isRelativeAndSafe("src/foo..bar.ts")).toBe(true);
      expect(isRelativeAndSafe("snapshots/v1..v2.snap")).toBe(true);
    });

    test("blocks a relative path with a `..` segment", () => {
      expect(isRelativeAndSafe("src/../etc/passwd")).toBe(false);
      expect(isRelativeAndSafe("../sibling")).toBe(false);
    });

    test("blocks an absolute path", () => {
      expect(isRelativeAndSafe("/etc/passwd")).toBe(false);
    });

    test("blocks a Windows-style traversal segment", () => {
      expect(isRelativeAndSafe("src\\..\\etc")).toBe(false);
    });

    test("blocks empty path", () => {
      expect(isRelativeAndSafe("")).toBe(false);
    });
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
