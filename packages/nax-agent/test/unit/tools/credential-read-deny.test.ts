// S3 spec 6.3 port: the read tools (Read, Glob, Grep) refuse the host's
// credential directory and trust-store file, not just the sandbox for Bash.
// The case-variant case is darwin-gated because it needs a case-insensitive
// filesystem for the on-disk-casing guarantee `realpathSync.native` gives.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containsCredentialPath, credentialReadRefusal } from "#src/tools/credential-read-deny";
import { globTool, grepTool, readTool } from "#src/tools/index";
import { testProtectedPaths } from "#test/helpers/protected-paths";

let root: string;
let credDir: string;
let trust: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cred-deny-")));
  credDir = join(root, "home", ".nax");
  mkdirSync(credDir, { recursive: true });
  writeFileSync(join(credDir, "credentials.json"), "{}");
  trust = join(root, "home", "trust.json");
  writeFileSync(trust, "{}");
  writeFileSync(join(root, "ok.txt"), "x");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const pp = () => testProtectedPaths({ credentialDir: credDir, trustStoreFile: trust });

function ctxFor(resolvedPaths: string[]) {
  return { root, resolvedPaths, maxBytes: 100_000, maxFileBytes: 1_000_000, protectedPaths: pp() };
}

describe("credentialReadRefusal", () => {
  test("a file inside the credential directory is refused", () => {
    expect(credentialReadRefusal(pp(), join(credDir, "credentials.json"))).toContain("credential");
  });

  test("the credential directory itself and the trust-store file are refused", () => {
    expect(credentialReadRefusal(pp(), credDir)).toBeDefined();
    expect(credentialReadRefusal(pp(), trust)).toBeDefined();
  });

  test("an ordinary file is not", () => {
    expect(credentialReadRefusal(pp(), join(root, "ok.txt"))).toBeUndefined();
  });

  test("a symlink into the credential directory is refused", () => {
    symlinkSync(credDir, join(root, "link"));
    expect(credentialReadRefusal(pp(), join(root, "link", "credentials.json"))).toBeDefined();
  });

  test.if(process.platform === "darwin")("a case-variant spelling on a case-insensitive filesystem is refused", () => {
    expect(credentialReadRefusal(pp(), join(root, "home", ".NAX", "credentials.json"))).toBeDefined();
  });

  test("no policy, or a policy without credential fields, refuses nothing", () => {
    expect(credentialReadRefusal(undefined, join(credDir, "credentials.json"))).toBeUndefined();
    expect(
      credentialReadRefusal({ gitExcludePathspecs: [], gitIgnorePatterns: [] }, join(credDir, "credentials.json")),
    ).toBeUndefined();
  });
});

describe("containsCredentialPath", () => {
  test("a directory that contains the credential directory or the trust store", () => {
    expect(containsCredentialPath(pp(), root)).toBe(true);
    expect(containsCredentialPath(pp(), join(root, "home"))).toBe(true);
  });

  test("a directory that does not", () => {
    mkdirSync(join(root, "src"));
    expect(containsCredentialPath(pp(), join(root, "src"))).toBe(false);
  });
});

describe("Read, Glob and Grep apply the credential read-deny", () => {
  test("Read refuses a credential file", async () => {
    const result = await readTool.run(
      { path: "home/.nax/credentials.json" },
      ctxFor([join(credDir, "credentials.json")]),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("credential");
  });

  test("Glob drops credential hits but keeps the rest", async () => {
    // Explicit dot-dir patterns: Bun's glob does not descend dot directories by default.
    const listed = await globTool.run({ pattern: "home/.nax/*.json" }, ctxFor([]));
    expect(listed.content).not.toContain("credentials.json");
    const top = await globTool.run({ pattern: "home/*" }, ctxFor([]));
    expect(top.content).not.toContain("trust.json");
    const control = await globTool.run({ pattern: "*.txt" }, ctxFor([]));
    expect(control.content).toContain("ok.txt");
  });

  test("Glob drops hits reached through a symlink into the credential directory", async () => {
    symlinkSync(credDir, join(root, "link"));
    const listed = await globTool.run({ pattern: "link/*" }, ctxFor([]));
    expect(listed.content).not.toContain("credentials.json");
  });

  test("Grep refuses a search whose target contains the credential directory", async () => {
    const result = await grepTool.run({ pattern: "x" }, ctxFor([root]));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("narrow");
  });

  test("Grep refuses a search rooted at a symlink to the credential directory", async () => {
    symlinkSync(credDir, join(root, "link"));
    const result = await grepTool.run({ pattern: "x", path: "link" }, ctxFor([join(root, "link")]));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("credential");
  });

  test("Grep inside an unrelated subdirectory still runs", async () => {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "needle");
    const result = await grepTool.run({ pattern: "needle", path: "src" }, ctxFor([join(root, "src")]));
    expect(result.isError).not.toBe(true);
  });
});
