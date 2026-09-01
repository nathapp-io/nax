/**
 * The `nax auth` commands.
 *
 * Terminal I/O only. Everything touching nax-ai lives behind
 * src/agents/native/, the only place in src/ permitted to import it, so
 * nothing here imports the wire package or its types.
 *
 * Each command returns an exit code rather than calling process.exit, so the
 * behaviour is testable and bin/nax.ts owns the process.
 */

import chalk from "chalk";
import type { AuthEvent, AuthInteraction, AuthMethod, AuthPrompt } from "@/agents/native";
import {
  AuthCancelledError,
  ambientShadows,
  authImportOutcomeLabel,
  importPiCredentials,
  listStoredProviders,
  removeStoredProvider,
  runLogin,
} from "@/agents/native";
import { PromptCancelledError, promptForLine, promptForSecret, promptForSelect } from "./auth-prompt";
import { openUrl } from "./open-url";

export const _cliAuthDeps: {
  log: (text: string) => void;
  isTTY: () => boolean;
} = {
  log: (text: string) => console.log(text),
  isTTY: () => process.stdin.isTTY === true,
};

/** The terminal's side of a login. Secrets go through the non-echoing prompt. */
function terminalInteraction(): AuthInteraction {
  // notify() is synchronous and the flow fires auth-url immediately before
  // racing a manual-code prompt against its callback server, so there is no
  // window in which to await a keypress there. The URL is parked instead and
  // spent by the next prompt's Enter-on-empty.
  let pendingUrl: string | undefined;

  return {
    prompt: async (prompt: AuthPrompt): Promise<string> => {
      // Invert the default: echo only the known-safe, non-secret shapes, and
      // treat anything this mirror doesn't recognise as a secret. AuthPrompt
      // is a hand-maintained copy of nax-ai's LoginPrompt (auth-types.ts), so
      // a future secret-bearing prompt type must not fall through to echo.
      if (prompt.type === "manual-code") {
        const url = pendingUrl;
        if (url === undefined) return promptForLine(prompt.message);
        // Consume it: a second Enter after the browser is already open should
        // submit the empty buffer's rejection, not launch another window.
        pendingUrl = undefined;
        // The hint is its own line rather than a prefix on the flow's message:
        // pi's already mentions the browser, and gluing them together reads
        // "open your browser, or complete login in your browser, or ...".
        _cliAuthDeps.log(chalk.dim("Press Enter to open it in your browser."));
        return promptForLine(prompt.message, () => {
          _cliAuthDeps.log(chalk.dim("Opening your browser..."));
          openUrl(url);
        });
      }
      if (prompt.type === "text") return promptForLine(prompt.message);
      if (prompt.type === "select") {
        // An arrow-key picker cannot return a value that is not on the list,
        // so the old type-it-and-revalidate loop has nothing left to catch.
        return promptForSelect(
          prompt.message,
          prompt.options.map((option) => ({ id: option.id, label: option.label })),
        );
      }
      return promptForSecret(prompt.message);
    },
    notify: (event: AuthEvent): void => {
      switch (event.type) {
        case "auth-url":
          _cliAuthDeps.log(`\n${chalk.bold("Open this URL to continue:")}\n  ${event.url}`);
          // The flow's own instructions are dropped, not shown: pi says "A
          // browser window should open", and nothing here has opened one yet.
          // The next prompt says what actually happens.
          pendingUrl = event.url;
          return;
        case "device-code":
          _cliAuthDeps.log(`\nGo to ${event.verificationUri} and enter code ${chalk.bold(event.userCode)}`);
          return;
        case "info":
          _cliAuthDeps.log(event.message);
          for (const link of event.links ?? []) _cliAuthDeps.log(`  ${link.label ?? "Link"}: ${link.url}`);
          return;
        case "progress":
          _cliAuthDeps.log(chalk.dim(event.message));
          return;
        default:
        // An event type this mirror doesn't recognise: say nothing rather
        // than logging `undefined` for a field this shape may not carry.
      }
    },
  };
}

