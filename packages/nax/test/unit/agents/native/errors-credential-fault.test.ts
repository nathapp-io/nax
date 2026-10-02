/**
 * US-005 — `credentialFaultCode`: the bounded walk of a protocol fault's cause chain.
 *
 * Split out of errors.test.ts so the mapping tests there keep running while this
 * export does not exist yet (a missing named export fails the whole file at link
 * time). The walk is what tells a credential-store throw from a stalled socket:
 * nax-ai files every status-less throw as protocol kind `transport`, so only the
 * `NaxError` code on the chain distinguishes them.
 */

import { describe, expect, test } from "bun:test";
import { credentialFaultCode, type NativeProtocolError } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";

const CREDENTIAL_CODES: readonly string[] = [
  "CREDENTIAL_HELPER_FAILED",
  "CREDENTIAL_HELPER_INVALID",
  "CREDENTIAL_CHANGED",
  "CREDENTIAL_FILE_UNREADABLE",
];

function credentialNaxError(code: string): NaxError {
  return new NaxError(`[credentials] ${code}`, code, { stage: "credentials" });
}

/** The store's throw as pi-ai relays it: protocol error -> Error -> NaxError. */
function wrappedStoreFault(kind: string, code: string): NativeProtocolError {
  return { kind, cause: new Error("models error", { cause: credentialNaxError(code) }) };
}

/**
 * A protocol error whose cause chain reaches `tail` in exactly `hops` links,
 * with plain Errors in between. `hops === 1` puts `tail` straight on `cause`.
 */
function faultAtDepth(kind: string, hops: number, tail: unknown): NativeProtocolError {
  let node = tail;
  for (let hop = hops - 1; hop >= 1; hop--) node = new Error(`hop ${hop}`, { cause: node });
  return { kind, cause: node };
}

describe("credentialFaultCode", () => {
  test("US-005 AC1: returns CREDENTIAL_HELPER_FAILED for a transport fault whose cause is an Error whose cause carries that code", () => {
    expect(credentialFaultCode(wrappedStoreFault("transport", "CREDENTIAL_HELPER_FAILED"))).toBe(
      "CREDENTIAL_HELPER_FAILED",
    );
  });

  test.each([...CREDENTIAL_CODES])(
    "US-005 AC1: recognises %s even though the protocol kind says the fault was a transport one",
    (code) => {
      expect(credentialFaultCode(wrappedStoreFault("transport", code))).toBe(code);
    },
  );

  test("US-005 AC2: returns undefined for a transport fault whose cause chain holds no NaxError", () => {
    const fault: NativeProtocolError = {
      kind: "transport",
      cause: new Error("models error", { cause: new Error("socket closed") }),
    };
    expect(credentialFaultCode(fault)).toBeUndefined();
  });

  test("US-005 AC2: returns undefined when the fault carries no cause at all", () => {
    expect(credentialFaultCode({ kind: "transport" })).toBeUndefined();
  });

  test("US-005 AC3: returns undefined when the credential-fault NaxError sits at link 9 of the cause chain", () => {
    expect(credentialFaultCode(faultAtDepth("transport", 9, credentialNaxError("CREDENTIAL_CHANGED")))).toBeUndefined();
  });

  test("US-005 AC3: stops at link 8, so a credential-fault NaxError there is still found", () => {
    expect(credentialFaultCode(faultAtDepth("transport", 8, credentialNaxError("CREDENTIAL_CHANGED")))).toBe(
      "CREDENTIAL_CHANGED",
    );
  });

  test("US-005 AC4: returns undefined for a cause chain whose only NaxError has code AGENT_NOT_FOUND", () => {
    const fault: NativeProtocolError = {
      kind: "transport",
      cause: new Error("models error", {
        cause: new NaxError("agent missing", "AGENT_NOT_FOUND", { stage: "registry" }),
      }),
    };
    expect(credentialFaultCode(fault)).toBeUndefined();
  });
});
