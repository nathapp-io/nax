/**
 * OneShotPromptBuilder — escape hatch for structurally trivial one-shot prompts.
 *
 * Covers router, decomposer, and classifier: each is a short instruction +
 * optional input data + optional JSON schema. They share no domain and do
 * not justify dedicated builder classes.
 *
 * CONSTRAINT: ≤160 lines. If you find yourself adding domain-specific methods
 * here, promote the prompt to its own dedicated builder instead.
 */

import type { AgentRoutingProfile } from "@/config";
import type { RoutingCandidate, SchemaDescriptor } from "../core";
import {
  instructionsSection,
  jsonSchemaSection,
  routingCandidatesSection,
  SectionAccumulator,
  universalConstitutionSection,
} from "../core";

export type OneShotRole = "router" | "decomposer";

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

  /** Optional constitution — benefits decomposer; router does not use it. */
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

  /**
   * Injects agent capability cards + selection instruction into the prompt.
   * No-op when profiles is empty — safe to call unconditionally.
   * Must be called before jsonSchema() so cards appear before the output schema.
   */
  agentProfiles(profiles: AgentRoutingProfile[]): this {
    const cards = OneShotPromptBuilder.agentCapabilityCards(profiles);
    if (cards.length === 0) return this;
    this.acc.add({
      id: "agent-profiles",
      overridable: false,
      content: `${cards}\n\n${OneShotPromptBuilder.agentProfileInstruction()}`,
    });
    return this;
  }

  build(): string {
    return this.acc.join();
  }

  /**
   * Returns the ordered selection rubric telling the LLM how to assign
   * `agentProfileId` per story. The procedure (not free-form judgment) is
   * load-bearing: decompose may run on a cheap model that cannot be trusted
   * with open-ended "pick the best agent" questions.
   */
  static agentProfileInstruction(): string {
    return [
      "When agent profiles are listed above, pick exactly ONE profile id per story and set it on the `agentProfileId` field. Apply these steps in order:",
      "1. Eliminate any profile whose weaknesses conflict with the story.",
      "2. Keep profiles whose strengths or affinity cover the story's main job (task type + primary domain).",
      "3. If more than one remains, choose the LOWEST cost profile.",
      "4. If none clearly fit, omit `agentProfileId` entirely — never invent a profile id.",
    ].join("\n");
  }

  /** Role content for the story classifier (classifyRouteOp / classifyRouteBatchOp). */
  static classifierRoleContent(): string {
    return "You are a story classifier that assigns complexity and model tier to user stories.\nRespond with JSON only — no explanation text before or after.";
  }

  /**
   * Formats agent routing profiles as a markdown capability card table for LLM consumption.
   * Returns an empty string when profiles is empty — caller decides whether to include the section.
   */
  static agentCapabilityCards(profiles: AgentRoutingProfile[]): string {
    if (profiles.length === 0) return "";

    const header = [
      "## Agent Profiles",
      "",
      "| ID | Agent | Tier | Strengths | Weaknesses | Affinity | Cost |",
      "|---|---|---|---|---|---|---|",
    ];

    const rows = profiles.map((p) => {
      const esc = OneShotPromptBuilder.escapeCell;
      const id = esc(p.id);
      const agent = esc(p.target.agent);
      const model = esc(p.target.model);
      const strengths = p.strengths.map(esc).join(", ");
      const weaknesses = p.weaknesses?.length ? p.weaknesses.map(esc).join("; ") : "—";
      const affinityParts = [...(p.affinity?.taskTypes ?? []), ...(p.affinity?.domains ?? [])];
      const affinity = affinityParts.length ? affinityParts.map(esc).join(", ") : "—";
      const cost = esc(p.costTier ?? "—");
      return `| ${id} | ${agent} | ${model} | ${strengths} | ${weaknesses} | ${affinity} | ${cost} |`;
    });

    return [...header, ...rows].join("\n");
  }

  private static escapeCell(value: string): string {
    return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  }
}
