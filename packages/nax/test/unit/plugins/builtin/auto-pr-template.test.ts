/**
 * Auto-PR Plugin — Template Discovery Tests
 *
 * Tests for findPrTemplate pure function (fs reads are dependency-injected).
 * Mirrors acceptance criteria US-002 §Template discovery.
 */

import { describe, expect, test } from "bun:test";
import { type ForgeDeps as AutoPrDeps, findPrTemplate } from "@/forge";

function makeDeps(files: Record<string, string>): AutoPrDeps {
  return {
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    readText: async (path: string) => {
      // support the test passing either bare names or full paths
      const candidates = Object.keys(files);
      for (const key of candidates) {
        if (path === key || path.endsWith(key)) {
          return files[key] ?? null;
        }
      }
      return null;
    },
  };
}

describe("findPrTemplate (github)", () => {
  test("AC7 — returns .github/pull_request_template.md contents when that path resolves", async () => {
    const template = "## Pull request\n- [ ] tests\n- [ ] docs";
    const deps = makeDeps({
      ".github/pull_request_template.md": template,
    });

    const result = await findPrTemplate("/workdir", "github", deps);
    expect(result).toBe(template);
  });

  test("AC8 — prefers .github/PULL_REQUEST_TEMPLATE.md over docs/PULL_REQUEST_TEMPLATE.md", async () => {
    const primary = "## Primary template\n- [ ] a";
    const secondary = "## Secondary template\n- [ ] b";
    const deps = makeDeps({
      ".github/PULL_REQUEST_TEMPLATE.md": primary,
      "docs/PULL_REQUEST_TEMPLATE.md": secondary,
    });

    const result = await findPrTemplate("/workdir", "github", deps);
    expect(result).toBe(primary);
  });

  test("AC10 — returns null when no template path resolves", async () => {
    const deps = makeDeps({});

    const result = await findPrTemplate("/workdir", "github", deps);
    expect(result).toBeNull();
  });

  test("falls back to PULL_REQUEST_TEMPLATE.md and docs/PULL_REQUEST_TEMPLATE.md in priority order", async () => {
    const fallback = "## Plain root template\n- [ ] x";
    const deps = makeDeps({
      "PULL_REQUEST_TEMPLATE.md": fallback,
      "docs/PULL_REQUEST_TEMPLATE.md": "## Docs template",
    });

    const result = await findPrTemplate("/workdir", "github", deps);
    expect(result).toBe(fallback);
  });

  test("uses the last-resort docs/PULL_REQUEST_TEMPLATE.md when nothing else matches", async () => {
    const fallback = "## Docs-only template";
    const deps = makeDeps({
      "docs/PULL_REQUEST_TEMPLATE.md": fallback,
    });

    const result = await findPrTemplate("/workdir", "github", deps);
    expect(result).toBe(fallback);
  });
});

describe("findPrTemplate (gitlab)", () => {
  test("AC9 — returns .gitlab/merge_request_templates/Default.md contents when present", async () => {
    const template = "## MR checklist\n- [ ] tests\n- [ ] review";
    const deps = makeDeps({
      ".gitlab/merge_request_templates/Default.md": template,
    });

    const result = await findPrTemplate("/workdir", "gitlab", deps);
    expect(result).toBe(template);
  });

  test("returns null when no GitLab template path resolves", async () => {
    const deps = makeDeps({});

    const result = await findPrTemplate("/workdir", "gitlab", deps);
    expect(result).toBeNull();
  });
});
