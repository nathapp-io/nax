/**
 * host-full.test.ts — the `MEMORY_FULL` save guard and the index projection behind it.
 *
 * Covers AC-12..AC-17 and AC-19: a save of a new slug refused on a mirror whose index is
 * at its byte cap, an overwrite of an existing slug allowed on that same mirror, the
 * `indexOverflows` hook a save hands `saveMemoryNote` (true when the index rendered with
 * the new note omits entries, false when it does not, and correct for both scopes), and
 * `renderIndex` itself, pinned against the renderer so that moving `readIndex` out of
 * `host.ts` is provably behaviour-neutral.
 *
 * The two projection cases (AC-16, AC-17) are the subtle ones: a boolean cannot show
 * *where* a note was placed, so each builds two renderings — the one the host must produce
 * and the one a scope-blind placement would — and picks a byte cap that fits one and not
 * the other. The cap is derived from the renderer rather than written down, so each case
 * states its own discrimination, and the answer is asserted on both sides of that cap: a
 * hook that ignored the rendering entirely could not answer `false` at the boundary and
 * `true` one byte below it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createMemoryStore,
  MEMORY_INDEX_MIN_BYTES,
  type MemoryDecision,
  type MemoryNote,
  type MemoryNoteWrite,
  type MemorySaveInput,
  type MemorySaveResult,
  type MemoryStore,
  type RenderedMemoryIndex,
  renderMemoryIndex,
  serializeMemoryNote,
} from "@nathapp/nax-agent";
import { assertDefined, cleanupTempDir, type MockLogger, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import { NaxError } from "@/errors";
import { _memoryHostDeps, createMemoryHost, type MemoryHost, memoryDirs } from "@/memory";

/** The byte cap AC-12 and AC-13 pin: the schema's floor, small enough to omit notes. */
const SMALL_INDEX_BYTES = 512;

/** How many project notes the full mirror holds. */
const MANY_NOTES = 60;

/** A cap nothing in these fixtures reaches: used to render one projection whole. */
const ROOMY_BYTES = 262_144;

/** The length every projection fixture fills a line with: the schema's description cap. */
const FULL_DESCRIPTION_CHARS = 200;

/** The slug only the repository holds, which AC-17 has the new note replace. */
const SHARED_SLUG = "shared-slug";

/** A mirror note with the given slug, and whatever else the case needs. */
function noteFor(slug: string, overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: slug,
    slug,
    type: "project",
    scope: "project",
    description: `about ${slug}`,
    source: "nax-chat",
    updatedAt: "2026-11-02T08:00:00Z",
    status: "active",
    body: `body of ${slug}`,
    ...overrides,
  };
}

/** A description long enough to fill an index line: the byte budget is tuned on it. */
function longDescription(marker: string): string {
  return `${marker} ${"x".repeat(FULL_DESCRIPTION_CHARS)}`.slice(0, FULL_DESCRIPTION_CHARS);
}

/** The UTF-8 byte length of a rendering: the unit an index byte cap counts. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Slug order, as the host serves it. */
function bySlug(left: MemoryNote, right: MemoryNote): number {
  return left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0;
}

/** The rejection a promise carries, as the `NaxError` a refused call is expected to throw. */
async function rejection(promise: Promise<unknown>): Promise<NaxError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof NaxError) return error;
    throw error;
  }
  throw new Error("expected the call to reject");
}

/** The write a save tool would hand a host for one note. */
function writeFor(note: MemoryNote): MemoryNoteWrite {
  const { slug, type, scope, description, body } = note;
  return { slug, type, scope, description, body };
}

