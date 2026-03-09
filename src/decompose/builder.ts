/**
 * DecomposeBuilder — fluent API for composing story decomposition prompts.
 *
 * Usage:
 *   const prompt = DecomposeBuilder.for(story)
 *     .prd(prd)
 *     .codebase(scan)
 *     .config(cfg)
 *     .buildPrompt();
 *
 * NOT IMPLEMENTED — stub for test RED phase.
 */

import type { CodebaseScan } from "../analyze/types";
import type { PRD, UserStory } from "../prd";
import type { DecomposeAdapter, DecomposeConfig, DecomposeResult } from "./types";

export const SECTION_SEP = "\n\n---\n\n";

export class DecomposeBuilder {
  private constructor(_story: UserStory) {}

  static for(_story: UserStory): DecomposeBuilder {
    throw new Error("Not implemented: DecomposeBuilder.for");
  }

  prd(_prd: PRD): this {
    throw new Error("Not implemented: DecomposeBuilder.prd");
  }

  codebase(_ctx: CodebaseScan): this {
    throw new Error("Not implemented: DecomposeBuilder.codebase");
  }

  config(_cfg: DecomposeConfig): this {
    throw new Error("Not implemented: DecomposeBuilder.config");
  }

  buildPrompt(): string {
    throw new Error("Not implemented: DecomposeBuilder.buildPrompt");
  }

  async decompose(_adapter: DecomposeAdapter): Promise<DecomposeResult> {
    throw new Error("Not implemented: DecomposeBuilder.decompose");
  }
}
