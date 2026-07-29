/**
 * Tests for parseModelSpec - splits a nax profile model string into a bare
 * model id and an optional reasoning-effort suffix.
 *
 * Malformed suffixes are passed through untouched on purpose: acpx (and the
 * adapter behind it) owns rejecting ids it does not advertise. Silently
 * rewriting a malformed value would hide a profile typo.
 */

import { describe, expect, test } from "bun:test";
import { parseModelSpec } from "@/agents";

describe("parseModelSpec", () => {
  test("splits a trailing effort suffix", () => {
    expect(parseModelSpec("gpt-5.6-luna[high]")).toEqual({ model: "gpt-5.6-luna", effort: "high" });
  });

  test("splits every effort level the adapter advertises", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(parseModelSpec(`gpt-5.6-luna[${effort}]`)).toEqual({ model: "gpt-5.6-luna", effort });
    }
  });

  test("returns a bare id unchanged with no effort", () => {
    expect(parseModelSpec("gpt-5.6-luna")).toEqual({ model: "gpt-5.6-luna" });
  });

  test("leaves non-codex model names alone", () => {
    expect(parseModelSpec("opus")).toEqual({ model: "opus" });
    expect(parseModelSpec("default")).toEqual({ model: "default" });
  });

  test("passes malformed suffixes through untouched", () => {
    for (const raw of ["gpt-5.6-luna[", "gpt-5.6-luna]", "lu[x]na", "[high]", "gpt-5.6-luna[]"]) {
      expect(parseModelSpec(raw)).toEqual({ model: raw });
    }
  });

  test("does not treat a nested bracket as an effort", () => {
    expect(parseModelSpec("model[a[b]]")).toEqual({ model: "model[a[b]]" });
  });
});
