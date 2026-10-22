import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { makeLogger, withTempDir } from "@test/helpers";
import { _checkoutStateDeps, listCiConfigFiles } from "@/bot/checkout-state";

const original = { ..._checkoutStateDeps };
afterEach(() => Object.assign(_checkoutStateDeps, original));

describe("listCiConfigFiles", () => {
  test("AC-1/2: discovers both workflow extensions and GitLab, sorted, excluding other files and directories", async () => {
    await withTempDir(async (worktree) => {
      await mkdir(join(worktree, ".github/workflows/nested.yml"), { recursive: true });
      for (const path of [
        ".github/workflows/rel.yaml",
        ".github/workflows/ci.yml",
        ".gitlab-ci.yml",
        ".github/workflows/notes.md",
        ".github/workflows/nested.yml/hidden.yml",
      ]) {
        await Bun.write(join(worktree, path), "test");
      }
      expect(await listCiConfigFiles(worktree)).toEqual([
        ".github/workflows/ci.yml",
        ".github/workflows/rel.yaml",
        ".gitlab-ci.yml",
      ]);
    });
  });
  test("AC-3: absent CI configuration returns an empty array", async () => {
    await withTempDir(async (worktree) => {
      expect(await listCiConfigFiles(worktree)).toEqual([]);
    });
  });
  test("discovers GitLab even when workflows are absent", async () => {
    await withTempDir(async (worktree) => {
      await Bun.write(join(worktree, ".gitlab-ci.yml"), "test");
      expect(await listCiConfigFiles(worktree)).toEqual([".gitlab-ci.yml"]);
    });
  });
  test("AC-4/14: permission failure returns no paths and logs contextual failure", async () => {
    const logger = makeLogger();
    _checkoutStateDeps.getLogger = () => logger;
    _checkoutStateDeps.readWorkflowFiles = mock(async () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });
    _checkoutStateDeps.exists = async () => true;
    expect(await listCiConfigFiles("/checkout")).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith("bot", "Failed to list CI configuration files", {
      worktree: "/checkout",
      error: "permission denied",
    });
  });
});
