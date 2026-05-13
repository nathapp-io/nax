import type { FactsManifest } from "@/debate/facts-manifest";
import type { PRD, UserStory } from "@/prd";
import type { ComposeInput } from "../compose";

/** Number of manifest claims/gaps to include verbatim. 0 = include all. */
const MANIFEST_ITEMS_INCLUDED = 0; // raised from previous slice(0, 5)

/** Optional per-story serialization cap to keep prompts bounded on large PRDs. */
const MAX_STORIES_SERIALIZED = 50;

/** Per-AC truncation cap (avoids runaway PRD bloat in the prompt). */
const MAX_AC_CHARS = 600;

/**
 * CriticPromptBuilder — LLM audit for plan ac-testability and failure-mode coverage
 *
 * Generates prompts for the plan-critic LLM to assess:
 * 1. ac-testable: Is each AC assertion observable (file/symbol/test reference)?
 * 2. failure-modes-considered: Does the plan have negative-path coverage?
 * 3. failure-table-enumerated: For each row in the spec's Failure-handling table,
 *    is there a matching AC? (Only fires when specContent contains a failure table.)
 * 4. description-ac-contradiction: Does any story's description contradict its own ACs?
 */
export class CriticPromptBuilder {
  build(prd: PRD, manifest: FactsManifest, specContent = ""): ComposeInput {
    const role: ComposeInput["role"] = {
      id: "role",
      content:
        "You are a plan critic. Your task is to audit acceptance criteria for testability, failure-mode coverage, and internal consistency. The full PRD and the source spec are provided — you must read them, not guess.",
      overridable: false,
    };

    const taskContent = this.buildTaskContent(prd, manifest, specContent);

    const task: ComposeInput["task"] = {
      id: "task",
      content: taskContent,
      overridable: false,
    };

    return { role, task };
  }

  private buildTaskContent(prd: PRD, manifest: FactsManifest, specContent: string): string {
    const lines: string[] = [];

    lines.push("## Plan Audit");
    lines.push("");
    lines.push(`Feature: ${prd.feature}`);
    lines.push("");

    // ─── PRD content ──────────────────────────────────────────────────────
    // Critic ran in a fresh session — without the PRD inline it can't audit
    // ACs it never sees. Serialize stories + ACs + descriptions explicitly.
    lines.push("### Plan Under Audit");
    lines.push("");
    const stories = (prd.userStories ?? []).slice(0, MAX_STORIES_SERIALIZED);
    if (stories.length === 0) {
      lines.push("_(plan has no user stories — emit a blocker finding)_");
    } else {
      for (const story of stories) {
        lines.push(serializeStoryForAudit(story));
        lines.push("");
      }
    }

    // ─── Spec excerpt (failure-handling enumeration depends on this) ──────
    // Not wrapped in a code fence — specs frequently contain their own ``` blocks,
    // which would prematurely close any fence we wrapped them in.
    if (specContent.trim().length > 0) {
      lines.push("### Source Spec");
      lines.push("");
      lines.push("<spec>");
      lines.push(specContent.trim());
      lines.push("</spec>");
      lines.push("");
    }

    // ─── Audit checklist ──────────────────────────────────────────────────
    lines.push("### Audit Checklist");
    lines.push("");

    lines.push("#### ac-testable");
    lines.push("For each acceptance criterion in every story above:");
    lines.push(
      "- Is the assertion observable (function return, raised exception, log content, file content, state change)?",
    );
    lines.push("- Emit a finding if testability is unclear or missing concrete anchor.");
    lines.push("");

    lines.push("#### failure-modes-considered");
    lines.push("For each story above:");
    lines.push("- Does it have at least one negative-path acceptance criterion?");
    lines.push("- Emit a finding if no error/exception/boundary case is covered.");
    lines.push("");

    if (specContent.trim().length > 0) {
      lines.push("#### failure-table-enumerated");
      lines.push(
        "If the spec contains a Failure-handling / Error-handling / Failure-modes table (rows describing specific error scenarios), walk it row by row.",
      );
      lines.push("- For each row, locate the AC in the matching story that asserts that behaviour.");
      lines.push(
        "- A row without a matching AC is a missing AC. Emit a `blocker` finding naming the missing scenario.",
      );
      lines.push("- Do NOT skip rows because they look minor or boilerplate.");
      lines.push("");
    }

    lines.push("#### description-ac-contradiction");
    lines.push("For each story above:");
    lines.push(
      "- Re-read the description against the story's acceptance criteria. If any sentence in the description contradicts an AC (e.g. description says behaviour X, AC says behaviour not-X), emit a `major` finding identifying both the offending sentence and the AC it contradicts.",
    );
    lines.push(
      "- This includes prose copied verbatim from a spec table whose ACs intentionally override that prose — the AC is authoritative.",
    );
    lines.push("");

    // ─── Manifest context ─────────────────────────────────────────────────
    if (manifest.specClaims && manifest.specClaims.length > 0) {
      lines.push("### Spec Claims (manifest)");
      const claims = sliceOrAll(manifest.specClaims, MANIFEST_ITEMS_INCLUDED);
      for (const claim of claims) {
        lines.push(`- ${claim.id}: ${claim.claim}`);
      }
      lines.push("");
    }

    if (manifest.gaps && manifest.gaps.length > 0) {
      lines.push("### Gaps (manifest)");
      const gaps = sliceOrAll(manifest.gaps, MANIFEST_ITEMS_INCLUDED);
      for (const gap of gaps) {
        lines.push(`- ${gap.id}: ${gap.note}`);
      }
      lines.push("");
    }

    lines.push("## Output Format");
    lines.push("");
    lines.push("Return a JSON object with shape:");
    lines.push("```json");
    lines.push("{");
    lines.push('  "findings": [');
    lines.push(
      '    {"checklistItem": "ac-testable" | "failure-modes-considered" | "failure-table-enumerated" | "description-ac-contradiction", "severity": "blocker" | "major" | "minor", "message": "...", "storyId": "US-001"}',
    );
    lines.push("  ]");
    lines.push("}");
    lines.push("```");
    lines.push("");
    lines.push("Emit an empty `findings` array only if every check passes for every story.");
    lines.push("");

    return lines.join("\n");
  }

