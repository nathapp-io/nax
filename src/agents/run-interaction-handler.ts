/**
 * Run interaction handler — answers in-flight requests from the agent turn.
 *
 * Transport-agnostic: served both the ACP adapter (via a re-export from
 * `agents/acp/adapter-output`) and the native path. It originally lived in
 * the ACP tree — the same trap Phase B hit with `buildContextToolPreamble`,
 * which was fixed by relocating to `src/agents/tool-preamble.ts`. Importing
 * ACP into the native tree is backwards and trips `check:alias-internals`.
 */

import type { InteractionHandler } from "./interaction-handler";
import type { AgentRunOptions } from "./types";

/** Exactly what the handler reads. Narrower than AgentRunOptions on purpose. */
export type RunInteractionOptions = Pick<
  AgentRunOptions,
  "contextToolRuntime" | "contextPullTools" | "interactionBridge" | "codingToolRuntime"
>;

function escapeAttributeValue(value: string): string {
  // Encode the three characters that matter for round-tripping and for
  // guarding the opening tag from being terminated or colluding with the
  // closing delimiter:
  //   `\`  → `\\`           (so later escapes don't double-up)
  //   `<`  → `\u003C`       (Unicode escape — JSON.parse decodes back;
  //                          also prevents `</` ever forming, so the
  //                          closing-delimiter substring cannot survive
  //                          a name that contains it)
  //   `>`  → `\u003E`       (so a `>` inside the attribute value cannot
  //                          be mistaken for the closing `>` of the
  //                          opening tag by parsers that locate it by
  //                          scanning for the first `>`)
  //   `"`  → `\"`           (attribute-level boundary)
  // Order: backslash first (must not double-escape itself), then `<`/`>`,
  // then `"`. JSON.parse of the encoded value restores the original —
  // and the `<` rewrite guarantees there is no `</` anywhere in the
  // rendered answer's name attribute, so AC4's "exactly one closing
  // delimiter" invariant holds even when the request name itself
  // contains `</nax_tool_result>`.
  return value.replace(/\\/g, "\\\\").replace(/</g, "\\u003C").replace(/>/g, "\\u003E").replace(/"/g, '\\"');
}

function escapeResultBody(body: string): string {
  // Only the exact closing-delimiter sequence is a threat to the AC4
  // "exactly one closing delimiter" invariant — escaping every `</` in the
  // body would corrupt legitimate content the agent needs verbatim (HTML/JSX
  // snippets, `</script>` in a fetched page, etc.) that a tool result may
  // legitimately carry.
  return body.replace(/<\/nax_tool_result>/g, "<\\/nax_tool_result>");
}

function buildContextToolResult(name: string, result: string, status: "ok" | "error" = "ok"): string {
  return `<nax_tool_result name="${escapeAttributeValue(name)}" status="${status}">
${escapeResultBody(result.trim())}
</nax_tool_result>

Continue the task.`;
}

export function buildRunInteractionHandler(options: RunInteractionOptions): InteractionHandler {
  const { contextToolRuntime, contextPullTools, interactionBridge } = options;
  const hasContextTools = Boolean(contextToolRuntime && (contextPullTools?.length ?? 0) > 0);

  return {
    async onInteraction(req) {
      if (req.kind === "context-tool") {
        if (!hasContextTools || !contextToolRuntime) return null;
        try {
          const toolResult = req.error
            ? buildContextToolResult(req.name, req.error, "error")
            : buildContextToolResult(req.name, await contextToolRuntime.callTool(req.name, req.input ?? {}));
          return { answer: toolResult };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { answer: buildContextToolResult(req.name, msg, "error") };
        }
      }
      if (req.kind === "question") {
        if (!interactionBridge) return null;
        const answer = await interactionBridge.onQuestionDetected(req.text);
        return { answer };
      }
      if (req.kind === "coding-tool") {
        const runtime = options.codingToolRuntime;
        if (!runtime) return null;
        const outcome = await runtime.callTool(req.name, req.input ?? {});
        if (outcome.kind === "denied") {
          return {
            answer: `Denied: ${outcome.reason}`,
            denied: { reason: outcome.reason, breach: outcome.breach },
          };
        }
        return { answer: outcome.content };
      }
      return null;
    },
  };
}
