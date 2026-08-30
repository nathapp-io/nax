/**
 * US-005 — SpawnAcpClient.timeoutSeconds zero-survival.
 *
 * AC8: When SpawnAcpClient is constructed with `timeoutSeconds` of `0`,
 * then its `timeoutSeconds` is `0`; when constructed without the argument,
 * then its `timeoutSeconds` equals `DEFAULT_ACP_TIMEOUT_SECONDS`.
 *
 * The constructor previously used `timeoutSeconds || 1800`, which silently
 * promoted an explicit `0` to `1800`. The fix replaces that with
 * `timeoutSeconds ?? DEFAULT_ACP_TIMEOUT_SECONDS`. The field is widened
 * from `private readonly` to `readonly` so the resolved value is observable
 * without spawning a session.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_ACP_TIMEOUT_SECONDS, SpawnAcpClient } from "@/agents/acp/spawn-client";

// `SpawnAcpClient` requires cwd and parses cmdStr; an unknown agent name
// would throw at construction. Use the same minimal cmd that the rest of
// the suite uses and assert on the field rather than spawning anything.
describe("SpawnAcpClient — timeoutSeconds zero-survival (#US-005)", () => {
  test("AC8 (success): an explicit timeoutSeconds=0 is preserved on the client", () => {
    const client = new SpawnAcpClient("acpx claude", "/tmp", 0);
    expect(client.timeoutSeconds).toBe(0);
  });

  test("AC8 (default): omitting timeoutSeconds defaults to DEFAULT_ACP_TIMEOUT_SECONDS", () => {
    const client = new SpawnAcpClient("acpx claude", "/tmp");
    expect(client.timeoutSeconds).toBe(DEFAULT_ACP_TIMEOUT_SECONDS);
  });
});
