import { describe, expect, mock, test } from "bun:test";
import * as bot from "@/bot";
import { type ForgeDeps, hasWriteAccess, type PrComment, type PrRef } from "@/forge";

const ref: PrRef = { forge: "github", host: "github.com", repo: "org/repo", number: 1 };
const run = mock(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
const deps: ForgeDeps = { run, readText: async () => null };
const input = { ref, deps, cwd: "/checkout" };
const comment = (author: string, authorId?: number): PrComment => ({
  id: author,
  kind: "comment",
  author,
  authorId,
  body: "review",
  createdAt: "2026-01-01T00:00:00Z",
});

describe("writerCheck", () => {
  test("AC-1 barrel export authorizes alice", async () => {
    const stub = mock(async () => true);
    const check: bot.WriterCheck = bot.writerCheck(input, stub, mock());
    expect(await check({ login: "alice" })).toBe(true);
  });
  test("AC-2 shares the in-flight promise and caches its settled result per login", async () => {
    const deferred = Promise.withResolvers<boolean>();
    const stub = mock(() => deferred.promise);
    const check = bot.writerCheck(input, stub, mock());
    const first = check({ login: "alice" });
    const second = check({ login: "alice" });
    expect(second).toBe(first);
    deferred.resolve(true);
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(await check({ login: "alice" })).toBe(true);
    expect(stub).toHaveBeenCalledTimes(1);
    expect(await check({ login: "bob" })).toBe(true);
    expect(stub).toHaveBeenCalledTimes(2);
  });
  test("AC-3 rejected permission lookup fails closed", async () => {
    const check = bot.writerCheck(
      input,
      async () => {
        throw new Error("permission unavailable");
      },
      mock(),
    );
    expect(await check({ login: "mallory" })).toBe(false);
  });
  test("AC-4 concurrent and repeated failures warn once per login", async () => {
    const warn = mock();
    const stub = mock(async () => {
      throw new Error("permission unavailable");
    });
    const check = bot.writerCheck(input, stub, warn);
    expect(await Promise.all([check({ login: "mallory" }), check({ login: "mallory" })])).toEqual([false, false]);
    expect(await check({ login: "mallory" })).toBe(false);
    expect(stub).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("mallory", "permission unavailable");
  });
  test("AC-5 forwards the subject id and forge context", async () => {
    const stub = mock(async () => true);
    await bot.writerCheck(input, stub, mock())({ login: "alice", id: 7 });
    expect(stub).toHaveBeenCalledWith(ref, { login: "alice", id: 7 }, deps, input.cwd);
  });
  test("converts non-Error rejections", async () => {
    const warn = mock();
    const check = bot.writerCheck(input, () => Promise.reject("offline"), warn);
    expect(await check({ login: "alice" })).toBe(false);
    expect(warn).toHaveBeenCalledWith("alice", "offline");
  });
});

describe("readWriters", () => {
  test("AC-6 returns distinct authorized comment authors", async () => {
    const check = mock(async ({ login }: { login: string }) => login !== "mallory");
    expect(
      await bot.readWriters([comment("alice"), comment("mallory"), comment("bob"), comment("alice")], check),
    ).toEqual(new Set(["alice", "bob"]));
    expect(await bot.readWriters([], check)).toEqual(new Set());
  });
  test("AC-7 forwards each comment's GitLab author id", async () => {
    const check = mock(async () => true);
    expect(await bot.readWriters([comment("carol", 9)], check)).toEqual(new Set(["carol"]));
    expect(check).toHaveBeenCalledWith({ login: "carol", id: 9 });
  });
  test("AC-8 real GitLab permission check denies a missing author id without an API call", async () => {
    const warn = mock();
    const apiRun = mock(run);
    const check = bot.writerCheck(
      { ...input, ref: { ...ref, forge: "gitlab" }, deps: { ...deps, run: apiRun } },
      hasWriteAccess,
      warn,
    );
    expect(await bot.readWriters([comment("carol")], check)).toEqual(new Set());
    expect(apiRun).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("carol", "[forge] Missing author id");
  });
});
