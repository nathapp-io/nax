/**
 * The `@` picker's claim on the keys, and the state its view draws.
 *
 * The picker sits under the prompt like the slash menu and owns the same five keys while the
 * mention being typed keeps at least one row: up and down move the pointer, tab and return
 * apply the selected row through the input's handle, and escape puts the picker away until the
 * prompt next changes. Nothing else — a shifted key stays with the viewport, a ctrl chord with
 * the screen, and typing with the editor.
 *
 * The claim is read at key time, never from the last render, for the same reason the slash
 * menu's is: a terminal delivers several keys before React redraws, and after a tab has written
 * a folder into the prompt the return that follows must complete that folder's file rather than
 * submit the line. That is also why this hook, and not the view, subscribes to the keys: a
 * picker that only mounts after a render cannot own the batch delivered before it. For the same
 * reason the rows a `get()` last resolved stay claimable while the next listing is in flight —
 * an index that has already answered is asked again, and its previous answer is what the keys
 * of that batch act on.
 *
 * Two keys of one batch both run before the re-render that would show the first one's move, so
 * every handler reads the pointer and the prompt from refs rather than from the render. An
 * apply or a dismissal also holds the claim for the rest of that batch: the input reads the
 * same claim, and a return delivered after a row was applied must not also submit the line the
 * row wrote. That hold is dropped by an effect, which React runs after the re-render the batch
 * produced, so the next key sees a claim that matches what is drawn.
 */
import { type Key, useInput } from "ink";
import { type RefObject, useEffect, useRef, useState } from "react";
import type { MentionFileIndex, MentionFileList, MentionFileRow } from "@/chat";
import { menuRowsFor } from "./bottom-region";
import type { ChatInputHandle } from "./ChatInput";
import type { EditorState } from "./line-editor";
import { applyMentionRow, filterMentionRows, type MentionQuery, mentionQueryAt } from "./mention-menu";
import { SLASH_MENU_MAX_ROWS } from "./slash-menu";

/** The pointer's first row: every new query starts there, as the slash menu's does. */
const FIRST_ROW = 0;

/** The answer a listing that threw reduces to: nothing to offer, and git's own line says why. */
const NO_LIST: MentionFileList = { git: false, rows: [] };

/** A mention being typed and the rows the loaded list keeps for it — what one key acts on. */
interface MentionClaim {
  readonly at: MentionQuery;
  readonly matches: readonly MentionFileRow[];
}

/** The pointer's row, and the query's list it was placed in. */
interface Pointer {
  readonly query: string;
  readonly index: number;
}

/** What the picker remembers between renders and inside one batch of keys. */
interface LivePicker {
  /** The prompt as the newest key left it — a batch has not re-rendered yet. */
  editor: EditorState;
  /** The prompt text an escape put the picker away at; the picker reopens when it changes. */
  dismissed: string | undefined;
  /** The list `get()` last resolved, or undefined until it first answers. */
  listed: MentionFileList | undefined;
  pointer: Pointer;
  /** True once the picker has acted on a key of the batch being delivered. */
  acted: boolean;
}

/** What the picker draws for one render. */
export interface MentionMenuView {
  /** The rows the query keeps, best first. */
  readonly matches: readonly MentionFileRow[];
  /** The pointer's index into `matches`. */
  readonly selected: number;
  /** True when git could not answer: the picker draws its diagnostic line, not rows. */
  readonly noGit: boolean;
  /** The rows the picker occupies in the bottom region; zero when it draws nothing. */
  readonly rows: number;
}

/** A picker with nothing to draw: no query, no rows, no listing, or another surface first. */
const NO_VIEW: MentionMenuView = { matches: [], selected: FIRST_ROW, noGit: false, rows: 0 };

/** The keys the picker takes while it is shown, and no others. */
function ownsMentionKey(key: Key): boolean {
  return Boolean(key.escape || key.tab || key.return || key.upArrow || key.downArrow);
}

export interface MentionMenuOptions {
  /** The directory the file list is read from: the screen's own cwd. */
  readonly cwd: string;
  /** How a file list is built; the screen's seam, sampled once when the screen mounted. */
  readonly indexFor: (cwd: string) => MentionFileIndex;
  /** The prompt as this render shows it; a key reads the live one instead. */
  readonly editor: EditorState;
  /** True while another surface — an ask card, a picker — owns the bottom region. */
  readonly blocked: boolean;
  /** True while the slash menu is shown: the two menus never compete for the same key. */
  readonly suppressed: boolean;
  /** The slash menu's claim, read at key time: the prompt yields to whichever menu owns it. */
  readonly slashOwns: () => boolean;
  /** The rows the bottom region can spare, which the picker's share is measured against. */
  readonly budget: number;
  /** False while the screen's keys are locked, as they are during a close. */
  readonly active: boolean;
  /** The input's handle: an applied row is written through it, caret where the row left it. */
  readonly handle: RefObject<ChatInputHandle | undefined>;
}

/** The claim on the keys, and the state the view draws from it. */
export interface MentionMenuController {
  /** What the picker draws this render. */
  readonly view: MentionMenuView;
  /**
   * True while a menu under the input — this picker or the slash menu — owns up, down, tab,
   * return and escape. The prompt asks one question of the keys, so one accessor answers it,
   * read at key time.
   */
  ownsNavigation(): boolean;
  /** Record an edit: a batch's keys have not seen the render that shows it. */
  sawEditor(editor: EditorState): void;
}

/**
 * The live `@` picker for one chat screen: the file list it reads, the pointer, the dismissal,
 * and the key handler that acts on all three before React redraws.
 */
