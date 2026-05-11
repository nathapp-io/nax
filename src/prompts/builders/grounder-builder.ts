import type { ComposeInput } from "../compose";

export class GrounderPromptBuilder {
  static jsonRepair(_attempt: number, parseError: string): string {
    return `Your previous response was rejected.

Failure reason: ${parseError}

Re-write the complete facts manifest JSON from scratch and fix the schema issues before replying.

Requirements:
- Return exactly one JSON object matching the facts manifest schema.
- If an optional field has no value, OMIT the field. Do NOT use null.
- verification.factId must be a string like "F-001" when present; otherwise omit it.
- verification.evidence and gaps[].evidence must be strings when present; otherwise omit them.
- Keep IDs sequential within each array (F-001, F-002; S-001; G-001).
- Do not include markdown fences, comments, or explanation.
- If the previous response was long, keep summaries concise so the full JSON fits in one reply.

Output ONLY the JSON object. Do not include markdown fences or explanation.`;
  }

  build(specContent: string, codebaseContext: string, _workdir: string): ComposeInput {
    const role: ComposeInput["role"] = {
      id: "role",
      content:
        "You are a grounding agent. Your task is to analyze a specification and codebase context, then produce a structured facts manifest in JSON.",
      overridable: false,
    };

    const task: ComposeInput["task"] = {
      id: "task",
      content: `You are grounding a specification against the actual codebase.

## Specification

${specContent}

## Codebase Context

${codebaseContext}

## Instructions

Analyze the specification and source-root context above. Verify concrete claims against the repo before you assert them.

Grounding rules:
- Prefer verified positive facts over broad interpretation.
- Do not claim a file, symbol, builder, schema, or contract is missing unless you directly verified that absence via repo exploration.
- If something looks plausible but you did not verify it, mark the related spec claim as "unverified" or "partial" instead of inventing a repoFact or gap.
- Every repoFact must cite concrete evidence using real repo paths and line references.
- Keep gaps focused on genuinely missing context, ignored conventions, or unconsidered boundaries that you can support with evidence.

Produce a JSON object conforming exactly to this schema:

{
  "repoFacts": [
    {
      "id": "F-001",           // matches /^F-\\d{3,}$/
      "kind": "file | symbol | schema | contract | convention",
      "evidence": "string — concrete evidence from the codebase (non-empty)",
      "summary": "string — one-line description (non-empty)"
    }
  ],
  "specClaims": [
    {
      "id": "S-001",           // matches /^S-\\d{3,}$/
      "specSpan": "string — verbatim excerpt from the spec",
      "claim": "string — the claim made in the spec",
      "kind": "factual | intent",
      "verification": {
        "status": "verified | unverified | partial | contradicted",
        "evidence": "string — optional evidence",
        "factId": "F-001"      // optional, references a repoFact
      }
    }
  ],
  "gaps": [
    {
      "id": "G-001",           // matches /^G-\\d{3,}$/
      "kind": "missing-context | ignored-convention | boundary-not-considered",
      "note": "string — description of the gap (non-empty)",
      "evidence": "string — optional supporting evidence"
    }
  ]
}

Rules:
- IDs must be sequential starting at 001 within each array (F-001, F-002, ...; S-001, ...; G-001, ...).
- All required string fields must be non-empty.
- Negative or absence claims require direct evidence from repo exploration; otherwise keep them unverified.
- Output ONLY the JSON object — no markdown, no explanation.`,
      overridable: false,
    };

    return { role, task };
  }
}
