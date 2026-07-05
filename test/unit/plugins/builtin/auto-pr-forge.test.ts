/**
 * Auto-PR Plugin — Forge Adapter Tests
 *
 * Tests for `detectForge`, `hasOpenPr`, and `openDraft` in `forge.ts`.
 * Mirrors acceptance criteria US-003 §Forge adapter.
 */

import { describe, expect, test } from "bun:test";
import { detectForge, hasOpenPr, openDraft } from "../../../../src/plugins/builtin/auto-pr/forge";
import type { AutoPrDeps } from "../../../../src/plugins/builtin/auto-pr/types";
import type { PostRunActionResult } from "@/plugins/extensions";

interface CapturedRun {
  cmd: string[];
  cwd: string;
}

function makeDeps(handler: (cmd: string[], opts: { cwd: string }) => Promise<{ exitCode: number; stdout: string; stderr: string }> | { exitCode: number; stdout: string; stderr: string }, captured?: CapturedRun[]): AutoPrDeps {
  return {
    run: async (cmd, opts) => {
      const res = await handler(cmd, opts);
      captured?.push({ cmd, cwd: opts.cwd });
      return res;
    },
    readText: async () => null,
  };
}

describe("detectForge", () => {
  test("AC1 — returns 'github' for git@github.com SSH remote", () => {
    expect(detectForge("git@github.com:owner/repo.git")).toBe("github");
  });

  test("AC2 — returns 'gitlab' for https://gitlab.com HTTPS remote", () => {
    expect(detectForge("https://gitlab.com/owner/repo.git")).toBe("gitlab");
  });

  test("AC3 — returns null for a non-github / non-gitlab host", () => {
    expect(detectForge("https://example.com/owner/repo.git")).toBeNull();
  });
});

describe("openDraft (GitHub)", () => {
  test("AC4 — argv begins with gh pr create --draft and includes --head <branch>", async () => {
    const captured: CapturedRun[] = [];
    const deps = makeDeps(
      async () => ({ exitCode: 0, stdout: "https://github.com/owner/repo/pull/42", stderr: "" }),
      captured,
    );

    const result = await openDraft(
      "github",
      { title: "feat: t", body: "b", branch: "nax/auto-pr", draft: true },
      deps,
      "/workdir",
    );

    expect(result.success).toBe(true);
    const argv = captured[0]?.cmd ?? [];
    expect(argv[0]).toBe("gh");
    expect(argv[1]).toBe("pr");
    expect(argv[2]).toBe("create");
    expect(argv).toContain("--draft");
    const headIdx = argv.indexOf("--head");
    expect(headIdx).toBeGreaterThanOrEqual(0);
    expect(argv[headIdx + 1]).toBe("nax/auto-pr");
  });
});

describe("openDraft (GitLab)", () => {
  test("AC5 — argv begins with glab mr create --draft and includes --source-branch <branch>", async () => {
    const captured: CapturedRun[] = [];
    const deps = makeDeps(
      async () => ({ exitCode: 0, stdout: "https://gitlab.com/owner/repo/-/merge_requests/7", stderr: "" }),
      captured,
    );

    const result = await openDraft(
      "gitlab",
      { title: "feat: t", body: "b", branch: "nax/auto-pr", draft: true },
      deps,
      "/workdir",
    );

    expect(result.success).toBe(true);
    const argv = captured[0]?.cmd ?? [];
    expect(argv[0]).toBe("glab");
    expect(argv[1]).toBe("mr");
    expect(argv[2]).toBe("create");
    expect(argv).toContain("--draft");
    const headIdx = argv.indexOf("--source-branch");
    expect(headIdx).toBeGreaterThanOrEqual(0);
    expect(argv[headIdx + 1]).toBe("nax/auto-pr");
  });
});

describe("openDraft (draft flag)", () => {
  test("AC6 — omits --draft when draft is false", async () => {
    const captured: CapturedRun[] = [];
    const deps = makeDeps(
      async () => ({ exitCode: 0, stdout: "https://github.com/owner/repo/pull/9", stderr: "" }),
      captured,
    );

    await openDraft(
      "github",
      { title: "feat: t", body: "b", branch: "nax/auto-pr", draft: false },
      deps,
      "/workdir",
    );

    const argv = captured[0]?.cmd ?? [];
    expect(argv).not.toContain("--draft");
  });
});

describe("openDraft (result parsing)", () => {
  test("AC7 — carries the PR/MR URL from stdout when exitCode is 0", async () => {
    const url = "https://github.com/owner/repo/pull/123";
    const deps = makeDeps(async () => ({ exitCode: 0, stdout: url, stderr: "" }));

    const result = await openDraft(
      "github",
      { title: "feat: t", body: "b", branch: "nax/auto-pr", draft: true },
      deps,
      "/workdir",
    );

    expect(result.url).toBe(url);
  });

  test("AC8 — returns success === false when exitCode is non-zero", async () => {
    const deps = makeDeps(async () => ({ exitCode: 1, stdout: "", stderr: "error: not authed" }));

    const result = await openDraft(
      "github",
      { title: "feat: t", body: "b", branch: "nax/auto-pr", draft: true },
      deps,
      "/workdir",
    );

    expect(result.success).toBe(false);
  });
});

describe("hasOpenPr", () => {
  test("AC9 — returns true when the list runner returns a non-empty JSON array", async () => {
    const deps = makeDeps(async () => ({
      exitCode: 0,
      stdout: JSON.stringify([{ number: 1, state: "OPEN", headRefName: "nax/auto-pr" }]),
      stderr: "",
    }));

    const result = await hasOpenPr("github", "nax/auto-pr", deps, "/workdir");

    expect(result).toBe(true);
  });

  test("AC10 — returns false when the list runner returns an empty JSON array", async () => {
    const deps = makeDeps(async () => ({ exitCode: 0, stdout: "[]", stderr: "" }));

    const result = await hasOpenPr("github", "nax/auto-pr", deps, "/workdir");

    expect(result).toBe(false);
  });

  test("GitLab path — returns true for a non-empty JSON MR list", async () => {
    const deps = makeDeps(async () => ({
      exitCode: 0,
      stdout: JSON.stringify([{ iid: 7, source_branch: "nax/auto-pr", state: "opened" }]),
      stderr: "",
    }));

    const result = await hasOpenPr("gitlab", "nax/auto-pr", deps, "/workdir");

    expect(result).toBe(true);
  });

  test("GitLab path — emits glab mr list with --output json so the result parses", async () => {
    const captured: CapturedRun[] = [];
    const deps = makeDeps(
      async () => ({ exitCode: 0, stdout: "[]", stderr: "" }),
      captured,
    );

    await hasOpenPr("gitlab", "nax/auto-pr", deps, "/workdir");

    const argv = captured[0]?.cmd ?? [];
    expect(argv[0]).toBe("glab");
    expect(argv).toContain("--output");
    const outputIdx = argv.indexOf("--output");
    expect(argv[outputIdx + 1]).toBe("json");
  });
});
