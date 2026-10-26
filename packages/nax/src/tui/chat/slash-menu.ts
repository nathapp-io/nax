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
