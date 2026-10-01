/**
 * Real-world PR/MR template corpus for `mergeTemplate`.
 *
 * The merge has to work against templates nax has never seen, so the unit
 * tests assert per-template behaviour *and* sweep the whole corpus for the
 * invariants that hold regardless of shape (no placeholder comments, no
 * dangling issue refs, no empty headings outside strict mode).
 *
 * Kept verbatim — including the trailing-whitespace and blank-line quirks real
 * templates carry — because normalising them here would test a cleaned input
 * the production path never sees.
 */

export interface TemplateFixture {
  /** Stable id, used as the `test.each` label. */
  name: string;
  /** Where this shape comes from, so a future reader knows what it represents. */
  origin: string;
  text: string;
}

/** This repository's own template — the one that produced the #1504 defect. */
const NAX: TemplateFixture = {
  name: "nax",
  origin: ".github/pull_request_template.md in this repo",
  text: `## What

<!-- Brief description of what this PR does -->

## Why

<!-- What problem does this solve? Link to issue if applicable -->

Closes #

## How

<!-- Key implementation details, if non-obvious -->

## Testing

- [ ] Tests added/updated
- [ ] \`bun test\` passes
- [ ] \`bun run typecheck\` passes
- [ ] \`bun run lint\` passes

## Notes

<!-- Anything reviewers should know? Breaking changes? -->
`,
};

/** GitHub's widely-copied community template. */
const GITHUB_COMMUNITY: TemplateFixture = {
  name: "github-community",
  origin: "github/docs community PR template",
  text: `## Description

Please include a summary of the change.

Fixes # (issue)

## Type of change

- [ ] Bug fix
- [ ] New feature

## How Has This Been Tested?

Please describe the tests that you ran.

## Checklist:

- [ ] My code follows the style guidelines of this project
- [ ] I have performed a self-review of my own code
`,
};

/** GitLab's default merge-request description, which leads with prose. */
const GITLAB_DEFAULT: TemplateFixture = {
  name: "gitlab-default",
  origin: ".gitlab/merge_request_templates/Default.md",
  text: `<!-- Set the MR title to describe the change. -->

## What does this MR do and why?

_Describe in detail what your merge request does and why._

## Screenshots or screen recordings

_Screenshots are required for UI changes._

## How to set up and validate locally

_Numbered steps to set up and validate the change._
`,
};

/** Frontmatter carries labels/assignees and must survive untouched. */
const WITH_FRONTMATTER: TemplateFixture = {
  name: "with-frontmatter",
  origin: "template that presets labels via YAML frontmatter",
  text: `---
name: Standard change
labels: ["needs-review", "team/platform"]
assignees: octocat
---

## Summary

<!-- one paragraph -->

## Test plan

<!-- how did you verify this? -->
`,
};

/** No H2 anywhere — the merge must not try to place sections into it. */
const PROSE_ONLY: TemplateFixture = {
  name: "prose-only",
  origin: "minimal repos that use a single prompt line",
  text: `Thanks for contributing! Please describe your change and link any related
issue below. Remember to run the test suite before requesting review.
`,
};

/** Headings deeper than H2 only — same unparseable-shape path as prose-only. */
const H3_ONLY: TemplateFixture = {
  name: "h3-only",
  origin: "templates that nest everything under a single H1",
  text: `# Pull request

### What changed

<!-- describe -->

### Testing

<!-- describe -->
`,
};

export const TEMPLATE_FIXTURES: TemplateFixture[] = [
  NAX,
  GITHUB_COMMUNITY,
  GITLAB_DEFAULT,
  WITH_FRONTMATTER,
  PROSE_ONLY,
  H3_ONLY,
];

/** The two fixtures with no H2, which fall back to the nax-only body. */
export const UNPARSEABLE_FIXTURE_NAMES = ["prose-only", "h3-only"];

export const TEMPLATE_BY_NAME: Record<string, string> = Object.fromEntries(
  TEMPLATE_FIXTURES.map((f) => [f.name, f.text]),
);