describe("host index full guard", () => {
  let globalDir: string;
  let repoRoot: string;
  let logger: MockLogger;
  let host: MemoryHost;
  let savedGlobalEnv: string | undefined;
  let originalDeps: typeof _memoryHostDeps;

  /** The mirror the host reads, built from the directories it resolved. */
  function mirror(): MemoryStore {
    return createMemoryStore({ projectDir: host.dirs.projectDir, userDir: host.dirs.userDir, logger });
  }

  /** The mirror for this repository, resolved before any host is opened: the same directories. */
  async function mirrorBeforeHost(): Promise<MemoryStore> {
    const dirs = await memoryDirs({ config: makeNaxConfig(), repoRoot });
    return createMemoryStore({ projectDir: dirs.projectDir, userDir: dirs.userDir, logger });
  }

  /** Commit one repository note under `<repoRoot>/.nax/memory`, from the note it describes. */
  function writeRepoNote(note: MemoryNote): void {
    const dir = join(repoRoot, ".nax", "memory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${note.slug}.md`), serializeMemoryNote(note));
  }

  /**
   * Put `count` notes in the mirror in one pass, as `<notesDir>/<slug>.md` files.
   *
   * A `store.writeNote` pins the notes directory by spawning a worker process and proving
   * the pinned identity, so a bulk fixture of 60 writes would be 60 processes. The caps are
   * what these cases assert and the notes are only the input to them, so they are written
   * here through the store's own serializer and read back through the store the host builds.
   */
  function seedMirrorNotes(count: number): void {
    const notesDir = mirror().paths.notesDir;
    mkdirSync(notesDir, { recursive: true });
    for (let index = 1; index <= count; index += 1) {
      const note = noteFor(`note-${String(index).padStart(2, "0")}`);
      writeFileSync(join(notesDir, `${note.slug}.md`), serializeMemoryNote(note));
    }
  }

  /** Open the host under test, with whatever config the case needs. */
  async function openHost(config = makeNaxConfig()): Promise<void> {
    const created = await createMemoryHost({ config, repoRoot, source: "nax-chat", logger });
    assertDefined(created, "the memory host");
    host = created;
  }

  /**
   * The `indexOverflows` one save hands `saveMemoryNote`, captured without writing.
   *
   * The save operation is stubbed, so what is under test is the hook the host passes rather
   * than the write behind it — and the hook is then called with the note the save described,
   * exactly as the operation calls it for a slug the mirror does not hold.
   */
  async function saveHookFor(note: MemoryNote): Promise<(candidate: MemoryNote) => Promise<boolean>> {
    let captured: MemorySaveInput | undefined;
    _memoryHostDeps.saveMemoryNote = async (input): Promise<MemorySaveResult> => {
      captured = input;
      return { slug: input.write.slug, status: "active", delivered: false };
    };
    await host.save(writeFor(note));
    assertDefined(captured, "the saveMemoryNote call");
    const hook = captured.indexOverflows;
    assertDefined(hook, "the indexOverflows host.save passes");
    return hook;
  }

  /** Run one save's hook on a host opened with `indexBytes: cap`. */
  async function hookAtCap(cap: number, note: MemoryNote): Promise<(candidate: MemoryNote) => Promise<boolean>> {
    await openHost(makeNaxConfig({ memory: { indexBytes: cap } }));
    return await saveHookFor(note);
  }

  /** One rendering of a projection, whole: the byte length is what a cap is chosen against. */
  function rendering(input: {
    readonly projectNotes: readonly MemoryNote[];
    readonly userNotes: readonly MemoryNote[];
    readonly decisions?: readonly MemoryDecision[];
  }): RenderedMemoryIndex {
    return renderMemoryIndex({
      projectNotes: [...input.projectNotes].sort(bySlug),
      userNotes: [...input.userNotes].sort(bySlug),
      decisions: input.decisions ?? [],
      maxBytes: ROOMY_BYTES,
    });
  }

  /**
   * The cap at which `shorter` fits and `longer` does not: the shorter text's own byte length.
   *
   * A fixture is only discriminating while the two renderings differ by at least a byte and
   * the cap is above the floor the renderer clamps to, so both are asserted here rather than
   * assumed — one byte below the cap is where the other side of the boundary is asserted.
   */
  function capBetween(shorter: RenderedMemoryIndex, longer: RenderedMemoryIndex): number {
    const cap = byteLength(shorter.text);
    expect(cap).toBeGreaterThan(MEMORY_INDEX_MIN_BYTES);
    expect(byteLength(longer.text)).toBeGreaterThan(cap);
    return cap;
  }

  beforeEach(() => {
    globalDir = makeTempDir("nax-host-full-global-");
    repoRoot = makeTempDir("nax-host-full-repo-");
    logger = makeLogger();
    savedGlobalEnv = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
    originalDeps = { ..._memoryHostDeps };
  });

  afterEach(() => {
    _memoryHostDeps.saveMemoryNote = originalDeps.saveMemoryNote;
    if (savedGlobalEnv === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = savedGlobalEnv;
    }
    cleanupTempDir(globalDir);
    cleanupTempDir(repoRoot);
  });

  test("AC-12 refuses a save of a new slug when the index is at its byte cap", async () => {
    await openHost(makeNaxConfig({ memory: { indexBytes: SMALL_INDEX_BYTES } }));
    seedMirrorNotes(MANY_NOTES);

    const error = await rejection(host.save(writeFor(noteFor("brand-new"))));

    expect({ code: error.code, stored: await host.getNote("project", "brand-new") }).toEqual({
      code: "MEMORY_FULL",
      stored: null,
    });
  });

  test("AC-13 saves over an existing slug on that same mirror", async () => {
    await openHost(makeNaxConfig({ memory: { indexBytes: SMALL_INDEX_BYTES } }));
    seedMirrorNotes(MANY_NOTES);

    await expect(host.save(writeFor(noteFor("note-01")))).resolves.toMatchObject({ slug: "note-01" });
  });

  test("AC-14 the hook resolves true when the index with the new note omits entries", async () => {
    await openHost(makeNaxConfig({ memory: { indexBytes: SMALL_INDEX_BYTES } }));
    seedMirrorNotes(MANY_NOTES);
    const hook = await saveHookFor(noteFor("brand-new"));

    expect(await hook(noteFor("brand-new"))).toBe(true);
  });

  test("AC-15 the hook resolves false when the index with the new note omits none", async () => {
    await openHost();
    const hook = await saveHookFor(noteFor("recorded-budget"));

    expect(await hook(noteFor("recorded-budget"))).toBe(false);
  });

  test("AC-16 for a user-scope save the hook renders the note in the user scope's list", async () => {
    // The mirror's own notes are user-scope, so an index near its cap needs no `## Project`
    // section at all: a note placed in the project list would open one, and that heading is
    // exactly the extra text a scope-blind placement has to pay for.
    const userNotes = [
      noteFor("tone", { scope: "user", type: "user", description: longDescription("tone") }),
      noteFor("style", { scope: "user", type: "user", description: longDescription("style") }),
    ];
    const newNote = noteFor("house-style", { scope: "user", type: "user", description: longDescription("house") });
    const store = await mirrorBeforeHost();
    for (const note of userNotes) await store.writeNote(note);
    const inUser = rendering({ projectNotes: [], userNotes: [...userNotes, newNote] });
    const inProject = rendering({ projectNotes: [newNote], userNotes });
    const cap = capBetween(inUser, inProject);

    const atCap = await hookAtCap(cap, newNote);
    const underCap = await hookAtCap(cap - 1, newNote);

    expect([await atCap(newNote), await underCap(newNote)]).toEqual([false, true]);
  });

  test("AC-17 for a project-scope save of a repository note's slug the hook replaces that note", async () => {
    const repoNote = noteFor(SHARED_SLUG, { description: longDescription("team note"), source: "repo" });
    const filler = noteFor("filler", { description: longDescription("filler") });
    const newNote = noteFor(SHARED_SLUG, { description: longDescription("mirror note") });
    const store = await mirrorBeforeHost();
    await store.writeNote(filler);
    writeRepoNote(repoNote);
    const inPlace = rendering({ projectNotes: [filler, newNote], userNotes: [] });
    const beside = rendering({ projectNotes: [filler, repoNote, newNote], userNotes: [] });
    const cap = capBetween(inPlace, beside);

    const atCap = await hookAtCap(cap, newNote);
    const underCap = await hookAtCap(cap - 1, newNote);

    expect([await atCap(newNote), await underCap(newNote)]).toEqual([false, true]);
  });

  test("AC-19 renderIndex is the renderer's own answer for both scopes, the decisions and the repository note", async () => {
    await openHost();
    const projectNotes = [noteFor("alpha"), noteFor("beta", { type: "reference" })];
    const userNotes = [noteFor("tone", { scope: "user", type: "user" })];
    const repoNote = noteFor("staging-db", { description: "the staging database is shared; never reset it" });
    const decisions: readonly MemoryDecision[] = [
      {
        id: "d1",
        subject: "replay budget",
        predicate: "is",
        object: "2048 MiB",
        updatedAt: "2026-11-02T08:00:00Z",
        status: "active",
      },
    ];
    for (const note of projectNotes) await mirror().writeNote(note);
    for (const note of userNotes) await mirror().writeNote(note);
    await mirror().writeDecisions(decisions);
    writeRepoNote(repoNote);

    const index = await host.renderIndex();

    const expected = rendering({ projectNotes: [...projectNotes, repoNote], userNotes, decisions });
    expect(index).toEqual(expected);
    expect(index.omitted).toBe(0);
    expect({
      project: index.text.includes("## Project"),
      decisions: index.text.includes("## Decisions"),
      user: index.text.includes("## User"),
      repo: index.text.includes("staging-db"),
    }).toEqual({ project: true, decisions: true, user: true, repo: true });
  });
});
