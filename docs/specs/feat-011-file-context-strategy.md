# FEAT-011 — File Context Strategy

**Status:** Proposal
**Target:** v0.21.0
**Author:** Nax Dev
**Date:** 2026-03-06

---

## 1. Problem

nax injects full file content into agent prompts for all relevant source files. For large files (500+ lines), this bloats the context window — increasing cost and reducing focus. The agent has tool access to read files directly, making full content injection for large files redundant.

---

## 2. Proposed Config

```jsonc
{
  "context": {
    "fileContext": {
      "strategy": "auto",      // "auto" | "full" | "path-only"
      "maxInlineLines": 500,   // threshold for "auto" mode
      "previewLines": 20       // lines shown in path-only / large-file preview
    }
  }
}
```

---

## 3. Injection Logic

| Strategy | Condition | Agent receives |
|---|---|---|
| `"full"` | always | Complete file content |
| `"path-only"` | always | Relative path + line count only |
| `"auto"` | file ≤ `maxInlineLines` | Complete file content |
| `"auto"` | file > `maxInlineLines` | Path + line count + first `previewLines` lines |

**Large file preview format:**
```
// src/execution/sequential-executor.ts (847 lines — use Read tool for full content)
import { ... } from "...";
// first 20 lines...
```

---

## 4. Files Affected

| File | Change |
|---|---|
| `src/config/schemas.ts` | Add `context.fileContext` schema |
| `src/config/types.ts` | Add `FileContextConfig` interface |
| `src/context/builder.ts` | Apply strategy when injecting file content |
| `src/context/providers/` | Update providers that inject raw file content |

---

## 5. Cost Impact

Primary benefit is **quality** (more focused context), not raw cost savings. Rough estimate for a typical 5-story run: ~3000 tokens saved if avg file is 800 lines. At sonnet pricing: <$0.01 per run — marginal, but compounds.

---

## 6. Test Plan

- `strategy: "full"` → always full content regardless of line count
- `strategy: "path-only"` → always path + count only
- `strategy: "auto"`, 300-line file → full content
- `strategy: "auto"`, 600-line file → path + 20-line preview
- Default: `"auto"` with `maxInlineLines: 500`