export async function authLoginCommand(providerId: string, method?: AuthMethod): Promise<number> {
  if (!_cliAuthDeps.isTTY()) {
    _cliAuthDeps.log(
      `${chalk.red("nax auth login needs an interactive terminal.")}\n` +
        "For CI, set the provider's environment variable instead — nax reads it when nothing is stored.",
    );
    return 1;
  }

  try {
    const result = await runLogin(providerId, terminalInteraction(), method);
    // Reported as returned. kind is never derived from method: M5 predicted
    // openrouter would report api-key here and its live run reported oauth.
    _cliAuthDeps.log(
      `${chalk.green("Signed in to")} ${chalk.bold(result.providerId)} ` +
        chalk.dim(`(method: ${result.method}, credential: ${result.kind})`),
    );

    if ((await ambientShadows([result.providerId])).length > 0) {
      _cliAuthDeps.log(
        chalk.yellow(
          `Note: ${result.providerId} also has credentials in your environment. The stored credential ` +
            `takes precedence from now on — run \`nax auth rm ${result.providerId}\` to go back to the environment.`,
        ),
      );
    }
    return 0;
  } catch (error) {
    // Ctrl+C is not a failure: 130 and nothing on stdout.
    if (error instanceof AuthCancelledError || error instanceof PromptCancelledError) return 130;
    _cliAuthDeps.log(chalk.red((error as Error).message));
    return 1;
  }
}

export async function authImportCommand(options: { from?: string; force?: boolean }): Promise<number> {
  try {
    const outcomes = await importPiCredentials(options);
    if (outcomes.length === 0) {
      _cliAuthDeps.log("Nothing to import.");
      return 0;
    }
    for (const outcome of outcomes) {
      _cliAuthDeps.log(`  ${outcome.providerId.padEnd(20)} ${authImportOutcomeLabel(outcome.status)}`);
    }
    return 0;
  } catch (error) {
    _cliAuthDeps.log(chalk.red((error as Error).message));
    return 1;
  }
}

export async function authListCommand(): Promise<number> {
  try {
    const entries = await listStoredProviders();
    if (entries.length === 0) {
      _cliAuthDeps.log("No credentials stored. Add one with `nax auth login <provider>`.");
      return 0;
    }

    const shadowed = new Set(await ambientShadows(entries.map((entry) => entry.providerId)));

    for (const entry of entries) {
      const expiry =
        entry.expires === undefined
          ? ""
          : entry.expires <= Date.now()
            ? chalk.red(" expired")
            : chalk.dim(` expires ${new Date(entry.expires).toISOString()}`);
      const shadow = shadowed.has(entry.providerId) ? chalk.yellow(" shadows an environment variable") : "";
      _cliAuthDeps.log(`  ${entry.providerId.padEnd(20)} ${entry.kind}${expiry}${shadow}`);
    }
    return 0;
  } catch (error) {
    _cliAuthDeps.log(chalk.red((error as Error).message));
    return 1;
  }
}

export async function authRmCommand(providerId: string): Promise<number> {
  try {
    const stored = await listStoredProviders();
    if (!stored.some((entry) => entry.providerId === providerId)) {
      _cliAuthDeps.log(chalk.red(`No stored credential for "${providerId}".`));
      return 1;
    }

    await removeStoredProvider(providerId);

    // Never "logged out": pi has no revocation, so the provider-side token
    // stays live until it expires. Saying otherwise would be false.
    _cliAuthDeps.log(
      `Credential for ${chalk.bold(providerId)} removed locally. ` +
        chalk.dim("The token stays valid at the provider until it expires — revoke it there if you need it dead."),
    );
    return 0;
  } catch (error) {
    _cliAuthDeps.log(chalk.red((error as Error).message));
    return 1;
  }
}
