/**
 * The workspace links nax-agent as this package's peer, so tests and (from S4-2)
 * src/ resolve `@nathapp/nax-agent` to the workspace source, not a registry copy.
 */
import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AgentSessionError } from "@nathapp/nax-agent";

describe("workspace wiring", () => {
  test("@nathapp/nax-agent resolves to the workspace package's public entry", () => {
    const resolved = realpathSync(fileURLToPath(import.meta.resolve("@nathapp/nax-agent")));
    expect(resolved.endsWith("/packages/nax-agent/src/index.ts")).toBe(true);
  });

  test("the public entry carries AgentSessionError", () => {
    const error = new AgentSessionError("closed", "AGENT_SESSION_CLOSED");
    expect(error.code).toBe("AGENT_SESSION_CLOSED");
  });
});
