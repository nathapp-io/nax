/**
 * A close, delete or shutdown that overlaps a mode or model switch wins
 * (spec §Approach 4-5): the registry never reinserts the entry, never writes the
 * switched metadata, and the owner that called close cleans up exactly once.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { waitForCondition, withTimeout } from "@nathapp/nax-test-kit/bun/timeout";
import type { SessionRegistry } from "#src/server/registry";
import { type RegistrySetupExtra, setupRegistry } from "#test/helpers/registry-setup";

const SETTLE_MS = 2_000;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});
function dir(): string {
  const made = makeTempDir("registry-close-switch-");
  dirs.push(made);
  return made;
}

type Setup = ReturnType<typeof setupRegistry>;

/** A gate the test opens by hand, so it knows exactly when the gated open proceeds. */
function handGate() {
  const opened = Promise.withResolvers<void>();
  return { gate: opened.promise, open: () => opened.resolve() };
}

/** A created session (mode `ask`) whose every later openSession call waits on the gate. */
async function created(extra: RegistrySetupExtra = {}) {
  const hand = handGate();
  const s = setupRegistry(dir(), undefined, { openGate: hand.gate, openGateFrom: 2, ...extra });
  const { sessionId } = await s.registry.create(s.input());
  expect(s.releases()).toBe(0);
  return { s, sessionId, hand };
}

/** Records a rejection instead of leaving it unhandled, so a gate release can precede the assertion. */
const observed = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  );

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** "settled" only once the promise really settled; the marker wins while it is still pending. */
const raceMarker = (work: Promise<unknown>): Promise<string> =>
  Promise.race([work.then(() => "settled"), Promise.resolve("pending")]);

const lockFile = (s: Setup, sessionId: string): string => join(s.dir, `${sessionId}.lock`);
const locked = async (s: Setup, sessionId: string): Promise<boolean> =>
  readFile(lockFile(s, sessionId)).then(
    () => true,
    () => false,
  );

/** starts `setMode(id, "full")`, waits for its gated open, then starts `closer`. */
async function switchThen(
  close: (registry: SessionRegistry, sessionId: string) => Promise<unknown>,
  extra: RegistrySetupExtra = {},
) {
  const { s, sessionId, hand } = await created(extra);
  const switching = observed(s.registry.setMode(sessionId, "full"));
  await waitForCondition(() => s.opened.length === 2);
  const closing = observed(close(s.registry, sessionId));
  return { s, sessionId, hand, switching, closing };
}

const settle = async (promises: readonly Promise<unknown>[]): Promise<void> => {
  await withTimeout(Promise.all(promises), SETTLE_MS, "race did not settle");
};

describe("close during a mode switch", () => {
  test("leaves no session in the registry", async () => {
    const race = await switchThen((registry, id) => registry.close(id));
    race.hand.open();
    await settle([race.switching, race.closing]);
    expect(race.s.registry.find(race.sessionId)).toBeUndefined();
  });

  test("holds the lock once close is called and until the gated open is released", async () => {
    const race = await switchThen((registry, id) => registry.close(id));
    expect(await locked(race.s, race.sessionId)).toBe(true);
    expect(await raceMarker(race.closing)).toBe("pending");
    race.hand.open();
    await settle([race.switching, race.closing]);
  });

  test("leaves no lock file once both settle", async () => {
    const race = await switchThen((registry, id) => registry.close(id));
    race.hand.open();
    await settle([race.switching, race.closing]);
    expect(await locked(race.s, race.sessionId)).toBe(false);
  });

  test("releases the lock exactly once", async () => {
    const race = await switchThen((registry, id) => registry.close(id));
    race.hand.open();
    await settle([race.switching, race.closing]);
    expect(race.s.releases()).toBe(1);
  });

  test("rejects the switch with session is closed", async () => {
    const race = await switchThen((registry, id) => registry.close(id));
    race.hand.open();
    await settle([race.switching, race.closing]);
    const error = await race.switching;
    expect(error instanceof RequestError).toBe(true);
    expect(messageOf(error)).toContain("session is closed");
  });

  test("closes the replacement session", async () => {
    const race = await switchThen((registry, id) => registry.close(id));
    race.hand.open();
    await settle([race.switching, race.closing]);
    expect(race.s.fakes).toHaveLength(2);
    expect(race.s.fakes[1]?.closed()).toBe(true);
  });

  test("keeps the pre-switch mode in the metadata", async () => {
    const race = await switchThen((registry, id) => registry.close(id));
    race.hand.open();
    await settle([race.switching, race.closing]);
    expect((await race.s.storage.readMeta(race.sessionId))?.mode).toBe("ask");
  });
});