export function useMentionMenu(options: MentionMenuOptions): MentionMenuController {
  // The newest render's inputs, for a handler registered by an older one: the row budget and
  // the surfaces that outrank the picker are read at key time too.
  const latest = useRef(options);
  latest.current = options;
  const live = useRef<LivePicker>({
    editor: options.editor,
    dismissed: undefined,
    listed: undefined,
    pointer: { query: "", index: FIRST_ROW },
    acted: false,
  });
  const [index] = useState(() => options.indexFor(options.cwd));
  const [, setRevision] = useState(0);
  /** Draw again: the pointer, a dismissal or a listing changed without a draft edit. */
  const redraw = (): void => setRevision((seen) => seen + 1);

  const asking = useRef(false);
  useEffect(() => {
    const open = mentionQueryAt(options.editor) !== null;
    const asked = asking.current;
    asking.current = open;
    if (!open || asked) return;
    // The list belongs to the directory, not to the query, so a late answer is never stale:
    // the index shares one in-flight listing and reuses it while it is young. A rejection is
    // a list git could not produce, which the picker draws as its own line.
    const settle = (list: MentionFileList): void => {
      live.current.listed = list;
      setRevision((seen) => seen + 1);
    };
    void index.get().then(settle, () => settle(NO_LIST));
  }, [index, options.editor]);

  /**
   * The rows the picker may draw for `count` matches: at most the slash menu's own cap, and
   * never more than its share of the bottom region the screen can spare.
   */
  const shareOf = (count: number): number =>
    menuRowsFor({ rows: Math.min(count, SLASH_MENU_MAX_ROWS), budget: latest.current.budget });

  /** The mention being typed right now, and the rows the loaded list keeps for it. */
  const claim = (): MentionClaim | undefined => {
    const listed = live.current.listed;
    if (listed === undefined || !listed.git) return undefined;
    const at = mentionQueryAt(live.current.editor);
    if (at === null) return undefined;
    const matches = filterMentionRows(listed.rows, at.query);
    return matches.length === 0 ? undefined : { at, matches };
  };

  /** True while the picker is drawn and owns the keys: a claim nothing else outranks. */
  const visible = (found: MentionClaim | undefined): found is MentionClaim => {
    if (found === undefined) return false;
    const state = live.current;
    if (latest.current.blocked || latest.current.suppressed) return false;
    if (state.dismissed === state.editor.text) return false;
    return shareOf(found.matches.length) > 0;
  };

  /** The pointer's row for a claim: a new query is a new list, so it starts on its first match. */
  const pointerFor = (found: MentionClaim): number => {
    const placed = live.current.pointer;
    const last = Math.max(FIRST_ROW, found.matches.length - 1);
    const index = placed.query === found.at.query ? placed.index : FIRST_ROW;
    return Math.min(Math.max(index, FIRST_ROW), last);
  };

  /** Move the pointer `delta` rows, never past either end, and draw the new row. */
  const move = (found: MentionClaim, delta: number): void => {
    const last = Math.max(FIRST_ROW, found.matches.length - 1);
    const index = Math.min(Math.max(pointerFor(found) + delta, FIRST_ROW), last);
    live.current.pointer = { query: found.at.query, index };
    redraw();
  };

  /** Replace the mention under the caret with the pointer's row, through the input's handle. */
  const choose = (found: MentionClaim, key: "tab" | "return"): void => {
    const row = found.matches[pointerFor(found)];
    if (row === undefined) return;
    const next = applyMentionRow(live.current.editor, found.at, row, key);
    live.current.editor = next;
    live.current.acted = true;
    latest.current.handle.current?.edit(next);
  };

  /** Put the picker away, for the prompt as it stands, and keep the keys for the rest of the batch. */
  const dismiss = (): void => {
    live.current.dismissed = live.current.editor.text;
    live.current.acted = true;
    redraw();
  };

  useInput(
    (_input, key) => {
      if (!ownsMentionKey(key)) return;
      const found = claim();
      if (!visible(found)) return;
      if (key.escape) {
        dismiss();
        return;
      }
      // A shifted or ctrl'd key is another surface's: shift+up scrolls the transcript,
      // shift+return is a newline in the prompt, shift+tab cycles the permission mode, and a
      // ctrl chord belongs to the screen.
      if (key.shift || key.ctrl || key.meta) return;
      if (key.tab) choose(found, "tab");
      else if (key.return) choose(found, "return");
      else if (key.upArrow) move(found, -1);
      else if (key.downArrow) move(found, 1);
    },
    { isActive: options.active },
  );

  // The hold a key's apply or dismissal takes lasts only for the batch being delivered: this
  // runs after the re-render that batch produced, so the next key reads a claim that matches
  // what is drawn rather than one left over from the row that was just completed.
  useEffect(() => {
    live.current.acted = false;
  });

  /** What the picker draws: the rows of the claim, or git's diagnostic line in their place. */
  const draw = (): MentionMenuView => {
    const state = live.current;
    if (latest.current.blocked || latest.current.suppressed) return NO_VIEW;
    if (state.dismissed === state.editor.text) return NO_VIEW;
    if (mentionQueryAt(state.editor) === null) return NO_VIEW;
    const listed = state.listed;
    if (listed === undefined) return NO_VIEW;
    if (!listed.git) {
      const rows = shareOf(1);
      return { ...NO_VIEW, noGit: rows > 0, rows };
    }
    const found = claim();
    if (found === undefined) return NO_VIEW;
    const rows = shareOf(found.matches.length);
    if (rows <= 0) return NO_VIEW;
    return { matches: found.matches, selected: pointerFor(found), noGit: false, rows };
  };

  return {
    view: draw(),
    // A key the picker has already taken keeps the claim for the rest of the batch, so the
    // input does not also submit the line that key wrote.
    ownsNavigation: () => live.current.acted || visible(claim()) || latest.current.slashOwns(),
    sawEditor: (editor) => {
      live.current.editor = editor;
    },
  };
}
