/**
 * memory-compact-offer.test.ts — the one compaction decision a chat session is offered.
 *
 * The offer is four behaviours in one object, and each case pins one of them: when the
 * question is raised at all (a nearly-full index, an attached ask controller, an observed
 * host), what the two cards say, what a single flight and the session suppression mean,
 * and how a save observes it without ever failing the save.
 *
 * Nothing here runs a real compaction or boots a runtime: `_memoryCompactOfferDeps` is
 * stubbed for every case, and the host double answers only the three members the offer
 * reads — the index, the project notes and `save`.
 *
 * Two numbers are deliberate. The index is 900 bytes under a 1000-byte cap, so the fill is
 * 90% against a threshold of 80%: a card that reads "90% full" proves the measured fill was
 * used rather than the threshold. And the config's `name` differs from the repository root's
 * basename, so the card's "<project>" proves `getProjectKey` was consulted.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { MemoryNote, MemoryNoteWrite, MemorySaveResult, RenderedMemoryIndex } from "@nathapp/nax-agent";
import {
  compactNote,
  type MockLogger,
  makeFakeMemoryHost,
  makeLogger,
  makeNaxConfig,
  waitForAsyncCondition,
  withDepsRestore,
} from "@test/helpers";
import { type ChatAskController, createChatAskController, type HostChoiceAsk } from "@/chat/ask-controller";
import {
  _memoryCompactOfferDeps,
  createMemoryCompactOffer,
  type MemoryCompactOffer,
} from "@/chat/memory-compact-offer";
import type { CompactProjectMemoryInput, MemoryCompactOutcome, MemoryCompactPreview, MemoryHost } from "@/memory";

/** The config every case runs under: a 1000-byte cap and an 80% threshold that is not 0.9. */
const CONFIG = makeNaxConfig({ name: "nax-offer", memory: { indexBytes: 1000, compact: { threshold: 0.8 } } });

/** A repository root whose basename is *not* the project key, so the card proves `getProjectKey`. */
const REPO_ROOT = "/repo/some-other-basename";

/** The 900 bytes that make the index 90% full. */
const NEARLY_FULL_INDEX: RenderedMemoryIndex = { text: "x".repeat(900), omitted: 0 };

/** A hundred bytes: 10% full, well below the threshold. */
const ROOMY_INDEX: RenderedMemoryIndex = { text: "x".repeat(100), omitted: 0 };

/** The three project notes the host lists, which is the count the card names. */
const PROJECT_NOTES: readonly MemoryNote[] = [compactNote("alpha"), compactNote("beta"), compactNote("gamma")];

/** One save a case makes through the host `observe` returned. */
const WRITE: MemoryNoteWrite = {
  slug: "saved",
  type: "project",
  scope: "project",
  description: "a save",
  body: "body",
};

/** What the stubbed host answers a save with. */
const SAVE_RESULT: MemorySaveResult = { slug: "saved", status: "active", delivered: true };

/** The preview a stubbed compaction is handed; the offer's own confirm ignores it. */
const PREVIEW: MemoryCompactPreview = {
  plan: { retire: [{ slug: "alpha", reason: "it shipped" }], merge: [] },
  fillBefore: 0.9,
  notesBefore: 3,
  notesAfter: 2,
};

/**
 * An applied compaction whose four counts are all distinct — 2 retired, 3 merged into 1 —
 * so a summary that swapped any two of them could not match.
 */
const APPLIED: MemoryCompactOutcome = {
  kind: "applied",
  preview: PREVIEW,
  result: {
    id: "20261125T101500Z-3fa2c1",
    retired: ["alpha", "beta"],
    merged: [{ from: ["gamma", "delta", "epsilon"], into: "gamma" }],
    notesBefore: 5,
    notesAfter: 1,
  },
  fillAfter: 0.41,
};

/** What {@link APPLIED} reads as, spelled once. */
const APPLIED_SUMMARY =
  "Compacted memory: retired 2, merged 3 into 1 (90% -> 41%). Undo: nax memory undo 20261125T101500Z-3fa2c1";

/** What the compaction's own confirm was asked, and what it answered. */
interface ConfirmRecord {
  answer: boolean | undefined;
  cardsBefore: number;
  cardsAfter: number;
}

interface FixtureOptions {
  readonly index?: RenderedMemoryIndex;
  readonly notes?: readonly MemoryNote[];
  /** When set, `renderIndex` rejects with it. */
  readonly renderThrows?: Error;
  readonly outcome?: MemoryCompactOutcome;
  /** When set, `compactProjectMemory` rejects with it. */
  readonly compactThrows?: Error;
  /** `false` leaves the offer unattached, which is the no-ask path. */
  readonly attach?: boolean;
  /** Holds the compaction open, so a case can look at the chat between the two cards. */
  readonly compactGate?: Promise<void>;
  /** Replaces the stubbed host's save, for the rejecting case. */
  readonly save?: (write: MemoryNoteWrite) => Promise<MemorySaveResult>;
}

