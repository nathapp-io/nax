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

import {
  SectionAccumulator,
  instructionsSection,
  jsonSchemaSection,
  routingCandidatesSection,
  universalConstitutionSection,
} from "../core";
import type { RoutingCandidate, SchemaDescriptor } from "../core";

export type OneShotRole = "router" | "decomposer" | "auto-approver";

export class OneShotPromptBuilder {
  private acc = new SectionAccumulator();
  /** Preserved for observability and future role-gating. Does not affect output today. */
  readonly role: OneShotRole;

  private constructor(role: OneShotRole) {
    this.role = role;
  }

  static for(role: OneShotRole): OneShotPromptBuilder {
    return new OneShotPromptBuilder(role);
  }

  /** Returns the role this builder was created for (for observability and future role-gating). */
  getRole(): OneShotRole {
    return this.role;
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

  build(): string {
    return this.acc.join();
  }
}
