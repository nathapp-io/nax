/**
 * The slash menu's model: the items a `/` input can offer, and the ones a typed query
 * keeps. `slash-commands.ts` owns the built-ins and their descriptions, and the host's
 * catalog supplies the commands and skills that follow them — built-ins first because
 * `/help` and `/mode` win over a catalog command of the same name when a line runs.
 *
 * A catalog's name and description come from a repository's own files, so both pass
 * through `sanitizeText` here, where an item first becomes display text: an escape
 * sequence in a description cannot leave the alternate screen, and a description that
 * spans lines is flattened, because a menu row is one row by definition.
 *
 * The row arithmetic lives here too — how many rows the menu draws, which of them the window
 * shows around the pointer, and whether the menu is shown for the prompt at all — so the
 * screen measures the rows it reserves with the same rules the component draws with, and the
 * component carries no state the screen cannot see.
 */
import type { ChatHost } from "@/chat";
import { oneLine } from "./layout-lines";
import { COMMAND_DESCRIPTIONS, COMMANDS } from "./slash-commands";
import { sanitizeText } from "./styled-line";

/** One row of the menu: the command's name without its slash, and what it does. */
export interface SlashMenuItem {
  readonly name: string;
  readonly description: string;
}

/** What the items are built from — a host whose catalog is absent offers the built-ins alone. */
export type SlashMenuHost = Pick<ChatHost, "catalog">;

const WHITESPACE = /\s/;

/** Display-safe single-row text for a string the host did not write. */
function displayText(text: string): string {
  return oneLine(sanitizeText(text));
}

function builtinItems(): readonly SlashMenuItem[] {
  return COMMANDS.map((name) => ({ name, description: COMMAND_DESCRIPTIONS[name] }));
}

/**
 * Every item the menu can offer: the built-ins in `COMMANDS` order, then the catalog's
 * commands as `(command) <description>`, then its skills as `(skill) <description>`.
 */
export function slashMenuItems(host: SlashMenuHost): readonly SlashMenuItem[] {
  const catalog = host.catalog;
  const resources = [
    ...(catalog?.commands ?? []).map((entry) => ({
      name: displayText(entry.name),
      description: displayText(`(command) ${entry.description ?? ""}`),
    })),
    ...(catalog?.skills ?? []).map((entry) => ({
      name: displayText(entry.name),
      description: displayText(`(skill) ${entry.description}`),
    })),
  ];
  return [...builtinItems(), ...resources];
}

/**
 * The items a typed input keeps, or `null` when the input is not a menu query at all —
 * anything that does not start with `/`, or that carries whitespace (`/mode full` is a
 * line being typed, not a search). The query is what follows the slash; ranked matches
 * are a name equal to it, then one starting with it, then one containing it elsewhere,
 * each group keeping item order, so `/skill` offers a `skill` skill before `/skills`.
 */
export function filterSlashMenu(items: readonly SlashMenuItem[], input: string): readonly SlashMenuItem[] | null {
  if (!input.startsWith("/") || WHITESPACE.test(input)) return null;
  const query = input.slice(1).toLowerCase();
  const equal: SlashMenuItem[] = [];
  const starting: SlashMenuItem[] = [];
  const containing: SlashMenuItem[] = [];
  for (const item of items) {
    const name = item.name.toLowerCase();
    if (name === query) equal.push(item);
    else if (name.startsWith(query)) starting.push(item);
    else if (name.includes(query)) containing.push(item);
  }
  return [...equal, ...starting, ...containing];
}

/** The most rows the menu draws at once; past this the window follows the pointer. */
export const SLASH_MENU_MAX_ROWS = 8;

/** The first match's index, and where the pointer starts for every query. */
const FIRST_MATCH = 0;

/** The rows the menu occupies for a query keeping `count` matches. */
export function slashMenuRows(count: number): number {
  return Math.min(Math.max(count, FIRST_MATCH), SLASH_MENU_MAX_ROWS);
}

/** The window the menu shows: its height, and the index of the first match drawn. */
export interface SlashMenuWindow {
  readonly first: number;
  readonly rows: number;
}

/**
 * The rows drawn, and the first of them: the pointer stays inside the window, so the window
 * is the last `rows` matches up to the pointer, and never past the last match there is.
 */
export function slashMenuWindow(count: number, selected: number): SlashMenuWindow {
  const rows = slashMenuRows(count);
  const furthest = Math.max(FIRST_MATCH, count - rows);
  return { first: Math.min(Math.max(selected - rows + 1, FIRST_MATCH), furthest), rows };
}

/** What the menu shows for a prompt, and whether it is shown at all. */
export interface SlashMenuQueryState {
  /** The prompt's text, which the menu's query is read from. */
  readonly query: string;
  /** The matches the query keeps, in rank order — `null` when the prompt is not a query. */
  readonly matches: readonly SlashMenuItem[] | null;
  /** True while the menu owns the keys and the rows under the input. */
  readonly open: boolean;
  /** The rows the menu draws: at most `SLASH_MENU_MAX_ROWS`, none while it is closed. */
  readonly rows: number;
  /**
   * True when an escape's suppression no longer applies because the prompt has changed since,
   * so the owner can forget the query it remembered.
   */
  readonly reopen: boolean;
}

/**
 * What the screen shows for the prompt as it stands. The menu is open while the prompt is a
 * `/` query that matches something, while no other surface owns the bottom of the screen
 * (`blocked`: an ask card's keys are its own), and while no escape has put this prompt's menu
 * away. Suppression lasts only until the text next changes, which `reopen` reports so the
 * owner can drop the query it remembered.
 */
export function slashMenuQueryState(input: {
  readonly items: readonly SlashMenuItem[];
  readonly query: string;
  /** The query an escape put the menu away at, while the prompt still holds it. */
  readonly dismissed?: string;
  /** True while another surface — an ask card, a picker — owns the bottom region. */
  readonly blocked: boolean;
}): SlashMenuQueryState {
  const matches = input.blocked ? null : filterSlashMenu(input.items, input.query);
  const open = matches !== null && matches.length > 0 && input.dismissed !== input.query;
  return {
    query: input.query,
    matches,
    open,
    rows: open ? slashMenuRows(matches.length) : 0,
    reopen: input.dismissed !== undefined && input.dismissed !== input.query,
  };
}
