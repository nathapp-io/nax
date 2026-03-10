# Prompt Customization Guide

## Overview

The **nax prompt system** allows you to customize the instructions sent to AI agents for each role in your development workflow. By default, nax uses proven prompts optimized for different tasks (writing tests, implementing code, reviewing quality). If these don't fit your project's needs—whether for coding style, documentation preferences, or domain-specific conventions—you can override them with custom templates.

**Why customize?**
- Enforce project-specific coding patterns
- Adapt agent behavior to your tech stack
- Include domain knowledge or architectural constraints
- Test alternative prompt strategies and measure impact

---

## Roles Reference

nax orchestrates your work across 5 specialized roles. Each role has a distinct task and receives a tailored prompt:

| Role | Sessions | Task | When Invoked |
|:-----|:--------:|:-----|:------------|
| **test-writer** | 1 of 3 | Write comprehensive failing tests for the feature (RED phase) | During three-session TDD for complex/security stories |
| **implementer** | 1 of 3 | Make failing tests pass by implementing source code | After test-writer completes; skipped if single-session strategy is used |
| **verifier** | 1 of 3 | Review implementation quality and verify acceptance criteria | After implementer completes; skipped if single-session strategy is used |
| **single-session** | 1 of 1 | Write tests AND implement the feature in one focused session | For simple/medium stories without strict role isolation |
| **tdd-simple** | 1 of 1 | Write failing tests FIRST, then implement in one session (RED→GREEN→REFACTOR) | For simple stories using TDD discipline |

**Test Strategies:**
- **test-after** (1 session): For refactors, deletions, docs. No role specified.
- **tdd-simple** (1 session): Enforces TDD discipline in a single session.
- **single-session** (1 session): Write tests + implement; no strict isolation.
- **three-session-tdd** (3 sessions): Strict file isolation: test-writer → implementer → verifier.
- **three-session-tdd-lite** (3 sessions): Relaxed isolation: test-writer → implementer → verifier.

---

## Quick Start

### Step 1: Create Templates

Initialize templates in your project:

```bash
nax prompts --init
```

This creates `nax/templates/` with 5 default template files:

```
nax/templates/
├── test-writer.md
├── implementer.md
├── verifier.md
├── single-session.md
└── tdd-simple.md
```

Each template contains the default prompt body for that role, prefixed with a comment block explaining what can and cannot be overridden.

### Step 2: Edit Templates (Optional)

Edit any template to customize the instructions. For example, to enforce a specific test style:

```bash
# Edit implementer instructions
nano nax/templates/implementer.md
```

Modify the content under the comment block. The header (non-overridable sections list) must remain at the top for reference.

### Step 3: Activate Overrides

Add the override paths to your `nax/config.json`:

```json
{
  "prompts": {
    "overrides": {
      "test-writer": "nax/templates/test-writer.md",
      "implementer": "nax/templates/implementer.md",
      "verifier": "nax/templates/verifier.md",
      "single-session": "nax/templates/single-session.md",
      "tdd-simple": "nax/templates/tdd-simple.md"
    }
  }
}
```

If you ran `nax prompts --init` with an existing `nax/config.json`, this is done automatically.

### Step 4: Test & Run

Before a full run, preview the prompt for a single role:

```bash
# View what the test-writer will receive
nax prompts --export test-writer | head -50

# View for a specific feature's story
nax prompts -f my-feature --story US-001
```

Once satisfied, run normally:

```bash
nax run -f my-feature
```

---

## Exporting Default Prompts

Use `nax prompts --export <role>` to see the default prompt template for any role. This is useful for:
- Comparing your overrides against defaults
- Using as a starting point for customization
- Debugging why an agent behaved differently

**Syntax:**

```bash
nax prompts --export <role> [--out <file>]
```

**Roles:** `test-writer`, `implementer`, `verifier`, `single-session`, `tdd-simple`

**Examples:**

```bash
# Print default implementer prompt to stdout
nax prompts --export implementer

# Save default test-writer prompt to a file
nax prompts --export test-writer --out /tmp/test-writer-default.md

# Compare your override with the default
diff nax/templates/implementer.md <(nax prompts --export implementer)
```

---

## What Can and Cannot Be Overridden

### ✅ Overridable Sections

The **role-body** section (the main task instructions) can be customized:

```markdown
# Role: [Your Custom Role Title]

Your task: [Custom task description]

Instructions:
- [Custom instruction 1]
- [Custom instruction 2]
- ...
```

### ❌ Non-Overridable Sections

These sections are **always injected by nax** and cannot be changed in templates:

1. **Constitution** — Project coding standards, conventions, and safety rules (e.g., immutability, error handling)
   - *Why?* Ensures all agents follow your project's core principles

