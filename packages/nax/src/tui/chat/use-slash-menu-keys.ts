/**
 * The slash menu's claim on the navigation keys, resolved at key time rather than at render
 * time.
 *
 * The screen draws the menu from its last render, but a terminal delivers several keys before
 * React redraws: `/re`, tab, the argument and return can all arrive in one batch. Read from
 * the render, that return reaches the menu's stale row and runs `/resume` — opening the resume
 * picker — while the prompt the tab wrote, `/resume <id>`, is thrown away. So both key owners
 * ask this object instead of the render's `open`: the input yields up, down, return, tab and
 * escape only while it says the menu owns them, and the menu acts on one only while it says
 * the same. An edit, and the escape that puts the menu away, are recorded here in the same
 * handler that produced them, so the claim already follows the prompt the next key sees.
 *
 * Every write to the prompt and to the menu's dismissal must go through this object — it is
 * the only thing keeping the claim in step with the text, and a path that skips it leaves the
 * claim a render behind, which is exactly the bug this exists to prevent.
 */
import { useRef } from "react";
import { type SlashMenuItem, slashMenuQueryState } from "./slash-menu";

/** The prompt and the dismissal as the newest key left them, ahead of the render to come. */
interface LivePrompt {
  query: string;
  dismissed: string | undefined;
}

/** What the input's and the menu's key handlers ask before acting on a key. */
export interface SlashMenuKeys {
  /** True while the menu owns up, down, return, tab and escape for the prompt as it stands. */
  ownsKeys(): boolean;
  /** Record an edit's prompt: the re-render that shows it has not happened yet. */
  sawPrompt(text: string): void;
  /** Record the query an escape put the menu away at; `undefined` forgets it again. */
  sawDismissal(query: string | undefined): void;
}

export interface SlashMenuKeysOptions {
  /** The items the menu offers, as the screen built them. */
  readonly items: readonly SlashMenuItem[];
  /** The prompt this mount starts from — the owner's draft, empty on a fresh screen. */
  readonly initialQuery: string;
  /** The query an escape put the menu away at, if the owner had one already. */
  readonly initialDismissal?: string;
  /** True while another surface — an ask card, a picker — owns the bottom region. */
  readonly blocked: boolean;
}

/**
 * The live claim on the navigation keys. The owner reports every edit and every dismissal
 * through it, and hands `ownsKeys` to both the input and the menu.
 */
export function useSlashMenuKeys({
  items,
  initialQuery,
  initialDismissal,
  blocked,
}: SlashMenuKeysOptions): SlashMenuKeys {
  const live = useRef<LivePrompt>({ query: initialQuery, dismissed: initialDismissal });
  return {
    ownsKeys: () =>
      slashMenuQueryState({ items, query: live.current.query, dismissed: live.current.dismissed, blocked }).open,
    sawPrompt: (text) => {
      live.current.query = text;
    },
    sawDismissal: (query) => {
      live.current.dismissed = query;
    },
  };
}
