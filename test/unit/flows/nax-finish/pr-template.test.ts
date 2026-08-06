/**
 * Ported repository PR/MR template lookup (#1478).
 *
 * The candidate paths are an external convention set by GitHub and GitLab, so
 * this asserts the priority order explicitly — a reordering is a behaviour change.
 */
import { describe, expect, test } from "bun:test";
import { findPrTemplate } from "@flows/nax-finish/pr-template";

const depsFor = (files: Record<string, string>) => ({
  readText: async (path: string): Promise<string | null> => files[path] ?? null,
});

describe("findPrTemplate", () => {
  test("returns the GitHub template verbatim", async () => {
    const deps = depsFor({ "/repo/.github/PULL_REQUEST_TEMPLATE.md": "## Checklist\n- [ ] tests" });
    expect(await findPrTemplate("/repo", "github", deps)).toBe("## Checklist\n- [ ] tests");
  });

  test("prefers .github/PULL_REQUEST_TEMPLATE.md over the lowercase sibling", async () => {
    const deps = depsFor({
      "/repo/.github/PULL_REQUEST_TEMPLATE.md": "upper",
      "/repo/.github/pull_request_template.md": "lower",
    });
    expect(await findPrTemplate("/repo", "github", deps)).toBe("upper");
  });

  test("falls through the full GitHub candidate list in order", async () => {
    const deps = depsFor({ "/repo/docs/PULL_REQUEST_TEMPLATE.md": "docs one" });
    expect(await findPrTemplate("/repo", "github", deps)).toBe("docs one");
  });

  test("resolves the GitLab default merge-request template", async () => {
    const deps = depsFor({ "/repo/.gitlab/merge_request_templates/Default.md": "mr body" });
    expect(await findPrTemplate("/repo", "gitlab", deps)).toBe("mr body");
  });

  test("does not read GitHub paths when the forge is GitLab", async () => {
    const deps = depsFor({ "/repo/.github/PULL_REQUEST_TEMPLATE.md": "gh only" });
    expect(await findPrTemplate("/repo", "gitlab", deps)).toBeNull();
  });

  test("returns null when no template exists — the common case", async () => {
    expect(await findPrTemplate("/repo", "github", depsFor({}))).toBeNull();
  });
});
