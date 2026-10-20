import { describe, expect, test } from "bun:test";
import * as bot from "@/bot";

describe("sensitivePaths", () => {
  test("AC-1: flags sensitive files in input order", () => {
    const files = [
      ".nax/config.json",
      "src/a.ts",
      ".github/workflows/ci.yml",
      "apps/web/package.json",
      ".gitlab-ci.yml",
      "x/.npmrc",
      "bunfig.toml",
    ];
    expect(bot.sensitivePaths(files)).toEqual(files.filter((file) => file !== "src/a.ts"));
  });
  test("AC-2: ignores manifest lookalikes", () => {
    expect(bot.sensitivePaths(["src/package.json.bak"])).toEqual([]);
  });
  test("matches root directories and exact names at any depth, preserving duplicates", () => {
    const files = Object.freeze([
      ".gitlab/a",
      "app/bunfig.toml",
      "package.json",
      ".npmrc",
      "app/.github/a",
      ".naxish/a",
      "app/.gitlab-ci.yml",
      "app/bunfig.toml",
    ]);
    expect(bot.sensitivePaths(files)).toEqual([
      ".gitlab/a",
      "app/bunfig.toml",
      "package.json",
      ".npmrc",
      "app/bunfig.toml",
    ]);
    expect(bot.sensitivePaths([])).toEqual([]);
  });
});

describe("fixProtectedPaths", () => {
  test("AC-3: protects control directories in input order", () => {
    expect(bot.fixProtectedPaths([".nax/rules/a.md", ".gitlab/ci.yml", "src/a.ts"])).toEqual([
      ".nax/rules/a.md",
      ".gitlab/ci.yml",
    ]);
  });
  test("AC-4: protects environment files and private key names at any depth", () => {
    const files = ["app/.env", "app/.env.local", "certs/server.pem", "k/tls.key", "home/id_rsa.pub", "src/env.ts"];
    expect(bot.fixProtectedPaths(files)).toEqual(files.slice(0, -1));
  });
  test("AC-5: permits manifest edits", () => {
    expect(bot.fixProtectedPaths(["package.json"])).toEqual([]);
  });
  test.each([
    ".github/workflows/a",
    ".gitlab-ci.yml",
    ".npmrc",
    "app/.npmrc",
    ".env",
    ".env.prod",
    "server.pem",
    "tls.key",
    "id_rsa",
    "id_rsa_backup",
  ])("protects %s", (file) => {
    expect(bot.fixProtectedPaths([file])).toEqual([file]);
  });
  test("ignores similar but unprotected paths", () => {
    expect(
      bot.fixProtectedPaths([
        ".envrc",
        "x.pem.bak",
        "x.key.txt",
        "my_id_rsa",
        "app/package.json",
        "bunfig.toml",
        ".githubish/a",
      ]),
    ).toEqual([]);
    expect(bot.fixProtectedPaths([])).toEqual([]);
  });
});
