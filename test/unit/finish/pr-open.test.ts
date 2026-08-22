import { describe, expect, test } from "bun:test";
import { openDraftFinishPr, openOrPromotePr, parseView, updatePrBody } from "@/finish";
import type { ForgeDeps } from "@/forge";

function depsFor(handler: (cmd: string[]) => { exitCode: number; stdout?: string; stderr?: string }): {
  deps: ForgeDeps;
  calls: string[][];
} {
  const calls: string[][] = [];
  const deps: ForgeDeps = {
    run: async (cmd) => {
      calls.push(cmd);
      const r = handler(cmd);
      return { exitCode: r.exitCode, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    readText: async () => null,
  };
  return { deps, calls };
}

const args = {
  workdir: "/repo",
  branch: "feat/demo",
  title: "feat: demo",
  body: "body",
  forge: "github" as const,
  // Existing tests below exercise the `opened`/`promoted` branches (always
  // written) and the `already-ready` branch with a commit this run — the
  // `already-ready` + zero-commits gating (#1674 part 3) gets its own
  // dedicated tests further down with an explicit `committedThisRun: false`.
  committedThisRun: true,
};

describe("parseView", () => {
  test("reads isDraft and url from GitHub JSON", () => {
    expect(parseView('{"isDraft":true,"url":"https://x/1"}', "github")).toEqual({
      isDraft: true,
      url: "https://x/1",
    });
  });

  test("treats an unparseable reply as ready, not draft", () => {
    expect(parseView("not json https://x/2", "github")).toEqual({ isDraft: false, url: "https://x/2" });
  });

  test("accepts any of GitLab's draft field spellings", () => {
    expect(parseView('{"work_in_progress":true,"web_url":"https://x/3"}', "gitlab").isDraft).toBe(true);
  });
});

describe("openDraftFinishPr", () => {
  test("opens a draft when the branch has no open PR", async () => {
    const { deps, calls } = depsFor((cmd) =>
      cmd.includes("list") ? { exitCode: 0, stdout: "[]" } : { exitCode: 0, stdout: "https://x/9" },
    );
    await expect(openDraftFinishPr(args, deps)).resolves.toEqual({ url: "https://x/9" });
    expect(calls.at(-1)).toContain("--draft");
  });

  test("returns null when a PR is already open", async () => {
    const { deps, calls } = depsFor(() => ({ exitCode: 0, stdout: '[{"number":1}]' }));
    await expect(openDraftFinishPr(args, deps)).resolves.toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("returns null rather than throwing when the PR list call fails", async () => {
    const { deps } = depsFor(() => ({ exitCode: 1, stderr: "auth required" }));
    await expect(openDraftFinishPr(args, deps)).resolves.toBeNull();
  });

  test("returns null when creation fails", async () => {
    const { deps } = depsFor((cmd) =>
      cmd.includes("list") ? { exitCode: 0, stdout: "[]" } : { exitCode: 1, stderr: "rate limited" },
    );
    await expect(openDraftFinishPr(args, deps)).resolves.toBeNull();
  });
});

describe("openOrPromotePr", () => {
  test("creates the PR when view fails, and reports opened", async () => {
    const { deps, calls } = depsFor((cmd) =>
      cmd.includes("view") ? { exitCode: 1 } : { exitCode: 0, stdout: "https://x/10" },
    );
    await expect(openOrPromotePr(args, deps)).resolves.toEqual({ status: "opened", url: "https://x/10" });
    expect(calls.at(-1)).not.toContain("--draft");
  });

  test("promotes a draft and then writes the body", async () => {
    const { deps, calls } = depsFor((cmd) =>
      cmd.includes("view") ? { exitCode: 0, stdout: '{"isDraft":true,"url":"https://x/11"}' } : { exitCode: 0 },
    );
    await expect(openOrPromotePr(args, deps)).resolves.toEqual({ status: "promoted", url: "https://x/11" });
    expect(calls.map((c) => c[2])).toEqual(["view", "ready", "edit"]);
  });

  test("writes the body on an already-ready PR without promoting", async () => {
    const { deps, calls } = depsFor((cmd) =>
      cmd.includes("view") ? { exitCode: 0, stdout: '{"isDraft":false,"url":"https://x/12"}' } : { exitCode: 0 },
    );
    await expect(openOrPromotePr(args, deps)).resolves.toEqual({ status: "already-ready", url: "https://x/12" });
    expect(calls.map((c) => c[2])).toEqual(["view", "edit"]);
  });

  test("throws FINISH_PR_CREATE_FAILED when creation fails", async () => {
    const { deps } = depsFor((cmd) => (cmd.includes("view") ? { exitCode: 1 } : { exitCode: 1, stderr: "boom" }));
    await expect(openOrPromotePr(args, deps)).rejects.toThrow(/boom/);
  });

  test("throws FINISH_PR_PROMOTE_FAILED when promotion fails", async () => {
    const { deps } = depsFor((cmd) => {
      if (cmd.includes("view")) return { exitCode: 0, stdout: '{"isDraft":true}' };
      return cmd.includes("ready") ? { exitCode: 1, stderr: "denied" } : { exitCode: 0 };
    });
    await expect(openOrPromotePr(args, deps)).rejects.toThrow(/denied/);
  });

  // #1674 part 3 (H2): the already-ready branch must not clobber a human's
  // PR description on a run that changed nothing.
  test("does NOT write the body on an already-ready PR when this run committed nothing", async () => {
    const { deps, calls } = depsFor((cmd) =>
      cmd.includes("view") ? { exitCode: 0, stdout: '{"isDraft":false,"url":"https://x/13"}' } : { exitCode: 0 },
    );
    await expect(openOrPromotePr({ ...args, committedThisRun: false }, deps)).resolves.toEqual({
      status: "already-ready",
      url: "https://x/13",
    });
    expect(calls.map((c) => c[2])).toEqual(["view"]);
  });

  test("still writes the body on an already-ready PR when this run committed a fix", async () => {
    const { deps, calls } = depsFor((cmd) =>
      cmd.includes("view") ? { exitCode: 0, stdout: '{"isDraft":false,"url":"https://x/14"}' } : { exitCode: 0 },
    );
    await expect(openOrPromotePr({ ...args, committedThisRun: true }, deps)).resolves.toEqual({
      status: "already-ready",
      url: "https://x/14",
    });
    expect(calls.map((c) => c[2])).toEqual(["view", "edit"]);
  });

  test("promoting a draft writes the body regardless of commits this run", async () => {
    const { deps, calls } = depsFor((cmd) =>
      cmd.includes("view") ? { exitCode: 0, stdout: '{"isDraft":true,"url":"https://x/15"}' } : { exitCode: 0 },
    );
    await expect(openOrPromotePr({ ...args, committedThisRun: false }, deps)).resolves.toEqual({
      status: "promoted",
      url: "https://x/15",
    });
    expect(calls.map((c) => c[2])).toEqual(["view", "ready", "edit"]);
  });
});

describe("updatePrBody", () => {
  test("never throws when the edit fails", async () => {
    const { deps } = depsFor(() => ({ exitCode: 1, stderr: "nope" }));
    await expect(updatePrBody(args, deps)).resolves.toBeUndefined();
  });

  test("never throws when the run itself rejects", async () => {
    const deps: ForgeDeps = {
      run: async () => {
        throw new Error("spawn failed");
      },
      readText: async () => null,
    };
    await expect(updatePrBody(args, deps)).resolves.toBeUndefined();
  });
});
