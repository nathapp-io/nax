import { afterEach, describe, expect, test } from "bun:test";
import { installFinishGit, makeFinishContext } from "@test/helpers";
import {
  _finishGitDeps,
  _guardDeps,
  acceptancePathsOf,
  allowedFrom,
  dirtyAcceptancePaths,
  gateGuardPaths,
  guardAcceptanceEdits,
  guardWorthRecording,
  mergeGuard,
} from "@/finish";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";

let restoreGit: () => void = () => {};
afterEach(() => restoreGit());
const NONE = { reverted: [], notRestorable: [], changed: [], beyondRuling: [], failed: false };

describe("guardAcceptanceEdits with the test git stub", () => {
  test("a dirty tree whose only change is not an acceptance path triggers no restore (machine tests stay intact)", async () => {
    const trail: string[] = [];
    const model = { dirty: true, head: 1 };
    restoreGit = installFinishGit(model, trail);
    const out = await guardAcceptanceEdits({ workdir: "/repo", paths: ["test/acceptance/feat.test.ts"], allowed: [] });
    expect(out).toEqual(NONE);
    expect(trail).not.toContain("restore");
    expect(model.dirty).toBe(true);
  });

  test("no paths: nothing reported, no git call", async () => {
    const trail: string[] = [];
    restoreGit = installFinishGit({ dirty: true, head: 1 }, trail);
    expect(await guardAcceptanceEdits({ workdir: "/repo", paths: [], allowed: [] })).toEqual(NONE);
    expect(trail).toEqual([]);
  });
});

type GitOut = { exitCode: number; stdout: string; stderr: string };
const gitOk = (stdout = ""): GitOut => ({ exitCode: 0, stdout, stderr: "" });

describe("guardAcceptanceEdits failure and scope", () => {
  const origGit = _finishGitDeps.git;
  const origRead = _guardDeps.readText;
  afterEach(() => {
    _finishGitDeps.git = origGit;
    _guardDeps.readText = origRead;
  });

  test("a spawn error is reported as failed, never thrown", async () => {
    _finishGitDeps.git = async () => {
      throw new Error("spawn git ENOENT");
    };
    const out = await guardAcceptanceEdits({ workdir: "/repo", paths: ["a.ts"], allowed: [] });
    expect(out).toEqual({ ...NONE, failed: true });
  });

  test("a ruling for AC-40 in one file does not authorise AC-40 edits in another file", async () => {
    const before = "AC-1 old\nAC-40 old\n";
    _finishGitDeps.git = async (rawArgs) => {
      const args = rawArgs[0] === "--literal-pathspecs" ? rawArgs.slice(1) : rawArgs;
      switch (args[0]) {
        case "rev-parse":
          return gitOk("/repo\n");
        case "diff":
          return gitOk("a.ts\0b.ts\0");
        case "ls-tree":
          return gitOk("a.ts\0b.ts\0");
        case "show":
          return gitOk(before);
        default:
          return gitOk();
      }
    };
    _guardDeps.readText = async () => "AC-1 new\nAC-40 new\n";
    const out = await guardAcceptanceEdits({
      workdir: "/repo",
      paths: ["a.ts", "b.ts"],
      allowed: [
        { testPath: "a.ts", acIds: ["AC-40"] },
        { testPath: "b.ts", acIds: ["AC-1"] },
      ],
    });
    expect([...out.changed].sort((a, b) => a.localeCompare(b))).toEqual(["AC-1", "AC-40"]);
    // a.ts changed AC-1 (ruled only in b.ts), b.ts changed AC-40 (ruled only in a.ts)
    expect([...out.beyondRuling].sort((a, b) => a.localeCompare(b))).toEqual(["AC-1", "AC-40"]);
  });

  test("an AC changed only where it is ruled is not beyond the ruling", async () => {
    _finishGitDeps.git = async (rawArgs) => {
      const args = rawArgs[0] === "--literal-pathspecs" ? rawArgs.slice(1) : rawArgs;
      switch (args[0]) {
        case "rev-parse":
          return gitOk("/repo\n");
        case "diff":
          return gitOk("a.ts\0");
        case "ls-tree":
          return gitOk("a.ts\0");
        case "show":
          return gitOk("AC-1 old\nAC-40 old\n");
        default:
          return gitOk();
      }
    };
    _guardDeps.readText = async () => "AC-1 old\nAC-40 new\n";
    const out = await guardAcceptanceEdits({
      workdir: "/repo",
      paths: ["a.ts"],
      allowed: [{ testPath: "a.ts", acIds: ["AC-40"] }],
    });
    expect(out).toEqual({ ...NONE, changed: ["AC-40"] });
  });
});

