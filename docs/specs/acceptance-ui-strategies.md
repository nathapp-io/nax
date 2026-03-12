# Acceptance Test Strategies — UI & Non-Backend Projects

**Status:** Draft
**Author:** Nax Dev
**Date:** 2026-03-12
**Parent:** [`acceptance-pipeline.md`](acceptance-pipeline.md) (v0.40.0)

---

## Problem

v0.40.0 acceptance pipeline assumes backend/library code where acceptance tests `import` a module and assert on return values. This breaks for:

1. **TUI apps** (Ink, blessed, prompts) — output is a rendered terminal frame, not a function return
2. **Web apps** (React, Vue, Svelte, Next.js) — output is DOM, not importable values
3. **CLI tools** — output is stdout/stderr from a process, not a function call
4. **Static sites / CSS-heavy projects** — visual output, no programmatic API

The acceptance test *generator* currently produces one pattern:

```ts
import { myFunction } from "../src/module";
expect(myFunction()).toContain("expected");
```

This doesn't work when the feature is "the dashboard shows a loading spinner" or "the CLI prints a help message".

## Solution

Introduce **test strategies** — the generator picks a different test pattern based on how the feature should be verified.

### Test Strategies

| Strategy | When to use | Test pattern | Example |
|:---------|:-----------|:-------------|:--------|
| `unit` | Backend logic, libraries, utilities | Import + call + assert | `expect(add(1,2)).toBe(3)` |
| `component` | UI components (TUI or web) | Render + assert on output | `render(<Button />)` → assert text |
| `cli` | CLI tools, scripts | Spawn process + assert stdout | `exec("mycli --help")` → assert output |
| `e2e` | Full app flows (web) | Browser automation + assert | Playwright `page.goto()` → assert |
| `snapshot` | Visual output, complex rendering | Render + snapshot match | `expect(output).toMatchSnapshot()` |

### Strategy Selection

Strategy is determined in order of precedence:

1. **Explicit in PRD** — author specifies per-criterion or feature-wide
2. **Auto-detected from stack** — `nax init` already detects stack (bun/node/react/ink)
3. **Fallback** — `unit` (current behavior, backward compatible)

#### PRD Schema Extension

Feature-wide default:
```json
{
  "acceptance": {
    "testStrategy": "component",
    "testFramework": "ink-testing-library"
  }
}
```

Per-criterion override:
```json
{
  "acceptanceCriteria": [
    {
      "criterion": "Dashboard renders user count",
      "testStrategy": "component"
    },
    {
      "criterion": "fetchUsers returns array of User objects",
      "testStrategy": "unit"
    }
  ]
}
```

#### Auto-Detection Rules

| Detected stack | Default strategy | Default framework |
|:---------------|:----------------|:-----------------|
| `bun` / `node` | `unit` | `bun:test` |
| `ink` (detected via `ink` in deps) | `component` | `ink-testing-library` |
| `react` / `next` / `vue` / `svelte` | `component` | `@testing-library/react` (or framework equivalent) |
| Binary/CLI project (has `bin` in package.json) | `cli` | `bun:test` + `Bun.spawn` |

Detection already happens in `src/cli/init-detect.ts` — extend `StackInfo` with UI framework detection.

### Generator Templates

Each strategy uses a different test template. The refinement LLM receives the strategy as context so it produces appropriate assertions.

#### `unit` (existing — no change)

```ts
import { describe, test, expect } from "bun:test";
import { myFunction } from "../src/module";

describe("Acceptance: Feature Name", () => {
  test("AC-1: criterion text", () => {
    const result = myFunction();
    expect(result).toContain("expected");
  });
});
```

#### `component` — Ink (TUI)

```ts
import { describe, test, expect } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { Dashboard } from "../src/components/Dashboard";

describe("Acceptance: Feature Name", () => {
  test("AC-1: Dashboard shows user count", () => {
    const { lastFrame } = render(<Dashboard users={mockUsers} />);
    expect(lastFrame()).toContain("3 users");
  });
});
```

#### `component` — React (Web)

```ts
import { describe, test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Dashboard } from "../src/components/Dashboard";

describe("Acceptance: Feature Name", () => {
  test("AC-1: Dashboard shows user count", () => {
    render(<Dashboard users={mockUsers} />);
    expect(screen.getByText("3 users")).toBeTruthy();
  });
});
```

#### `cli`

```ts
import { describe, test, expect } from "bun:test";

describe("Acceptance: Feature Name", () => {
  test("AC-1: --help prints usage", async () => {
    const proc = Bun.spawn(["bun", "run", "src/index.ts", "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(stdout).toContain("Usage:");
  });
});
```

#### `e2e` (Playwright)

