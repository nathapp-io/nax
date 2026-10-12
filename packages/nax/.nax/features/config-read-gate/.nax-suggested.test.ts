import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const TOKEN = "sk-abcdefghijklmnopqrstu";
const ROOT_CONFIG = ".nax/config.json";
const API_CONFIG = ".nax/mono/apps/api/config.json";
const APP_CONFIG = ".nax/mono/packages/app/config.json";
const ZETA_CONFIG = ".nax/mono/zeta/config.json";

function writeConfig(root: string, path: string, value: unknown): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, JSON.stringify(value));
}

test("AC-1: an unreadable root config is unscannable without hiding readable mono findings", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "nax-config-read-gate-"));
  try {
    writeConfig(repoRoot, ROOT_CONFIG, {});
    writeConfig(repoRoot, API_CONFIG, { a: { b: TOKEN } });
    writeConfig(repoRoot, APP_CONFIG, { env: { API_TOKEN: TOKEN } });

    // Simulate EACCES on the root config's read, not on discovery/existence.
    // chmod(000) is unreliable when the test runner has privileged access.
    const rootPath = join(repoRoot, ROOT_CONFIG);
    const originalFile = Bun.file.bind(Bun);
    const fileSpy = spyOn(Bun, "file").mockImplementation((path, options) => {
      const file = originalFile(path, options);
      if (String(path) !== rootPath) return file;
      return new Proxy(file, {
        get(target, property) {
          if (property === "text") {
            return async () => {
              throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    try {
      const { scanConfigSecrets } = await import("../../../src/config/secret-scan");
      const result = await scanConfigSecrets(repoRoot);
      expect(result.clean).toBe(false);
      expect(result.findings).toEqual([
        { file: ROOT_CONFIG, pointer: "", kind: "unscannable" },
        { file: API_CONFIG, pointer: "/a/b", kind: "token-shape" },
        { file: APP_CONFIG, pointer: "/env/API_TOKEN", kind: "secret-env" },
      ]);
    } finally {
      fileSpy.mockRestore();
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("AC-2: files and findings are ordered by path and nested JSON traversal", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "nax-config-read-gate-"));
  try {
    writeConfig(repoRoot, ROOT_CONFIG, { a: { b: TOKEN }, c: [{ d: "sk-zyxwvutsrqponmlkjihg" }] });
    writeConfig(repoRoot, API_CONFIG, { reporters: { webhook: { headers: { Authorization: `Bearer ${TOKEN}` } } } });
    writeConfig(repoRoot, APP_CONFIG, { env: { API_TOKEN: TOKEN } });
    writeConfig(repoRoot, ZETA_CONFIG, { x: { y: TOKEN } });

    const { scanConfigSecrets } = await import("../../../src/config/secret-scan");
    const result = await scanConfigSecrets(repoRoot);
    expect(result.files).toEqual([ROOT_CONFIG, API_CONFIG, APP_CONFIG, ZETA_CONFIG]);
    expect(result.findings).toEqual([
      { file: ROOT_CONFIG, pointer: "/a/b", kind: "token-shape" },
      { file: ROOT_CONFIG, pointer: "/c/0/d", kind: "token-shape" },
      { file: API_CONFIG, pointer: "/reporters/webhook/headers/Authorization", kind: "literal-header" },
      { file: APP_CONFIG, pointer: "/env/API_TOKEN", kind: "secret-env" },
      { file: ZETA_CONFIG, pointer: "/x/y", kind: "token-shape" },
    ]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});