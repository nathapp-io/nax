/**
 * Pairs the compiled policy with the tool registry and answers one call.
 *
 * nax-permission-mode-allow: consumes grants resolved by resolvePermissions;
 * makes no permission decision of its own.
 *
 * The three outcomes are kept structurally distinct. Reusing one channel for a
 * refusal and a crash would make a denied permission look like a recoverable
 * tool error, which ADR-029 section 5 forbids.
 */

import { getSafeLogger } from "@/logger";
import { editTool } from "./edit";
import { gitTool } from "./git";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { readTool } from "./read";
import { type CodingTool, getCodingTool, registerBuiltinTool } from "./registry";
import type { ToolPolicy } from "./types";
import { writeTool } from "./write";

/** Per-call output ceiling, mirroring ToolDescriptor.maxTokensPerCall in spirit. */
export const DEFAULT_TOOL_MAX_BYTES = 40_000;

export type CodingToolOutcome =
  | { readonly kind: "ok"; readonly content: string }
  | { readonly kind: "error"; readonly content: string }
  | { readonly kind: "denied"; readonly reason: string; readonly breach: boolean };

export interface CodingToolRuntime {
  /** Op declaration intersected with policy grants. Both can only narrow. */
  advertised(declared: readonly string[]): readonly CodingTool[];
  callTool(name: string, input: Record<string, unknown>): Promise<CodingToolOutcome>;
}

let builtinsRegistered = false;

/** Idempotent: the registry is process-global, the runtime is per-session. */
export function registerBuiltinCodingTools(): void {
  if (builtinsRegistered) return;
  for (const tool of [readTool, globTool, grepTool, writeTool, editTool, gitTool]) {
    if (getCodingTool(tool.name) === undefined) registerBuiltinTool(tool);
  }
  builtinsRegistered = true;
}

/** @internal Test-only: pairs with _resetRegistryForTest. */
export function _resetBuiltinsForTest(): void {
  builtinsRegistered = false;
}

export function createCodingToolRuntime(opts: { policy: ToolPolicy; maxBytes?: number }): CodingToolRuntime {
  registerBuiltinCodingTools();
  const maxBytes = opts.maxBytes ?? DEFAULT_TOOL_MAX_BYTES;
  const granted = new Set(opts.policy.grantedTools());

  return {
    advertised(declared) {
      const out: CodingTool[] = [];
      for (const name of declared) {
        if (!granted.has(name)) continue;
        const tool = getCodingTool(name);
        if (tool !== undefined) out.push(tool);
      }
      return out;
    },

    async callTool(name, input) {
      const tool = getCodingTool(name);
      if (tool === undefined) {
        return { kind: "denied", reason: `unknown tool "${name}"`, breach: false };
      }

      const verdict = opts.policy.check(name, tool.scope, input);
      if (!verdict.allowed) {
        if (verdict.breach) {
          // In band so an unattended run survives one bad path guess, but loud:
          // a path escaping the root can indicate prompt injection.
          getSafeLogger()?.warn("tools", "[policy] path resolved outside the permitted root", {
            tool: name,
            reason: verdict.reason,
            root: opts.policy.root,
          });
        }
        return { kind: "denied", reason: verdict.reason, breach: verdict.breach };
      }

      try {
        const result = await tool.run(input, {
          root: opts.policy.root,
          resolvedPaths: verdict.resolvedPaths,
          maxBytes,
        });
        return result.isError === true
          ? { kind: "error", content: result.content }
          : { kind: "ok", content: result.content };
      } catch (err) {
        return { kind: "error", content: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
