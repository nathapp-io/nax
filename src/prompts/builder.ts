/**
 * PromptBuilder — unified entry point for composing agent prompts.
 *
 * Composes prompts from ordered sections:
 *   (1) Constitution
 *   (2) Role task body (user override OR default template)
 *   (3) Story context          [non-overridable]
 *   (4) Isolation rules        [non-overridable]
 *   (5) Context markdown
 *   (6) Conventions footer     [non-overridable, always last]
 */

import type { NaxConfig } from "../config/types";
import type { UserStory } from "../prd";
import type { PromptOptions, PromptRole } from "./types";

const SECTION_SEP = "\n\n---\n\n";

export class PromptBuilder {
  private _role: PromptRole;
  private _options: PromptOptions;
  private _story: UserStory | undefined;
  private _contextMd: string | undefined;
  private _constitution: string | undefined;
  private _overridePath: string | undefined;
  private _workdir: string | undefined;
  private _loaderConfig: NaxConfig | undefined;

  private constructor(role: PromptRole, options: PromptOptions = {}) {
    this._role = role;
    this._options = options;
  }

  static for(role: PromptRole, options?: PromptOptions): PromptBuilder {
    return new PromptBuilder(role, options ?? {});
  }

  story(story: UserStory): PromptBuilder {
    this._story = story;
    return this;
  }

  context(md: string | undefined): PromptBuilder {
    if (md) this._contextMd = md;
    return this;
  }

  constitution(c: string | undefined): PromptBuilder {
    if (c) this._constitution = c;
    return this;
  }

  override(path: string): PromptBuilder {
    this._overridePath = path;
    return this;
  }

  withLoader(workdir: string, config: NaxConfig): PromptBuilder {
    this._workdir = workdir;
    this._loaderConfig = config;
    return this;
  }

  async build(): Promise<string> {
    const sections: string[] = [];

    // (1) Constitution
    if (this._constitution) {
      sections.push(`# CONSTITUTION (follow these rules strictly)\n\n${this._constitution}`);
    }

    // (2) Role task body — user override or default template
    sections.push(await this._resolveRoleBody());

    // (3) Story context — non-overridable
    if (this._story) {
      sections.push(buildStoryContext(this._story));
    }

    // (4) Isolation rules — non-overridable
    sections.push(buildIsolationRules(this._role, this._options));

    // (5) Context markdown
    if (this._contextMd) {
      sections.push(this._contextMd);
    }

    // (6) Conventions footer — non-overridable, always last
    sections.push(CONVENTIONS_FOOTER);

    return sections.join(SECTION_SEP);
  }

  private async _resolveRoleBody(): Promise<string> {
    // withLoader takes priority over explicit override path
    if (this._workdir && this._loaderConfig) {
      const { loadOverride } = await import("./loader");
      const content = await loadOverride(this._role, this._workdir, this._loaderConfig);
      if (content !== null) {
        return content;
      }
    }
    if (this._overridePath) {
      try {
        const file = Bun.file(this._overridePath);
        if (await file.exists()) {
          return await file.text();
        }
      } catch {
        // fall through to default template
      }
    }
    return buildDefaultRoleBody(this._role, this._story?.title, this._options);
  }
}

// ---------------------------------------------------------------------------
// Section builders (module-private)
// ---------------------------------------------------------------------------

function buildDefaultRoleBody(role: PromptRole, title = "", options: PromptOptions = {}): string {
  const variant = options.variant as string | undefined;
  switch (role) {
    case "test-writer":
      return `# Test Writer — "${title}"\n\nYour role: Write failing tests ONLY. Do NOT implement any source code.`;
    case "implementer":
      if (variant === "lite") {
        return `# Implementer (Lite) — "${title}"\n\nYour role: Write tests AND implement the feature in a single session.`;
      }
      return `# Implementer — "${title}"\n\nYour role: Make all failing tests pass.`;
    case "verifier":
      return `# Verifier — "${title}"\n\nYour role: Verify the implementation and tests.`;
    case "single-session":
      return `# Task — "${title}"\n\nYour role: Write tests AND implement the feature in a single session.`;
  }
}

function buildStoryContext(story: UserStory): string {
  return `# Story Context

**Story:** ${story.title}

**Description:**
${story.description}

**Acceptance Criteria:**
${story.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`;
}

const TEST_FILTER_RULE =
  "When running tests, run ONLY test files related to your changes" +
  " (e.g. `bun test ./test/specific.test.ts`). NEVER run `bun test` without a file filter" +
  " — full suite output will flood your context window and cause failures.";

function buildIsolationRules(role: PromptRole, options: PromptOptions = {}): string {
  const header = "# Isolation Rules\n\n";
  const footer = `\n\n${TEST_FILTER_RULE}`;
  const isolation = options.isolation as string | undefined;

  switch (role) {
    case "test-writer":
      if (isolation === "lite") {
        return `${header}isolation scope: Primarily create test files in the test/ directory. You MAY read source files and MAY import from source files to ensure correct types/interfaces. Stub-only src/ files are allowed (empty exports, no logic). Tests must fail for the right reasons (feature not implemented).${footer}`;
      }
      return `${header}isolation scope: Only create or modify files in the test/ directory. Tests must fail because the feature is not yet implemented. Do NOT modify any source files in src/.${footer}`;
    case "implementer":
      return `${header}isolation scope: Implement source code in src/ to make the tests pass. Do NOT modify test files. Run tests frequently to track progress.${footer}`;
    case "verifier":
      return `${header}isolation scope: Verify and fix only — do not change behaviour unless it violates acceptance criteria. Ensure all tests pass and all criteria are met.${footer}`;
    case "single-session":
      return `${header}isolation scope: Write tests first (test/ directory), then implement (src/ directory). All tests must pass by the end.${footer}`;
  }
}

const CONVENTIONS_FOOTER =
  "# Conventions\n\n" +
  "Follow existing code patterns and conventions. Write idiomatic, maintainable code." +
  " Commit your changes when done.";