interface Fixture {
  readonly offer: MemoryCompactOffer;
  readonly asks: ChatAskController;
  readonly logger: MockLogger;
  /** The host handed to `observe`. */
  readonly raw: MemoryHost;
  /** What `observe` returned: the host the chat's own surfaces hold. */
  readonly host: MemoryHost;
  /** What happened, in order: "save" and "render". */
  readonly order: string[];
  readonly renderIndex: ReturnType<typeof mock>;
  readonly compact: ReturnType<typeof mock>;
  /** What the offer handed the compaction's own confirm, and what it answered. */
  readonly confirmRecord: ConfirmRecord;
}

const controllers: ChatAskController[] = [];

afterEach(() => {
  for (const asks of controllers.splice(0)) asks.reset();
});

/** The offer, its asks, its logger and the host it observes, composed once per case. */
function fixture(options: FixtureOptions = {}): Fixture {
  const order: string[] = [];
  const logger = makeLogger();
  const asks = createChatAskController({ mode: "full", answer: () => {} });
  controllers.push(asks);
  const renderIndex = mock(async () => {
    order.push("render");
    if (options.renderThrows) throw options.renderThrows;
    return options.index ?? NEARLY_FULL_INDEX;
  });
  const notes = mock(async () => options.notes ?? PROJECT_NOTES);
  const save =
    options.save ??
    (async () => {
      order.push("save");
      return SAVE_RESULT;
    });
  const raw: MemoryHost = {
    ...makeFakeMemoryHost("the offer reads only the index, the project notes and save"),
    renderIndex,
    notes,
    save,
  };
  const confirmRecord: ConfirmRecord = { answer: undefined, cardsBefore: -1, cardsAfter: -1 };
  const compact = mock(async (input: CompactProjectMemoryInput) => {
    confirmRecord.cardsBefore = asks.pending().length;
    confirmRecord.answer = await input.confirm(PREVIEW);
    confirmRecord.cardsAfter = asks.pending().length;
    if (options.compactGate !== undefined) await options.compactGate;
    if (options.compactThrows) throw options.compactThrows;
    return options.outcome ?? APPLIED;
  });
  _memoryCompactOfferDeps.compactProjectMemory = compact;
  const offer = createMemoryCompactOffer({ config: CONFIG, repoRoot: REPO_ROOT, logger });
  const host = offer.observe(raw);
  if (options.attach !== false) offer.attach(asks);
  return { offer, asks, logger, raw, host, order, renderIndex, compact, confirmRecord };
}

/** The open host-choice cards, waiting until at least one is up. */
async function choiceCards(asks: ChatAskController): Promise<readonly HostChoiceAsk[]> {
  return await waitForAsyncCondition(
    async () => asks.pending().filter((ask): ask is HostChoiceAsk => ask.type === "host_choice"),
    (cards) => cards.length > 0,
  );
}

/** The one open host-choice card. */
async function choiceCard(asks: ChatAskController): Promise<HostChoiceAsk> {
  const cards = await choiceCards(asks);
  const card = cards[0];
  if (card === undefined) throw new Error("no host choice card");
  return card;
}

/** A host-choice card's id, for the resolution a case makes. */
function idOf(card: HostChoiceAsk | undefined): string {
  if (card === undefined) throw new Error("no host choice card");
  return card.requestId;
}

/** Answer the ask card with `compact`, dismiss the result card it produces, and settle the check. */
async function compactAndDismiss(f: Fixture, running: Promise<void>): Promise<void> {
  const asked = await choiceCard(f.asks);
  f.asks.resolveChoice(asked.requestId, "compact");
  const results = await choiceCards(f.asks);
  f.asks.resolveChoice(idOf(results[0]), "ok");
  await running;
}

