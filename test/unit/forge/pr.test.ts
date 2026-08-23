import { describe, expect, test } from "bun:test";
import { type ForgeDeps, extractUrl, hasOpenPr, openPr, viewArgv } from "@/forge";

function deps(
  handler: (cmd: string[]) => { exitCode: number; stdout: string; stderr: string },
  captured?: string[][],
): ForgeDeps {
  return {
    run: async (cmd) => {
      captured?.push(cmd);
      return handler(cmd);
    },
    readText: async () => null,
  };
}

describe("extractUrl", () => {
  test("prefers the JSON url field", () => {
    expect(extractUrl('{"url":"https://github.com/o/r/pull/1"}')).toBe("https://github.com/o/r/pull/1");
  });

  test("accepts GitLab's web_url field", () => {
    expect(extractUrl('{"web_url":"https://gitlab.com/t/r/-/merge_requests/2"}')).toBe(
      "https://gitlab.com/t/r/-/merge_requests/2",
    );
  });

  test("falls back to the first URL in plain output", () => {
    expect(extractUrl("Created:\nhttps://github.com/o/r/pull/3\n")).toBe("https://github.com/o/r/pull/3");
  });

  test("returns undefined when there is no URL", () => {
    expect(extractUrl("nothing here")).toBeUndefined();
  });
});

describe("viewArgv", () => {
  test("builds the gh and glab view commands", () => {
    expect(viewArgv("github", "feat/x", "number,state")).toEqual([
      "gh",
      "pr",
      "view",
      "feat/x",
      "--json",
      "number,state",
    ]);
    expect(viewArgv("gitlab", "feat/x", "number")).toEqual(["glab", "mr", "view", "feat/x", "--output", "json"]);
  });
});

describe("hasOpenPr", () => {
  test("true when the forge reports an open PR", async () => {
    const d = deps(() => ({ exitCode: 0, stdout: '[{"number":7}]', stderr: "" }));
    expect(await hasOpenPr("github", "feat/x", d, "/repo")).toBe(true);
  });

  test("false when the forge reports none", async () => {
    const d = deps(() => ({ exitCode: 0, stdout: "[]", stderr: "" }));
    expect(await hasOpenPr("gitlab", "feat/x", d, "/repo")).toBe(false);
  });

  // BUG-8: a non-zero exit used to read as "no open PR", which let a concurrent
  // run open a duplicate. It must surface as an error so the caller can skip.
  test("throws when the forge CLI fails, rather than reporting no PR", async () => {
    const d = deps(() => ({ exitCode: 1, stdout: "", stderr: "gh: auth required" }));
    expect(hasOpenPr("github", "feat/x", d, "/repo")).rejects.toThrow("auth required");
  });

  test("false when the forge returns unparseable output", async () => {
    const d = deps(() => ({ exitCode: 0, stdout: "not json", stderr: "" }));
    expect(await hasOpenPr("github", "feat/x", d, "/repo")).toBe(false);
  });
});

describe("openPr", () => {
  test("passes --draft to gh when draft is requested and returns the URL", async () => {
    const captured: string[][] = [];
    const d = deps(() => ({ exitCode: 0, stdout: "https://github.com/o/r/pull/9\n", stderr: "" }), captured);
    const r = await openPr("github", { title: "T", body: "B", branch: "feat/x", draft: true }, d, "/repo");
    expect(r.success).toBe(true);
    expect(r.url).toBe("https://github.com/o/r/pull/9");
    expect(captured[0]).toEqual(["gh", "pr", "create", "--title", "T", "--body", "B", "--head", "feat/x", "--draft"]);
  });

  test("omits --draft when a ready PR is requested", async () => {
    const captured: string[][] = [];
    const d = deps(() => ({ exitCode: 0, stdout: "https://gitlab.com/t/r/-/merge_requests/4", stderr: "" }), captured);
    await openPr("gitlab", { title: "T", body: "B", branch: "feat/x", draft: false }, d, "/repo");
    expect(captured[0]).toEqual([
      "glab",
      "mr",
      "create",
      "--title",
      "T",
      "--description",
      "B",
      "--source-branch",
      "feat/x",
    ]);
  });

  test("reports failure with the CLI's stderr", async () => {
    const d = deps(() => ({ exitCode: 1, stdout: "", stderr: "  a PR already exists  " }));
    const r = await openPr("github", { title: "T", body: "B", branch: "feat/x", draft: true }, d, "/repo");
    expect(r).toEqual({ success: false, message: "a PR already exists" });
  });
});