```ts
import { describe, test, expect } from "bun:test";

describe("Acceptance: Feature Name", () => {
  test("AC-1: Login page renders form", async () => {
    // Note: requires running dev server — started in beforeAll
    const response = await fetch("http://localhost:3000/login");
    const html = await response.text();
    expect(html).toContain('<form');
    expect(html).toContain('type="password"');
  });
});
```

> **Note:** Full Playwright integration (browser automation) is deferred. v0.40.1 uses HTTP fetch for basic web E2E. A future version can add Playwright when needed.

#### `snapshot`

```ts
import { describe, test, expect } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import { StatusBar } from "../src/components/StatusBar";

describe("Acceptance: Feature Name", () => {
  test("AC-1: Status bar renders correctly", () => {
    const { lastFrame } = render(<StatusBar status="running" />);
    expect(lastFrame()).toMatchSnapshot();
  });
});
```

### Refinement LLM Changes

The refinement prompt (in `src/acceptance/refinement.ts`) receives additional context:

```
Test strategy: component
Test framework: ink-testing-library
Stack: bun + ink

When refining acceptance criteria, produce assertions that:
- Use render() to mount components
- Assert on lastFrame() text content
- Do NOT assert on function return values (this is a UI project)
```

This ensures the LLM produces refinements compatible with the chosen strategy.

### RED Gate Behavior by Strategy

| Strategy | Valid RED signal |
|:---------|:---------------|
| `unit` | Import error or assertion failure |
| `component` | Import error, render error, or assertion failure |
| `cli` | Process exits with error, or stdout doesn't match |
| `e2e` | Fetch fails (server not running) or HTML doesn't match |
| `snapshot` | Snapshot doesn't exist yet (first run) or mismatch |

All strategies: compile/import failure = valid RED (greenfield).

## Config

Extension to existing acceptance config:

```json
{
  "acceptance": {
    "enabled": true,
    "testStrategy": "component",
    "testFramework": "ink-testing-library",
    "refinement": true,
    "redGate": true
  }
}
```

- `testStrategy`: `"unit"` | `"component"` | `"cli"` | `"e2e"` | `"snapshot"` (default: auto-detect or `"unit"`)
- `testFramework`: framework-specific import (default: auto-detect from stack)

Both are optional — auto-detection fills them if not specified.

## Implementation

### Changes to Existing Code

| File | Change |
|:-----|:-------|
| `src/acceptance/generator.ts` | Accept `testStrategy` + `testFramework`, select template |
| `src/acceptance/refinement.ts` | Include strategy in refinement prompt |
| `src/acceptance/types.ts` | Add `TestStrategy` type, extend `AcceptanceCriterion` |
| `src/cli/init-detect.ts` | Detect UI frameworks (ink, react, vue, svelte) |
| `src/config/schema.ts` | Add `testStrategy`, `testFramework` to acceptance config |
| `src/pipeline/stages/acceptance-setup.ts` | Pass strategy to generator |
| `src/prd/types.ts` | Add optional `testStrategy` to AC criterion type |

### New Files

| File | Purpose |
|:-----|:-------|
| `src/acceptance/templates/` | Strategy-specific test templates (unit, component, cli, e2e, snapshot) |

### Stories

| ID | Title | Complexity |
|:---|:------|:-----------|
| ACS-001 | Test strategy types + config schema extension | Simple |
| ACS-002 | Stack detection for UI frameworks (extend `init-detect.ts`) | Simple |
| ACS-003 | Generator templates — strategy-aware test generation | Medium |
| ACS-004 | Refinement prompt — strategy-aware LLM context | Simple |
| ACS-005 | Integration test — component strategy end-to-end (Ink project) | Medium |

## Acceptance Criteria

1. `testStrategy: "component"` generates Ink-style render + `lastFrame()` assertions
2. `testStrategy: "cli"` generates `Bun.spawn` + stdout assertions
3. Auto-detection picks `component` for projects with `ink` in dependencies
4. Auto-detection picks `cli` for projects with `bin` in `package.json`
5. Per-criterion `testStrategy` override works (mix unit + component in same feature)
6. Backward compatible — omitting `testStrategy` defaults to `unit` (existing behavior)
7. Refinement LLM receives strategy context and produces appropriate assertions
8. RED gate works for component strategy (render error = valid RED)

## Open Questions

1. **Playwright integration:** Full browser automation deferred. Basic HTTP fetch covers simple web E2E for now. When is Playwright worth the complexity?
2. **Dev server management:** E2E strategy needs a running server. Should nax manage `npm run dev` lifecycle, or require the user to start it? (Lean toward: user starts it, nax documents the requirement)
3. **Snapshot baseline:** Snapshot strategy needs an initial baseline. On first run, all snapshots fail (no baseline) — is that a valid RED? (Yes — same as compile failure for greenfield)