2. **Story Context** — The user story details (title, description, acceptance criteria, dependencies)
   - *Why?* Critical for agents to understand the work; must be consistent across all roles

3. **Isolation Rules** — File access boundaries for three-session TDD (which files each role can modify)
   - *Why?* Enforces role separation; if roles could override this, isolation would break down

4. **Conventions Footer** — Final reminders of project patterns, testing strategies, and commit format
   - *Why?* Reinforces critical project practices at the prompt's end

### Example Template Structure

```markdown
<!--
  This file controls the role-body section of the nax prompt for this role.
  Edit the content below to customize the task instructions given to the agent.

  NON-OVERRIDABLE SECTIONS (always injected by nax, cannot be changed here):
    - Isolation rules (scope, file access boundaries)
    - Story context (acceptance criteria, description, dependencies)
    - Conventions (project coding standards)

  To activate overrides, add to your nax/config.json:
    { "prompts": { "overrides": { "<role>": "nax/templates/<role>.md" } } }
-->

# Role: Custom Implementer

Your task: make failing tests pass with a focus on performance.

Instructions:
- Prioritize algorithmic efficiency over convenience
- Avoid nested loops where possible
- ...
```

---

## Config Reference

### `prompts.overrides` Key

Define custom prompt paths in your project config:

**Location:** `nax/config.json` (project-level) or `~/.nax/config.json` (global)

**Schema:**

```json
{
  "prompts": {
    "overrides": {
      "test-writer": "nax/templates/test-writer.md",
      "implementer": "nax/templates/implementer.md",
      "verifier": "nax/templates/verifier.md",
      "single-session": "nax/templates/single-session.md",
      "tdd-simple": "nax/templates/tdd-simple.md"
    }
  }
}
```

**Behavior:**
- If a role's path is specified, nax reads that file as the role-body section
- If a file doesn't exist, nax logs a warning and falls back to the default template
- If `prompts.overrides` is not set, nax uses defaults for all roles
- Project-level overrides take precedence over global overrides

**Example: Override Only One Role**

If you only want to customize the `implementer` role:

```json
{
  "prompts": {
    "overrides": {
      "implementer": "nax/templates/implementer-custom.md"
    }
  }
}
```

nax will use your custom implementer prompt and defaults for all other roles.

---

## Tips

### Keep Overrides Focused

Effective customizations target a specific concern:

**Good examples:**
- "Emphasize security best practices" (for a security-critical project)
- "Always prefer immutability and functional patterns" (for a functional programming style guide)
- "Include JSDoc comments for all exported functions" (for documentation standards)

**Avoid:**
- Trying to make an agent "smarter" or more creative—agents follow instructions well; the defaults are proven
- Over-engineering—small, focused overrides are easier to test and debug

### Test Before a Full Run

Use `nax prompts` to preview the assembled prompt before running against real stories:

```bash
# Preview a feature's prompt with your overrides applied
nax prompts -f my-feature --story US-001

# Or check all stories
nax prompts -f my-feature
```

Compare the output against what you expect. If something looks wrong, adjust the template and test again.

### Measure Impact

After running with custom prompts, check:
- **Story pass rate:** Did your override help or hurt?
- **Code quality:** Are tests more thorough? Is implementation cleaner?
- **Cost:** Did iteration count or token usage change?

If a customization doesn't help, revert it:

```bash
# Remove overrides from config
# nax will fall back to defaults
rm nax/templates/<role>.md
```

Or reset all templates:

```bash
nax prompts --init --force
```

### Global Overrides

For conventions shared across all projects, use `~/.nax/config.json`:

```json
{
  "prompts": {
    "overrides": {
      "test-writer": "~/.nax/templates/test-writer-global.md",
      "implementer": "~/.nax/templates/implementer-global.md"
    }
  }
}
```

Project-level overrides take precedence.

---

## Troubleshooting

**"No prompt generated for story"**
- Check that template files exist and are readable
- Verify `prompts.overrides` paths are correct (relative to project root)
- Use `nax prompts -f <feature> --story <id>` to see the exact error

**"Override path doesn't exist"**
- nax logs a warning and falls back to the default
- Check the file exists and path is relative to your project root (or absolute)

**"Prompts look the same despite override"**
- Ensure `nax/config.json` has the override path configured
- Run `nax config --explain` to see the effective merged config
- Templates must be in `nax/templates/` or a custom path, not in `src/` or `docs/`

---

## See Also

- [Test Strategies](README.md#test-strategies) — How nax selects a test strategy per story
- [Three-Session TDD](README.md#three-session-tdd) — Role separation and isolation rules
- [Configuration Reference](README.md#configuration) — All nax config options