describe("path helpers", () => {
  test("acceptancePathsOf: existing groups only; none when acceptance is disabled", () => {
    const ctx = makeFinishContext();
    expect(acceptancePathsOf(ctx)).toEqual(["test/acceptance/feat.test.ts"]);
    expect(acceptancePathsOf({ ...ctx, acceptanceStatus: "disabled" })).toEqual([]);
    expect(acceptancePathsOf({ ...ctx, groups: ctx.groups.map((g) => ({ ...g, exists: false })) })).toEqual([]);
  });

  test("gateGuardPaths: a red acceptance gate is never guarded (A2-R1)", () => {
    const ctx = makeFinishContext();
    expect(gateGuardPaths(["acceptance"], ctx)).toEqual([]);
    expect(gateGuardPaths(["lint"], ctx)).toEqual(["test/acceptance/feat.test.ts"]);
  });

  test("allowedFrom unions the findings' allowed edits", () => {
    const f = { severity: "LOW" as const, title: "t", problem: "p", fix: "f" };
    expect(allowedFrom([f, { ...f, allowedAcceptanceEdits: [{ testPath: "a.ts", acIds: ["AC-1"] }] }])).toEqual([
      { testPath: "a.ts", acIds: ["AC-1"] },
    ]);
  });

  test("mergeGuard accumulates without duplicates; guardWorthRecording ignores a clean outcome", () => {
    const merged = mergeGuard({ ...NONE, reverted: ["a"] }, { ...NONE, reverted: ["a", "b"], failed: true });
    expect(merged).toEqual({ ...NONE, reverted: ["a", "b"], failed: true });
    expect(guardWorthRecording(NONE)).toBe(false);
    expect(guardWorthRecording({ ...NONE, changed: ["AC-1"] })).toBe(true);
  });
});

describe("guard with files dirty before the session", () => {
  const origGit = _finishGitDeps.git;
  afterEach(() => {
    _finishGitDeps.git = origGit;
    resetLogger();
  });

  function stubGit(restores: string[][], diffOut: string): void {
    _finishGitDeps.git = async (rawArgs) => {
      const args = rawArgs[0] === "--literal-pathspecs" ? rawArgs.slice(1) : rawArgs;
      switch (args[0]) {
        case "rev-parse":
          return gitOk("/repo\n");
        case "diff":
          return gitOk(diffOut);
        case "ls-tree":
          return gitOk("a.ts\0b.ts\0");
        case "restore":
          restores.push(args);
          return gitOk();
        default:
          return gitOk();
      }
    };
  }

  test("a path already dirty before the session is never restored and is reported as not restorable", async () => {
    const restores: string[][] = [];
    stubGit(restores, "a.ts\0b.ts\0");
    const warns: LogEntry[] = [];
    initLogger({ level: "info", headless: true, useChalk: false });
    addSink((entry) => warns.push(entry));
    const out = await guardAcceptanceEdits({
      workdir: "/repo",
      paths: ["a.ts", "b.ts"],
      allowed: [],
      preDirty: ["a.ts"],
    });
    expect(out.notRestorable).toEqual(["a.ts"]);
    expect(out.reverted).toEqual(["b.ts"]);
    expect(restores).toHaveLength(1);
    expect(restores[0]).not.toContain("a.ts");
    expect(restores[0]).toContain("b.ts");
    expect(warns.some((w) => w.level === "warn" && w.message.includes("already dirty"))).toBe(true);
  });

  test("a clean path the session edited is still restored", async () => {
    const restores: string[][] = [];
    stubGit(restores, "a.ts\0");
    const out = await guardAcceptanceEdits({ workdir: "/repo", paths: ["a.ts"], allowed: [], preDirty: [] });
    expect(out).toEqual({ ...NONE, reverted: ["a.ts"] });
    expect(restores).toHaveLength(1);
  });

  test("unknown pre-session state (null) restores nothing and reports failed", async () => {
    const restores: string[][] = [];
    stubGit(restores, "a.ts\0");
    const out = await guardAcceptanceEdits({ workdir: "/repo", paths: ["a.ts"], allowed: [], preDirty: null });
    expect(out).toEqual({ ...NONE, failed: true });
    expect(restores).toEqual([]);
  });

  test("dirtyAcceptancePaths lists only the guarded paths that differ from HEAD", async () => {
    stubGit([], "a.ts\0unrelated.ts\0");
    expect(await dirtyAcceptancePaths("/repo", ["a.ts", "b.ts"])).toEqual(["a.ts"]);
    expect(await dirtyAcceptancePaths("/repo", [])).toEqual([]);
  });

  test("dirtyAcceptancePaths returns null (unknown) when git fails, and logs a warning", async () => {
    _finishGitDeps.git = async () => {
      throw new Error("spawn git ENOENT");
    };
    const warns: LogEntry[] = [];
    initLogger({ level: "info", headless: true, useChalk: false });
    addSink((entry) => warns.push(entry));
    expect(await dirtyAcceptancePaths("/repo", ["a.ts"])).toBeNull();
    expect(warns.some((w) => w.level === "warn")).toBe(true);
  });

  test("a guard failure logs a warning instead of staying silent", async () => {
    _finishGitDeps.git = async () => {
      throw new Error("spawn git ENOENT");
    };
    const warns: LogEntry[] = [];
    initLogger({ level: "info", headless: true, useChalk: false });
    addSink((entry) => warns.push(entry));
    const out = await guardAcceptanceEdits({ workdir: "/repo", paths: ["a.ts"], allowed: [] });
    expect(out.failed).toBe(true);
    expect(warns.some((w) => w.level === "warn" && w.message.includes("guard failed"))).toBe(true);
  });
});
