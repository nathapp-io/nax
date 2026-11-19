/**
 * US-008: the bot's own unsettled blocking finding threads, read the way readiness reads them.
 *
 * A finding thread is not an item: nothing writes it to the PR's item index, so `nax workflow status`
 * counted no open item while three Important findings held the PR (#2981). These tests drive the
 * reader that adds them: identity is the opener's author, the marker only names the key, settlement is
 * the readiness reader's own answer, and the blocking set is the per-PR effective one.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  _blockingThreadsDeps,
  type BlockingFindingThreadsInput,
  readBlockingFindingThreads,
} from "@/bot/blocking-threads";
import { withNaxBotMarker } from "@/forge";
import type { PrComment, PrThread } from "@/forge/pr-types";
import { DEFAULT_BLOCKING_TRIGGERS, type FindingTrigger } from "@/workflow/blocking-findings";

const NOW = "2026-11-20T09:00:00Z";
const LOGIN = "nax";
const KEY = "f-abc";
const PATH = "packages/nax/src/action-file.ts";
const LINE = 42;

const original = { ..._blockingThreadsDeps };
const access = mock(async (..._args: Parameters<typeof _blockingThreadsDeps.hasWriteAccess>) => true);
const settled = mock(async (..._args: Parameters<typeof _blockingThreadsDeps.readSettledKeys>) => new Set<string>());
const logger = { warn: mock(() => {}) };

/** One forge comment; `kind: "thread"` is how a review thread's own comments arrive. */
const comment = (id: string, body: string, author = LOGIN): PrComment => ({
  id,
  kind: "thread",
  author,
  body,
  createdAt: NOW,
});

/** The body a bot finding carries: the generated header, the labelled issue, the marker. */
const findingBody = (text: string, key = KEY): string => withNaxBotMarker(text, key);

interface ThreadOptions {
  readonly body?: string;
  readonly author?: string;
  readonly key?: string;
  readonly resolved?: boolean;
}

function findingThread(options: ThreadOptions = {}): PrThread {
  const key = options.key ?? KEY;
  return {
    id: "thread-1",
    replyTo: "1",
    path: PATH,
    line: LINE,
    resolved: options.resolved ?? false,
    outdated: false,
    comments: [
      comment("1", options.body ?? findingBody("**Important** (quality): lock leaks", key), options.author ?? LOGIN),
    ],
  };
}

function input(overrides: Partial<BlockingFindingThreadsInput> = {}): BlockingFindingThreadsInput {
  return {
    ref: { forge: "github", host: "github.com", repo: "o/r", number: 7 },
    threads: [findingThread()],
    comments: [],
    login: LOGIN,
    configured: DEFAULT_BLOCKING_TRIGGERS,
    deps: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }), readText: async () => null },
    cwd: "/checkout",
    ...overrides,
  };
}

/** A top-level PR comment, the only kind that can rule this PR's blocking scope. */
const scopeRuling = (body: string, author = "alice"): PrComment => ({
  id: "c1",
  kind: "comment",
  author,
  body,
  createdAt: NOW,
});

beforeEach(() => {
  for (const fn of [access, settled]) fn.mockClear();
  access.mockImplementation(async () => true);
  settled.mockImplementation(async () => new Set<string>());
  logger.warn.mockClear();
  Object.assign(_blockingThreadsDeps, {
    hasWriteAccess: access,
    readSettledKeys: settled,
    getLogger: () => logger,
  });
});
afterEach(() => Object.assign(_blockingThreadsDeps, original));

describe("readBlockingFindingThreads", () => {
  test("AC-1 returns the own unresolved blocking finding with its path, line and issue", async () => {
    const items = await readBlockingFindingThreads(input());
    expect(items).toEqual([
      { id: KEY, kind: "finding", severity: "important", file: PATH, line: LINE, issue: "bot review: lock leaks" },
    ]);
  });

  test("AC-2 leaves out a resolved own finding thread", async () => {
    expect(await readBlockingFindingThreads(input({ threads: [findingThread({ resolved: true })] }))).toEqual([]);
  });

  test("AC-3 leaves out a finding thread whose key readiness reports as settled", async () => {
    settled.mockImplementation(async () => new Set([KEY]));
    expect(await readBlockingFindingThreads(input())).toEqual([]);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  test("AC-4 leaves out an own adversarial finding under the default set", async () => {
    const body = findingBody(
      "**Important** (quality): lock leaks\n\nTrigger: adversarial - a second writer raced the lock",
    );
    expect(await readBlockingFindingThreads(input({ threads: [findingThread({ body })] }))).toEqual([]);
  });

  test("AC-5 leaves out an own minor finding thread", async () => {
    const body = findingBody("**Minor** (quality): lock leaks");
    expect(await readBlockingFindingThreads(input({ threads: [findingThread({ body })] }))).toEqual([]);
  });

  test("AC-6 leaves out another author's thread and an own workflow item key", async () => {
    const foreign = findingThread({ author: "mallory" });
    const item = findingThread({ key: "w-US-001.1a2b3c4d" });
    expect(await readBlockingFindingThreads(input({ threads: [foreign, item] }))).toEqual([]);
  });

  test("AC-7 includes an adversarial finding when a writer ruled the PR's scope to include it", async () => {
    const body = findingBody(
      "**Important** (quality): lock leaks\n\nTrigger: adversarial - a second writer raced the lock",
    );
    const items = await readBlockingFindingThreads(
      input({
        threads: [findingThread({ body })],
        comments: [scopeRuling("blocking triggers: normal, adversarial")],
        configured: ["normal", "own-concurrency"] satisfies readonly FindingTrigger[],
      }),
    );
    expect(items).toEqual([
      { id: KEY, kind: "finding", severity: "important", file: PATH, line: LINE, issue: "bot review: lock leaks" },
    ]);
  });

  test("a scope ruling from a non-writer changes nothing", async () => {
    const body = findingBody(
      "**Important** (quality): lock leaks\n\nTrigger: adversarial - a second writer raced the lock",
    );
    access.mockImplementation(async () => false);
    expect(
      await readBlockingFindingThreads(
        input({
          threads: [findingThread({ body })],
          comments: [scopeRuling("blocking triggers: normal, adversarial")],
        }),
      ),
    ).toEqual([]);
  });

  test("reads the severity through the generated header and marker", async () => {
    const body = findingBody("**Critical** (quality): lock leaks\n\nTrigger: normal");
    const items = await readBlockingFindingThreads(input({ threads: [findingThread({ body })] }));
    expect(items.map((item) => item.severity)).toEqual(["critical"]);
  });

  test("a thread with no path or line still reports the finding", async () => {
    const thread = { ...findingThread(), path: undefined, line: undefined };
    const items = await readBlockingFindingThreads(input({ threads: [thread] }));
    expect(items).toEqual([{ id: KEY, kind: "finding", severity: "important", issue: "bot review: lock leaks" }]);
  });

  test("an own thread with no marker key is not a finding", async () => {
    const thread = { ...findingThread(), comments: [comment("1", "**Important** (quality): lock leaks")] };
    expect(await readBlockingFindingThreads(input({ threads: [thread] }))).toEqual([]);
  });

  test("reads no settlement and asks no permission when there is no own finding thread", async () => {
    expect(await readBlockingFindingThreads(input({ threads: [findingThread({ author: "mallory" })] }))).toEqual([]);
    expect(settled).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
  });
});
