/**
 * The terminal's side of a login (moved from nax's `terminalInteraction`, S5-4
 * M-28). Shared by `nax auth login` and `nax-agent login`. Secrets go through
 * the non-echoing prompt; any prompt type this mirror does not recognise is
 * treated as a secret.
 */
import type { AuthEvent, AuthInteraction, AuthPrompt } from "#src/native/auth-types";
import { openUrl as defaultOpenUrl } from "#src/terminal-auth/open-url";
import {
  PLAIN_STYLE,
  promptForLine,
  promptForSecret,
  promptForSelect,
  type TerminalStyle,
} from "#src/terminal-auth/prompt";

export interface TerminalAuthOptions {
  /** One line of output (no trailing newline). */
  readonly log: (text: string) => void;
  readonly style?: TerminalStyle;
  readonly openUrl?: (url: string) => void;
}

export function createTerminalAuthInteraction(options: TerminalAuthOptions): AuthInteraction {
  const style = options.style ?? PLAIN_STYLE;
  const open = options.openUrl ?? defaultOpenUrl;
  // notify() is synchronous and the flow fires auth-url right before racing a
  // manual-code prompt against its callback server, so the URL is parked and
  // spent by the next prompt's Enter-on-empty.
  let pendingUrl: string | undefined;

  const manualCode = (message: string): Promise<string> => {
    const url = pendingUrl;
    if (url === undefined) return promptForLine(message, undefined, style);
    pendingUrl = undefined;
    options.log(style.dim("Press Enter to open it in your browser."));
    return promptForLine(
      message,
      () => {
        options.log(style.dim("Opening your browser..."));
        open(url);
      },
      style,
    );
  };

  return {
    prompt: async (prompt: AuthPrompt): Promise<string> => {
      if (prompt.type === "manual-code") return manualCode(prompt.message);
      if (prompt.type === "text") return promptForLine(prompt.message, undefined, style);
      if (prompt.type === "select") {
        return promptForSelect(
          prompt.message,
          prompt.options.map((option) => ({ id: option.id, label: option.label })),
          style,
        );
      }
      return promptForSecret(prompt.message, style);
    },
    notify: (event: AuthEvent): void => {
      switch (event.type) {
        case "auth-url":
          // The flow's own instructions are dropped: nothing has opened a browser yet.
          options.log(`\n${style.bold("Open this URL to continue:")}\n  ${event.url}`);
          pendingUrl = event.url;
          return;
        case "device-code":
          options.log(`\nGo to ${event.verificationUri} and enter code ${style.bold(event.userCode)}`);
          return;
        case "info":
          options.log(event.message);
          for (const link of event.links ?? []) options.log(`  ${link.label ?? "Link"}: ${link.url}`);
          return;
        case "progress":
          options.log(style.dim(event.message));
          return;
        default:
        // An event type this mirror does not recognise: say nothing.
      }
    },
  };
}
