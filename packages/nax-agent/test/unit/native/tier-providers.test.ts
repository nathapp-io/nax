/**
 * `nativeTierProviders` — the provider -> tiers derivation shared by the
 * native-credentials precheck and by callers outside nax (US-001).
 *
 * The rule it pins down: only the default agent's root `models.native` map is
 * read, an id's provider is the prefix before "/" and is never guessed, and a
 * provider declared in `agent.native.catalogOverrides` is skipped because it
 * authenticates through the override.
 */

import { describe, expect, test } from "bun:test";
import { nativeTierProviders } from "@nathapp/nax-agent";

describe("nativeTierProviders", () => {
  test("reads a plain object carrying only the two fields it declares (no NaxConfig)", () => {
    const byProvider = nativeTierProviders({
      agent: { native: { catalogOverrides: [{ provider: "proxy" }] } },
      models: { native: { fast: "anthropic/claude-haiku-4-5", balanced: { model: "proxy/x" } } },
    });
    expect([...byProvider.entries()]).toEqual([["anthropic", ["fast"]]]);
  });
});