describe("delete during a mode switch", () => {
  test("leaves no metadata file", async () => {
    const race = await switchThen((registry, id) => registry.delete(id));
    race.hand.open();
    await settle([race.switching, race.closing]);
    expect(await race.s.storage.readMeta(race.sessionId)).toBeNull();
  });

  test("leaves no session in the registry", async () => {
    const race = await switchThen((registry, id) => registry.delete(id));
    race.hand.open();
    await settle([race.switching, race.closing]);
    expect(race.s.registry.find(race.sessionId)).toBeUndefined();
  });
});

describe("closeAll during a mode switch", () => {
  test("resolves while the open is still gated and the lock is still held", async () => {
    const race = await switchThen((registry) => registry.closeAll());
    await withTimeout(race.closing, SETTLE_MS, "closeAll did not resolve");
    expect(await locked(race.s, race.sessionId)).toBe(true);
    expect(race.s.lines.some((line) => line.message.includes("did not close in time"))).toBe(true);
    race.hand.open();
    await settle([race.switching]);
    await waitForCondition(() => race.s.registry.find(race.sessionId) === undefined);
  });

  test("removes the entry and the lock once the released switch settles", async () => {
    const race = await switchThen((registry) => registry.closeAll());
    await withTimeout(race.closing, SETTLE_MS, "closeAll did not resolve");
    race.hand.open();
    await settle([race.switching]);
    await waitForCondition(() => race.s.registry.find(race.sessionId) === undefined);
    await waitForCondition(() => !existsSync(lockFile(race.s, race.sessionId)));
    expect(await locked(race.s, race.sessionId)).toBe(false);
  });

  test("releases the lock exactly once", async () => {
    const race = await switchThen((registry) => registry.closeAll());
    await withTimeout(race.closing, SETTLE_MS, "closeAll did not resolve");
    race.hand.open();
    await settle([race.switching]);
    await waitForCondition(() => !existsSync(lockFile(race.s, race.sessionId)));
    expect(race.s.releases()).toBe(1);
  });
});

describe("close during a settings switch", () => {
  test("a gated model change leaves no session in the registry", async () => {
    const { s, sessionId, hand } = await created();
    const switching = observed(s.registry.setConfigOption(sessionId, "model", "anthropic/claude-haiku-4-5"));
    await waitForCondition(() => s.opened.length === 2);
    expect(s.opened[1]).toMatchObject({ model: "anthropic/claude-haiku-4-5" });
    const closing = observed(s.registry.close(sessionId));
    hand.open();
    await settle([switching, closing]);
    expect(s.registry.find(sessionId)).toBeUndefined();
  });

  test("a switch whose replacement and restore both fail leaves no session in the registry", async () => {
    const race = await switchThen((registry, id) => registry.close(id), { failOpens: [2, 3] });
    race.hand.open();
    await settle([race.switching, race.closing]);
    expect(race.s.opened).toHaveLength(3);
    expect(race.s.registry.find(race.sessionId)).toBeUndefined();
  });

  test("a switch whose replacement and restore both fail releases the lock exactly once", async () => {
    const race = await switchThen((registry, id) => registry.close(id), { failOpens: [2, 3] });
    race.hand.open();
    await settle([race.switching, race.closing]);
    expect(race.s.releases()).toBe(1);
    expect(await locked(race.s, race.sessionId)).toBe(false);
  });
});
