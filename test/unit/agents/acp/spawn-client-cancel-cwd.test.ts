/**
 * BUG-3: SpawnAcpSession.close({forceTerminate:true})'s `acpx ... stop` and
 * cancelActivePrompt()'s `acpx ... cancel` omitted --cwd, unlike every other
 * acpx invocation in this class (sessions close, and SpawnAcpClient.forceStop
 * — see spawn-client.test.ts). Without --cwd, acpx resolves the command
 * against nax's own process cwd instead of the session's worktree — in a
 * parallel batch this can cancel/stop the wrong story's agent instance of
 * the same agentName.
 *
 * Split from spawn-client.test.ts to stay within the 800-line test file limit.
 */

import { describe, expect, test } from "bun:test";
import { assertDefined, withDepsRestore } from "@test/helpers";
import { _spawnClientDeps, SpawnAcpClient } from "@/agents/acp";
import { makeSpawnResult, stubProcessKill } from "./_spawn-client-test-helpers";

stubProcessKill();

describe("SpawnAcpSession — --cwd on cancel/stop (BUG-3)", () => {
  withDepsRestore(_spawnClientDeps, ["spawn"]);

  test("close({forceTerminate:true}) spawns `acpx --cwd <cwd> <agentName> stop`", async () => {
    const spawnedCommands: string[][] = [];
    _spawnClientDeps.spawn = (cmd, _opts) => {
      spawnedCommands.push(cmd as string[]);
      return makeSpawnResult(0);
    };

    const client = new SpawnAcpClient("acpx claude", "/tmp/my-worktree");
    const session = await client.loadSession("test-session", "claude", "approve-reads");
    assertDefined(session, "session");
    spawnedCommands.length = 0; // drop the loadSession/ensure-session spawn(s)

    await session.close({ forceTerminate: true });

    const stopCall = spawnedCommands.find((c) => c.includes("stop"));
    expect(stopCall).toEqual(["acpx", "--cwd", "/tmp/my-worktree", "claude", "stop"]);
  });

  test("cancelActivePrompt() spawns `acpx --cwd <cwd> <agentName> cancel`", async () => {
    const spawnedCommands: string[][] = [];
    _spawnClientDeps.spawn = (cmd, _opts) => {
      spawnedCommands.push(cmd as string[]);
      return makeSpawnResult(0);
    };

    const client = new SpawnAcpClient("acpx claude", "/tmp/my-worktree");
    const session = await client.loadSession("test-session", "claude", "approve-reads");
    assertDefined(session, "session");
    spawnedCommands.length = 0;

    await session.cancelActivePrompt();

    const cancelCall = spawnedCommands.find((c) => c.includes("cancel"));
    expect(cancelCall).toEqual(["acpx", "--cwd", "/tmp/my-worktree", "claude", "cancel"]);
  });
});