  static jsonRepair(isTruncated: boolean, parseError: string): string {
    const reason = isTruncated
      ? `${parseError} (response also appears near output cap and may be truncated)`
      : parseError;
    return `Your previous response was rejected.

Failure reason: ${reason}

Re-write the complete findings JSON from scratch. Requirements:
- Return exactly one JSON object with a "findings" array.
- Each finding has: checklistItem (string), severity ("blocker"|"major"|"minor"), message (string), and optional specId/gapId/storyId.
- Do not include markdown fences or explanation.
- Output ONLY the JSON object.`;
  }

  static schemaRepair(message: string): string {
    return `Your previous response was rejected.

Failure reason: ${message}

The response was valid JSON but did not match the expected schema. Fix the schema issues and re-emit the complete JSON:
- Root must be an object with a "findings" array.
- Each finding must have "checklistItem" and "severity" fields.
- Do not include markdown fences or explanation.
- Output ONLY the JSON object.`;
  }
}

// ─── Helpers (module-private) ────────────────────────────────────────────────

function sliceOrAll<T>(items: readonly T[], limit: number): readonly T[] {
  return limit > 0 ? items.slice(0, limit) : items;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max).trimEnd()}…[truncated]`;
}

/**
 * Serialize a single user story into the audit prompt. Includes id, title, ACs,
 * suggestedCriteria (when present), and the full description. The critic uses
 * this to perform every check; without inline serialization it would be blind.
 */
function serializeStoryForAudit(story: UserStory): string {
  const out: string[] = [];
  out.push(`**${story.id} — ${story.title}**`);
  if (story.description && story.description.trim().length > 0) {
    out.push("");
    out.push("_Description:_");
    out.push(truncate(story.description.trim(), MAX_AC_CHARS * 4));
  }
  const acs = story.acceptanceCriteria ?? [];
  if (acs.length === 0) {
    out.push("");
    out.push("_ACs: (none)_");
  } else {
    out.push("");
    out.push("_ACs:_");
    for (let i = 0; i < acs.length; i++) {
      out.push(`${i + 1}. ${truncate(String(acs[i]), MAX_AC_CHARS)}`);
    }
  }
  const suggested = story.suggestedCriteria;
  if (suggested && suggested.length > 0) {
    out.push("");
    out.push("_suggestedCriteria:_");
    for (const sc of suggested) {
      out.push(`- ${truncate(String(sc), MAX_AC_CHARS)}`);
    }
  }
  return out.join("\n");
}
