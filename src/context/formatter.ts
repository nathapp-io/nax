/**
 * Context Markdown Formatter
 *
 * Extracted from builder.ts: formats built context as markdown for agent consumption.
 */

import type { BuiltContext, ContextElement } from "./types";

/**
 * Format built context as markdown for agent consumption.
 *
 * Generates markdown with sections for progress, prior errors,
 * test coverage, current story, dependency stories, and relevant files.
 */
export function formatContextAsMarkdown(built: BuiltContext): string {
  const sections: string[] = [];

  sections.push("# Story Context\n");
  sections.push(`${built.summary}\n`);

  // Group by type
  const byType = new Map<string, ContextElement[]>();
  for (const element of built.elements) {
    const existing = byType.get(element.type) || [];
    existing.push(element);
    byType.set(element.type, existing);
  }

  renderSection(sections, byType, "progress", "## Progress\n", renderSimple);
  renderErrorSection(sections, byType);
  renderSection(sections, byType, "test-coverage", "", renderSimple);
  renderSection(sections, byType, "story", "## Current Story\n", renderSimple);
  renderSection(sections, byType, "dependency", "## Dependency Stories\n", renderSimple);
  renderSection(sections, byType, "file", "## Relevant Source Files\n", renderSimple);

  return sections.join("\n");
}

/** Render a simple section with elements as-is. */
function renderSimple(sections: string[], elements: ContextElement[]): void {
  for (const element of elements) {
    sections.push(element.content);
    sections.push("\n");
  }
}

/** Render a typed section if elements exist. */
function renderSection(
  sections: string[],
  byType: Map<string, ContextElement[]>,
  type: string,
  header: string,
  renderer: (sections: string[], elements: ContextElement[]) => void,
): void {
  const elements = byType.get(type);
  if (!elements || elements.length === 0) return;
  if (header) sections.push(header);
  renderer(sections, elements);
}

/** Render error section with special handling for ASSET_CHECK errors. */
function renderErrorSection(sections: string[], byType: Map<string, ContextElement[]>): void {
  const errorElements = byType.get("error");
  if (!errorElements || errorElements.length === 0) return;

  const assetCheckErrors: ContextElement[] = [];
  const otherErrors: ContextElement[] = [];

  for (const element of errorElements) {
    if (element.content.startsWith("ASSET_CHECK_FAILED:")) {
      assetCheckErrors.push(element);
    } else {
      otherErrors.push(element);
    }
  }

  if (assetCheckErrors.length > 0) {
    sections.push("## ⚠️ MANDATORY: Missing Files from Previous Attempts\n");
    sections.push("**CRITICAL:** Previous attempts failed because these files were not created.\n");
    sections.push("You MUST create these exact files. Do NOT use alternative filenames.\n\n");

    for (const element of assetCheckErrors) {
      const match = element.content.match(/Missing files: \[([^\]]+)\]/);
      if (match) {
        const fileList = match[1].split(",").map((f) => f.trim());
        sections.push("**Required files:**\n");
        for (const file of fileList) {
          sections.push(`- \`${file}\``);
        }
        sections.push("\n");
      } else {
        sections.push("```");
        sections.push(element.content);
        sections.push("```\n");
      }
    }
  }

  if (otherErrors.length > 0) {
    sections.push("## Prior Errors\n");
    for (const element of otherErrors) {
      sections.push("```");
      sections.push(element.content);
      sections.push("```\n");
    }
  }
}
