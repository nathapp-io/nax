import type { ComposeInput } from "../compose";

export class GrounderPromptBuilder {
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

Analyze the specification and codebase context above. Produce a JSON object conforming exactly to this schema:

{
  "repoFacts": [
    {
      "id": "F-001",           // matches /^F-\\d{3}$/
      "kind": "file | symbol | schema | contract | convention",
      "evidence": "string — concrete evidence from the codebase (non-empty)",
      "summary": "string — one-line description (non-empty)"
    }
  ],
  "specClaims": [
    {
      "id": "S-001",           // matches /^S-\\d{3}$/
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
      "id": "G-001",           // matches /^G-\\d{3}$/
      "kind": "missing-context | ignored-convention | boundary-not-considered",
      "note": "string — description of the gap (non-empty)",
      "evidence": "string — optional supporting evidence"
    }
  ]
}

Rules:
- IDs must be sequential starting at 001 within each array (F-001, F-002, ...; S-001, ...; G-001, ...).
- All required string fields must be non-empty.
- Output ONLY the JSON object — no markdown, no explanation.`,
      overridable: false,
    };

    return { role, task };
  }
}
