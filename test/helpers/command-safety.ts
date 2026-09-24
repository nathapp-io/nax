/**
 * Shared command-safety test fixtures.
 *
 * `IDENTIFIER_KEYS` is the single definition of the call-identifier set, kept
 * beside the contract it mirrors (`CallIdentifiers` in
 * `src/command-safety/identifiers.ts`). A compile-time guard below turns a new
 * identifier into a type error until it is listed here, so the "no identifier
 * key is present" assertions cannot silently miss one.
 */
import { expect } from "bun:test";
import type { CommandShadow, FinalOutcome, Observation } from "@/command-safety";
import type { CallIdentifiers } from "@/command-safety/identifiers";

export const IDENTIFIER_KEYS = ["callId", "scopeId", "turnId", "roundTrips", "toolCallId"] as const;

type IdentifierKey = (typeof IDENTIFIER_KEYS)[number];
type AssertTrue<T extends true> = T;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Compile-time guard: `IDENTIFIER_KEYS` must list exactly `keyof CallIdentifiers`.
 * Adding a field to the interface without adding it here yields `false`, which
 * violates the `AssertTrue` constraint and fails the typecheck.
 */
export type IdentifierKeysMatchContract = AssertTrue<Exact<keyof CallIdentifiers, IdentifierKey>>;

/** The single Observation a recorder captured, or a loud failure. */
export function observedOnly(r: { observed: [string, Observation][] }): Observation {
  expect(r.observed).toHaveLength(1);
  const entry = r.observed[0];
  if (entry === undefined) throw new Error("no observation was recorded");
  return entry[1];
}

/** A `CommandShadow` recording every `observe`/`settle` call, with overrides. */
export function makeCommandShadowRecorder(overrides: Partial<CommandShadow> = {}) {
  const observed: [string, Observation][] = [];
  const settled: [string, FinalOutcome][] = [];
  const shadow: CommandShadow = {
    observe: (k, o) => void observed.push([k, o]),
    settle: (k, o) => void settled.push([k, o]),
    drain: async () => {},
    ...overrides,
  };
  return { shadow, observed, settled };
}
