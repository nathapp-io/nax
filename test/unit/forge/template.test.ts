import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { type ForgeDeps, findPrTemplate } from "@/forge";

function deps(files: Record<string, string>, read?: string[]): ForgeDeps {
  return {
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    readText: async (p: string) => {
      read?.push(p);
      return files[p] ?? null;
    },
  };
}

describe("findPrTemplate", () => {
  test("returns the GitHub template verbatim", async () => {
    const p = path.join("/repo", ".github/PULL_REQUEST_TEMPLATE.md");
    expect(await findPrTemplate("/repo", "github", deps({ [p]: "## Summary\n\n" }))).toBe("## Summary\n\n");
  });

  test("honours GitHub candidate priority order", async () => {
    const read: string[] = [];
    const lower = path.join("/repo", ".github/pull_request_template.md");
    await findPrTemplate("/repo", "github", deps({ [lower]: "x" }, read));
    expect(read[0]).toBe(path.join("/repo", ".github/PULL_REQUEST_TEMPLATE.md"));
    expect(read[1]).toBe(lower);
  });

  test("returns the GitLab default template", async () => {
    const p = path.join("/repo", ".gitlab/merge_request_templates/Default.md");
    expect(await findPrTemplate("/repo", "gitlab", deps({ [p]: "MR body" }))).toBe("MR body");
  });

  test("returns null when no template exists", async () => {
    expect(await findPrTemplate("/repo", "github", deps({}))).toBeNull();
  });
});