describe("createMemoryCompactOffer", () => {
  withDepsRestore(_memoryCompactOfferDeps);

  // AC-1
  test("AC-1 check without an attached asks resolves and never reads the index", async () => {
    const f = fixture({ attach: false });

    await f.offer.check();

    expect(f.renderIndex).not.toHaveBeenCalled();
    expect(f.asks.pending()).toEqual([]);
    expect(f.compact).not.toHaveBeenCalled();
  });

  // AC-2
  test("AC-2 a roomy index reads the index and asks nothing", async () => {
    const f = fixture({ index: ROOMY_INDEX });

    await f.offer.check();

    expect(f.renderIndex).toHaveBeenCalledTimes(1);
    expect(f.asks.pending()).toEqual([]);
    expect(f.compact).not.toHaveBeenCalled();
  });

  // AC-3 (guard): the offer asks the shared nearly-full rule, so an index already dropping
  // entries is nearly full whatever its measured fill is.
  test("AC-3 an index with omitted entries is offered even at a low measured fill", async () => {
    const f = fixture({ index: { text: "x".repeat(100), omitted: 2 } });

    const running = f.offer.check();
    const card = await choiceCard(f.asks);

    expect(card.tool).toBe("nax-memory-compact");
    expect(card.summary).toBe("Memory for nax-offer is 10% full (3 notes). Compact now?");

    f.asks.resolveChoice(card.requestId, "later");
    await running;
  });

  // AC-3
  test("AC-3 a nearly-full index asks one host choice with the compact/later card", async () => {
    const f = fixture();

    const running = f.offer.check();
    const cards = await choiceCards(f.asks);

    expect(cards).toHaveLength(1);
    expect(cards[0]?.tool).toBe("nax-memory-compact");
    expect(cards[0]?.choices.map((choice) => choice.id)).toEqual(["compact", "later"]);
    expect(cards[0]?.fallback).toBe("later");

    f.asks.resolveChoice(idOf(cards[0]), "later");
    await running;
  });

  // AC-4
  test("AC-4 the card names the project, the measured fill and the project note count", async () => {
    const f = fixture();

    const running = f.offer.check();
    const card = await choiceCard(f.asks);

    expect(card.summary).toBe("Memory for nax-offer is 90% full (3 notes). Compact now?");

    f.asks.resolveChoice(card.requestId, "later");
    await running;
  });

  // AC-4's other half: the count is what the host lists, not the candidates and not the index.
  test("AC-4 the note count follows the host's project notes", async () => {
    const f = fixture({ notes: [compactNote("only-one")] });

    const running = f.offer.check();
    const card = await choiceCard(f.asks);

    expect(card.summary).toBe("Memory for nax-offer is 90% full (1 notes). Compact now?");

    f.asks.resolveChoice(card.requestId, "later");
    await running;
  });

  // AC-5
  test("AC-5 choosing compact compacts once, for this config, repository and host", async () => {
    const f = fixture();

    const running = f.offer.check();
    await compactAndDismiss(f, running);

    expect(f.compact).toHaveBeenCalledTimes(1);
    const input = f.compact.mock.calls[0]?.[0];
    expect(input?.config).toBe(CONFIG);
    expect(input?.repoRoot).toBe(REPO_ROOT);
    expect(input?.host).toBe(f.raw);
    expect(input?.dryRun).toBe(false);
  });

  // AC-6
  test("AC-6 the confirm it is handed answers true and opens no card of its own", async () => {
    const f = fixture();

    const running = f.offer.check();
    await compactAndDismiss(f, running);

    expect(f.confirmRecord.answer).toBe(true);
    expect(f.confirmRecord.cardsBefore).toBe(0);
    expect(f.confirmRecord.cardsAfter).toBe(0);
  });

  // AC-7
  test("AC-7 an applied compaction reports one result card carrying the undo line", async () => {
    const f = fixture();

    const running = f.offer.check();
    const asked = await choiceCard(f.asks);
    f.asks.resolveChoice(asked.requestId, "compact");
    const results = await choiceCards(f.asks);

    expect(results).toHaveLength(1);
    expect(results[0]?.summary).toBe(APPLIED_SUMMARY);
    expect(results[0]?.choices.map((choice) => choice.id)).toEqual(["ok"]);

    f.asks.resolveChoice(idOf(results[0]), "ok");
    await running;
  });

  // AC-8
  test("AC-8 answering later suppresses the offer for the rest of the session", async () => {
    const f = fixture();

    const running = f.offer.check();
    const card = await choiceCard(f.asks);
    f.asks.resolveChoice(card.requestId, "later");
    await running;

    await f.offer.check();

    expect(f.asks.pending()).toEqual([]);
    expect(f.compact).not.toHaveBeenCalled();
  });

  // AC-9
  test("AC-9 one applied compaction suppresses a later check", async () => {
    const f = fixture();

    const running = f.offer.check();
    const asked = await choiceCard(f.asks);
    f.asks.resolveChoice(asked.requestId, "compact");
    const results = await choiceCards(f.asks);
    f.asks.resolveChoice(idOf(results[0]), "ok");
    await running;

    await f.offer.check();

    expect(f.asks.pending()).toEqual([]);
    expect(f.compact).toHaveBeenCalledTimes(1);
  });

  // AC-10
  test("AC-10 one compaction attempt that did not apply suppresses a later check", async () => {
    const f = fixture({ outcome: { kind: "declined", preview: PREVIEW } });

    const running = f.offer.check();
    const card = await choiceCard(f.asks);
    f.asks.resolveChoice(card.requestId, "compact");
    await running;

    await f.offer.check();

    expect(f.asks.pending()).toEqual([]);
    expect(f.compact).toHaveBeenCalledTimes(1);
  });

  // AC-11
  test("AC-11 two check calls started together share one host choice", async () => {
    const f = fixture();

    const first = f.offer.check();
    const second = f.offer.check();
    const cards = await choiceCards(f.asks);

    expect(cards).toHaveLength(1);
    expect(f.renderIndex).toHaveBeenCalledTimes(1);

    f.asks.resolveChoice(idOf(cards[0]), "later");
    await Promise.all([first, second]);
  });

  // AC-12
  test("AC-12 a compaction that throws warns once and leaves check resolved", async () => {
    const f = fixture({ compactThrows: new Error("MEMORY_BUSY: a sync is in flight") });

    const running = f.offer.check();
    const card = await choiceCard(f.asks);
    f.asks.resolveChoice(card.requestId, "compact");

    await expect(running).resolves.toBeUndefined();
    expect(f.logger.warn).toHaveBeenCalledTimes(1);
  });

  // AC-13, AC-14
  test.each([
    ["unparseable", { kind: "unparseable" }],
    ["unsupported", { kind: "unsupported" }],
    ["nothing-to-compact", { kind: "nothing-to-compact", fill: 0.9 }],
    ["invalid", { kind: "invalid", reasons: ['merge into "x": a merge needs at least 2 sources, it lists 1'] }],
    ["declined", { kind: "declined", preview: PREVIEW }],
    ["dry-run", { kind: "dry-run", preview: PREVIEW }],
  ] as readonly [string, MemoryCompactOutcome][])(
    "AC-13 AC-14 a %s outcome warns once naming it and shows no result card",
    async (kind, outcome) => {
      const f = fixture({ outcome });

      const running = f.offer.check();
      const card = await choiceCard(f.asks);
      f.asks.resolveChoice(card.requestId, "compact");
      await running;

      expect(f.logger.warn).toHaveBeenCalledTimes(1);
      const warn = f.logger.calls.find((call) => call.level === "warn");
      expect(warn?.stage).toBe("chat");
      expect(`${warn?.message} ${JSON.stringify(warn?.data)}`).toContain(kind);
      expect(f.asks.pending()).toEqual([]);
    },
  );

  // AC-15
  test("AC-15 a save resolves with the host's result while the check is still running", async () => {
    const gate = Promise.withResolvers<void>();
    const f = fixture({ compactGate: gate.promise });

    const saving = f.host.save(WRITE);
    const card = await choiceCard(f.asks);
    f.asks.resolveChoice(card.requestId, "compact");
    await waitForAsyncCondition(
      async () => f.compact.mock.calls.length,
      (calls) => calls === 1,
    );

    expect(await saving).toEqual(SAVE_RESULT);
    // The compaction is still held open, so the check cannot have settled: no result card yet.
    expect(f.asks.pending()).toEqual([]);

    gate.resolve();
    expect(await choiceCards(f.asks)).toHaveLength(1);
  });

  // AC-16
  test("AC-16 a successful save triggers one check, after the save resolved", async () => {
    const f = fixture({ index: ROOMY_INDEX });

    expect(await f.host.save(WRITE)).toEqual(SAVE_RESULT);
    await waitForAsyncCondition(
      async () => f.renderIndex.mock.calls.length,
      (calls) => calls === 1,
    );

    expect(f.renderIndex).toHaveBeenCalledTimes(1);
    expect(f.order).toEqual(["save", "render"]);
  });

  // AC-17
  test("AC-17 a rejected save rejects with the same error and checks nothing", async () => {
    const rejected = new Error("MEMORY_BUSY: a sync is in flight");
    const f = fixture({
      save: async () => {
        throw rejected;
      },
    });

    await expect(f.host.save(WRITE)).rejects.toBe(rejected);
    // Two ticks, so a check fired from the save's rejection path would have started.
    await Promise.resolve();
    await Promise.resolve();

    expect(f.renderIndex).not.toHaveBeenCalled();
  });

  // AC-18
  test("AC-18 a check that fails never rejects the save that triggered it", async () => {
    const f = fixture({ renderThrows: new Error("the index cannot be rendered") });

    expect(await f.host.save(WRITE)).toEqual(SAVE_RESULT);
    await waitForAsyncCondition(
      async () => f.logger.calls.length,
      (calls) => calls > 0,
    );

    expect(f.logger.warn).toHaveBeenCalledTimes(1);
    expect(f.asks.pending()).toEqual([]);
  });

  // AC-18's other half: the check itself resolves rather than rejecting, so an unawaited
  // `check()` from the chat's start-up cannot become an unhandled rejection.
  test("check resolves and warns once when the index cannot be read", async () => {
    const f = fixture({ renderThrows: new Error("the index cannot be rendered") });

    await expect(f.offer.check()).resolves.toBeUndefined();
    expect(f.logger.warn).toHaveBeenCalledTimes(1);
  });
});
