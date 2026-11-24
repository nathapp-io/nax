/**
 * US-001 — the injectable host defaults every Linux placeholder module reads
 * (`_placeholderDeps`, src/sandbox/placeholder-deps.ts).
 *
 * The real defaults are exercised here rather than stubbed: this is the only
 * place that proves the seam's own implementations reach the live host. AC18 is
 * Linux-only because `/proc` is; the rest holds on every platform.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { credentialsConfig } from "#src/infra/index";
import { realOrRaw } from "#src/internal/realpath";
import { _placeholderDeps } from "#src/sandbox/placeholder-deps";
import { parseMountPoints } from "#src/sandbox/placeholder-paths";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

const linuxOnly = test.skipIf(process.platform !== "linux");

let base: string;

beforeEach(() => {
  base = realOrRaw(makeTempDir("nax-placeholder-deps-"));
});
afterEach(() => cleanupTempDir(base));

describe("_placeholderDeps — host facts", () => {
  test("platform, uid, homedir and lockTimeoutMs read the live host", () => {
    expect(_placeholderDeps.platform()).toBe(process.platform);
    expect(_placeholderDeps.uid()).toBe(process.getuid?.() ?? 0);
    expect(_placeholderDeps.homedir()).toBe(homedir());
    expect(_placeholderDeps.lockTimeoutMs).toBe(2000);
  });

  test("ledgerDir nests sandbox/placeholders under the configured nax config directory", () => {
    expect(_placeholderDeps.ledgerDir()).toBe(join(credentialsConfig().configDir(), "sandbox", "placeholders"));
  });

  test("isProcessAlive reports this process alive and an invalid pid dead", () => {
    expect(_placeholderDeps.isProcessAlive(process.pid)).toBe(true);
    expect(_placeholderDeps.isProcessAlive(-1)).toBe(false);
  });
});

describe("_placeholderDeps.remove", () => {
  test("unlinks a file and rmdirs a directory", () => {
    const file = join(base, "placeholder-file");
    const dir = join(base, "placeholder-dir");
    writeFileSync(file, "");
    mkdirSync(dir);

    _placeholderDeps.remove(file, "file");
    _placeholderDeps.remove(dir, "dir");

    expect(existsSync(file)).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  test("rethrows the errno of a path that is already gone", () => {
    expect(() => _placeholderDeps.remove(join(base, "never-there"), "file")).toThrow();
  });
});

describe("_placeholderDeps — the real /proc and boot-id readers (Linux only)", () => {
  linuxOnly("US-001 AC18: startTicks, realUid and mountinfo describe this very process", () => {
    const ticks = _placeholderDeps.startTicks(process.pid);

    expect(Number.isInteger(ticks)).toBe(true);
    expect(ticks).toBeGreaterThan(0);
    expect(_placeholderDeps.proc.realUid(process.pid)).toBe(process.getuid?.() ?? 0);
    expect(parseMountPoints(_placeholderDeps.proc.mountinfo(process.pid))).toContain("/");
  });

  linuxOnly("the rest of the seam reads this process's namespace and the boot id", () => {
    expect(_placeholderDeps.proc.listPids()).toContain(process.pid);
    expect(_placeholderDeps.proc.mountNs(process.pid).startsWith("mnt:[")).toBe(true);
    expect(_placeholderDeps.bootId()).toBe(_placeholderDeps.bootId());
    expect(_placeholderDeps.bootId().length).toBeGreaterThan(0);
  });
});
