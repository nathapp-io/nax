/**
 * Context Engine v2 — Agent-Aware Renderer (Phase 5.5)
 *
 * Renders packed chunks into the push markdown string, adapting framing
 * to the target agent's preferred style (markdown-sections, xml-tagged,
 * or plain).
 *
 * Used by rebuildForAgent() when swapping agents on availability fallback.
 * The original assemble() path continues to use renderChunks() from render.ts
 * which defaults to the claude / markdown-sections style.
 *
 * Rendering styles:
 *   markdown-sections — ## Section headers separated by blank lines (Claude)
 *   xml-tagged        — <context_section type="…"> wrappers (Codex)
 *   plain             — [Section] bracket labels, no Markdown syntax
 *
 * Scope order and chunk sorting are shared via render-utils.ts.
 *
 * See: docs/specs/SPEC-context-engine-v2.md §Agent profile registry
 */

import { getAgentProfile } from "./agent-profiles";
import type { PackedChunk } from "./packing";
import { SCOPE_ORDER, groupByScope, sortedBodies } from "./render-utils";
import type { ChunkScope } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Scope labels (shared across all styles — headers differ per style)
// ─────────────────────────────────────────────────────────────────────────────

const SCOPE_LABELS: Record<ChunkScope, string> = {
  project: "Project Context",
  feature: "Feature Context",
  story: "Story Context",
  session: "Session History",
  retrieved: "Retrieved Context",
};

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentRenderOptions {
  /** Digest from the prior pipeline stage (optional preamble) */
  priorStageDigest?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Style renderers
// ─────────────────────────────────────────────────────────────────────────────

function renderMarkdownSections(chunks: PackedChunk[], options: AgentRenderOptions): string {
  const sections: string[] = [];
  if (options.priorStageDigest?.trim()) {
    sections.push(`## Prior Stage Summary\n\n${options.priorStageDigest.trim()}`);
  }
  const byScope = groupByScope(chunks);
  for (const scope of SCOPE_ORDER) {
    const group = byScope.get(scope) ?? [];
    if (group.length === 0) continue;
    sections.push(`## ${SCOPE_LABELS[scope]}\n\n${sortedBodies(group)}`);
  }
  return sections.join("\n\n");
}

function renderXmlTagged(chunks: PackedChunk[], options: AgentRenderOptions): string {
  const sections: string[] = [];
  if (options.priorStageDigest?.trim()) {
    const digest = options.priorStageDigest.trim();
    sections.push(`<context_section type="prior_stage_summary">\n${digest}\n</context_section>`);
  }
  const byScope = groupByScope(chunks);
  for (const scope of SCOPE_ORDER) {
    const group = byScope.get(scope) ?? [];
    if (group.length === 0) continue;
    sections.push(`<context_section type="${scope}">\n${sortedBodies(group)}\n</context_section>`);
  }
  return sections.join("\n\n");
}

function renderPlain(chunks: PackedChunk[], options: AgentRenderOptions): string {
  const sections: string[] = [];
  if (options.priorStageDigest?.trim()) {
    sections.push(`[Prior Stage Summary]\n${options.priorStageDigest.trim()}`);
  }
  const byScope = groupByScope(chunks);
  for (const scope of SCOPE_ORDER) {
    const group = byScope.get(scope) ?? [];
    if (group.length === 0) continue;
    sections.push(`[${SCOPE_LABELS[scope]}]\n${sortedBodies(group)}`);
  }
  return sections.join("\n\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render packed chunks into a push markdown string tailored to the target agent.
 *
 * The rendering style is determined by the agent's profile:
 *   claude  → markdown-sections (## headers)
 *   codex   → xml-tagged (<context_section> wrappers)
 *   unknown → plain ([bracket] labels, conservative fallback)
 *
 * @param chunks   - packed chunks from assemble() or rebuildForAgent()
 * @param agentId  - target agent id (e.g. "claude", "codex")
 * @param options  - optional priorStageDigest preamble
 */
export function renderForAgent(
  chunks: PackedChunk[],
  agentId: string,
  options: AgentRenderOptions = {},
): string {
  const { profile } = getAgentProfile(agentId);
  switch (profile.caps.systemPromptStyle) {
    case "markdown-sections":
      return renderMarkdownSections(chunks, options);
    case "xml-tagged":
      return renderXmlTagged(chunks, options);
    case "plain":
    default:
      return renderPlain(chunks, options);
  }
}
