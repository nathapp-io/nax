/**
 * nax#2072 (ruling C) — read-time reframing of a fragment's `## Files touched`.
 *
 * A fragment records repo-rooted paths. The story consuming it has its file
 * tools contained at its own package dir, so an entry is either re-spelled
 * package-relative (readable) or marked as lying outside that root.
 *
 * Pure function, no I/O — no deps injection needed.
 */

import { describe, expect, test } from "bun:test";
import { reframeFilesTouched } from "@/context/fragments";

/** Mirrors `renderFragmentBody` (src/context/fragments/store.ts:201). */
function body(files: readonly string[]): string {
  const filesLines = files.map((f) => `- ${f}`).join("\n");
  return `# US-001 — Add isBlank\n\n## Files touched\n${filesLines}\n\n## Acceptance criteria\n- isBlank("") is true\n`;
}

describe("reframeFilesTouched (nax#2072)", () => {
  test("returns the body byte-identically when the consumer has no workdir", () => {
    const input = body(["packages/lib/src/util.ts"]);

    expect(reframeFilesTouched(input, undefined)).toBe(input);
    expect(reframeFilesTouched(input, "")).toBe(input);
    expect(reframeFilesTouched(input, ".")).toBe(input);
  });

  test("re-spells an in-package entry relative to the consumer's package", () => {
    const out = reframeFilesTouched(body(["packages/app/src/index.ts"]), "packages/app");

    expect(out).toContain("- src/index.ts");
    expect(out).not.toContain("packages/app/src/index.ts");
  });

  test("keeps a cross-package entry repo-rooted and marks it unreadable", () => {
    const out = reframeFilesTouched(body(["packages/lib/src/util.ts"]), "packages/app");

    expect(out).toContain("- packages/lib/src/util.ts (other package - not readable from this story's workdir)");
  });

  test("handles a mixed list, one entry per line", () => {
    const out = reframeFilesTouched(body(["packages/lib/src/util.ts", "packages/app/src/index.ts"]), "packages/app");

    expect(out).toContain("- packages/lib/src/util.ts (other package - not readable from this story's workdir)");
    expect(out).toContain("- src/index.ts");
  });

  test("marks a sibling package whose name merely prefixes the consumer's", () => {
    // `packages/application` must NOT be treated as inside `packages/app`.
    // A raw startsWith would emit the corrupt path "lication/src/x.ts".
    const out = reframeFilesTouched(body(["packages/application/src/x.ts"]), "packages/app");

    expect(out).toContain("- packages/application/src/x.ts (other package - not readable from this story's workdir)");
    expect(out).not.toContain("- lication/src/x.ts (other");
  });

  test("leaves the acceptance-criteria section untouched", () => {
    const out = reframeFilesTouched(body(["packages/lib/src/util.ts"]), "packages/app");

    expect(out).toContain('- isBlank("") is true');
    expect(out).not.toContain('isBlank("") is true (other package');
  });

  test("returns the body unchanged when there is no Files touched section", () => {
    const input = "# US-001 — Add isBlank\n\n## Acceptance criteria\n- packages/lib/src/util.ts is covered\n";

    expect(reframeFilesTouched(input, "packages/app")).toBe(input);
  });

  test("tolerates a body truncated mid-section", () => {
    const input = "# US-001 — Add isBlank\n\n## Files touched\n- packages/lib/src/util.ts";

    expect(reframeFilesTouched(input, "packages/app")).toBe(
      "# US-001 — Add isBlank\n\n## Files touched\n- packages/lib/src/util.ts (other package - not readable from this story's workdir)",
    );
  });

  test("normalises a backslash-spelled consumer workdir", () => {
    const out = reframeFilesTouched(body(["packages/app/src/index.ts"]), "packages\\app");

    expect(out).toContain("- src/index.ts");
  });
});
