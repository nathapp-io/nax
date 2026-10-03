/**
 * One test per Node built-in replacement (S2 spec §4.1), on real Node. The
 * bun suites already pin these behaviours; this suite proves the shipped
 * runtime, where `Bun.file`/`Bun.write`/`Bun.hash`/`Bun.CryptoHasher`/
 * `Bun.which` no longer exist.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, ResolvedModel } from "@nathapp/nax-ai";
import { afterEach, expect, test } from "vitest";
import { digest64 } from "#src/infra/spin-breaker/hash";
import { fileSizeOrZero } from "#src/internal/file-size";
import { _clientDeps, _resetNativeClient, getNativeClient } from "#src/native/client";
import { readApprovalsFileDetailed } from "#src/permissions/approvals-store";
import { which } from "#src/runtime/which";
import { _gitGuardDeps } from "#src/sandbox/git-guards";
import { _spillDeps } from "#src/tools/spill";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "nax-node-builtin-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  _resetNativeClient();
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

test("Bun.file .size → statSync: UTF-8 bytes, zero for a missing file, other errors propagate", () => {
  const dir = tmp();
  const file = join(dir, "héllo.txt");
  writeFileSync(file, "héllo");
  expect(fileSizeOrZero(file)).toBe(6);
  expect(fileSizeOrZero(join(dir, "missing"))).toBe(0);
  expect(() => fileSizeOrZero(join(file, "child"))).toThrow(/ENOTDIR/);
});

test("Bun.file read → readFile: a missing approvals file is missing, a permission error is not", async () => {
  const dir = tmp();
  expect(await readApprovalsFileDetailed(join(dir, "approvals.json"))).toEqual({
    state: "missing",
    file: { entries: [], taint: undefined },
    droppedMalformed: 0,
  });
  const denied = join(dir, "denied.json");
  writeFileSync(denied, "{}");
  chmodSync(denied, 0o000);
  if (process.getuid?.() === 0) return; // root ignores the mode; CI runs as a user
  await expect(readApprovalsFileDetailed(denied)).rejects.toThrow(/EACCES/);
});

test("Bun.file read → readFile: git-guard text reads UTF-8 and rejects ENOENT", async () => {
  const dir = tmp();
  const file = join(dir, "ignore.txt");
  writeFileSync(file, "héllo");
  expect(await _gitGuardDeps.readText(file)).toBe("héllo");
  await expect(_gitGuardDeps.readText(join(dir, "missing"))).rejects.toThrow(/ENOENT/);
});

test("Bun.write → fs/promises writeFile: byte count and stored bytes", async () => {
  const dir = tmp();
  const file = join(dir, "spill.txt");
  expect(await _spillDeps.writeFile(file, "héllo")).toBe(6);
  expect(await _gitGuardDeps.readText(file)).toBe("héllo");
});

test("Bun.hash → sha256's first 16 hex characters", () => {
  expect(digest64("")).toBe("e3b0c44298fc1c14");
  expect(digest64("abc")).toBe("ba7816bf8f01cfea");
});

test("Bun.CryptoHasher → createHash: the override digest is 12 hex characters", async () => {
  const model: ResolvedModel = {
    id: "stub",
    provider: "a",
    protocol: "stub",
    pricing: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1,
    supportsTools: false,
    thinkingLevels: [],
  };
  const stub: Client = {
    model: async () => model,
    listModels: async () => [model],
    pricing: () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }),
    stream: async function* () {},
    complete: async () => ({ text: "unused", usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "stop" }),
    validate: () => {},
  };
  _clientDeps.build = async () => stub;
  await getNativeClient([{ provider: "a", models: [] }]);
  const error = await getNativeClient([{ provider: "b", models: [] }]).then(
    () => undefined,
    (e: unknown) => e as { context?: { requested?: { digest?: string } } },
  );
  expect(error?.context?.requested?.digest).toMatch(/^[0-9a-f]{12}$/);
});

test("Bun.which → the PATH walk: executable files resolve, others do not", () => {
  const dir = tmp();
  const tool = join(dir, "tool");
  writeFileSync(tool, "#!/bin/sh\n");
  chmodSync(tool, 0o755);
  expect(which("tool", dir)).toBe(tool);
  writeFileSync(join(dir, "not-exec"), "x");
  chmodSync(join(dir, "not-exec"), 0o644);
  expect(which("not-exec", dir)).toBeNull();
  expect(which("absent", dir)).toBeNull();
  expect(which(join(dir, "tool"), dir)).toBe(join(dir, "tool"));
});
