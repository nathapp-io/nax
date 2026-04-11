/**
 * OneShotPromptBuilder — escape hatch for structurally trivial one-shot prompts.
 *
 * Covers router, decomposer, and auto-approver: each is a short instruction +
 * optional input data + optional JSON schema. They share no domain and do not
 * justify dedicated builder classes.
 *
 * CONSTRAINT: ≤150 lines. If you find yourself adding domain-specific methods
 * here, promote the prompt to its own dedicated builder instead.
 */

import { SectionAccumulator, universalConstitutionSection } from "../core";
import type { SchemaDescriptor } from "../core/sections";
import { instructionsSection } from "../core/sections/instructions";
import { jsonSchemaSection } from "../core/sections/json-schema";
import { routingCandidatesSection } from "../core/sections/routing-candidates";
import type { RoutingCandidate } from "../core/sections/routing-candidates";

export type OneShotRole = "router" | "decomposer" | "auto-approver";

export class OneShotPromptBuilder {
  private acc = new SectionAccumulator();

  private constructor() {}

  static for(_role: OneShotRole): OneShotPromptBuilder {
    return new OneShotPromptBuilder();
  }

  /** Optional constitution — benefits decomposer and auto-approver; router does not use it. */
  constitution(c: string | undefined): this {
    this.acc.add(universalConstitutionSection(c));
    return this;
  }

  /** Primary instruction block — what the model should do. */
  instructions(text: string): this {
    this.acc.add(instructionsSection(text));
    return this;
  }

  /**
   * Labelled input data block.
   * Call multiple times to add multiple input sections (each gets its own heading).
   * The label is uppercased as the heading; the body appears verbatim beneath it.
   */
  inputData(label: string, body: string): this {
    this.acc.add({
      id: `input-${label.toLowerCase().replace(/\s+/g, "-")}`,
      overridable: false,
      content: `# ${label.toUpperCase()}\n\n${body}`,
    });
    return this;
  }

  /** Available model tiers — used by the router role. */
  candidates(cs: RoutingCandidate[]): this {
    this.acc.add(routingCandidatesSection(cs));
    return this;
  }

  /** Describes the expected JSON output shape. */
  jsonSchema(schema: SchemaDescriptor): this {
    this.acc.add(jsonSchemaSection(schema));
    return this;
  }

  async build(): Promise<string> {
    return this.acc.join();
  }
}
