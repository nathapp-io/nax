---
title: PRD Format
description: The prd.json schema
---

## PRD Format

User stories are defined in `nax/features/<name>/prd.json`:

```json
{
  "feature": "user-auth",
  "userStories": [
    {
      "id": "US-001",
      "title": "Add login endpoint",
      "description": "POST /auth/login with email/password",
      "acceptanceCriteria": [
        "Returns JWT on success",
        "Returns 401 on invalid credentials"
      ],
      "complexity": "medium",
      "tags": ["auth", "security"],
      "status": "pending"
    }
  ]
}
```

> **Note:** Use `"status": "passed"` (not `"done"`) to manually mark a story complete.

---

### Field Reference

| Field | Type | Required | Description |
|:------|:-----|:--------|:------------|
| `feature` | `string` | Yes | Feature name (should match folder name) |
| `userStories` | `array` | Yes | Array of user story objects |
| `id` | `string` | Yes | Unique story identifier (e.g., "US-001") |
| `title` | `string` | Yes | Short story title |
| `description` | `string` | No | Detailed description of the story |
| `acceptanceCriteria` | `array` | Yes | List of criteria that must be met |
| `complexity` | `string` | No | Complexity level: `simple`, `medium`, `complex`, `expert` |
| `tags` | `array` | No | Tags for routing strategy selection |
| `status` | `string` | Yes | Story status: `pending`, `passed`, `failed` |
| `workdir` | `string` | No | Override working directory for monorepos |
| `dependencies` | `array` | No | Array of story IDs this story depends on |

[Back to README](../README.md)
