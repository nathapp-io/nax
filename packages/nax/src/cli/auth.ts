/**
 * The `nax auth` commands.
 *
 * Terminal I/O only. Native auth and nax-ai integration live in
 * `packages/nax-agent/src/native/`; this command uses the package's public
 * auth API and does not import the wire package or its types.
 *
 * Each command returns an exit code rather than calling process.exit, so the
 * behaviour is testable and bin/nax.ts owns the process.
 */

import type { AuthInteraction, AuthMethod } from "@nathapp/nax-agent";
import {
  AuthCancelledError,
  ambientShadows,
  authImportOutcomeLabel,
  createTerminalAuthInteraction,
  importPiCredentials,
  listStoredProviders,
  naxCredentialStore,
  PromptCancelledError,
  removeStoredProvider,
  runLogin,
  servedAuth,
  type TerminalStyle,
} from "@nathapp/nax-agent";
import chalk from "chalk";
import { readGlobalAuthConfig } from "@/config";
import { type AuthListReport, collectAuthList, errorCode, renderAuthListJson, renderAuthListText } from "./auth-list";

export const _cliAuthDeps: {
  log: (text: string) => void;
  isTTY: () => boolean;
  collectAuthList: typeof collectAuthList;
} = {
  log: (text: string) => console.log(text),
  isTTY: () => process.stdin.isTTY === true,
  collectAuthList,
};

const CHALK_STYLE: TerminalStyle = { accent: chalk.cyan, dim: chalk.dim, bold: chalk.bold };

/** The terminal's side of a login, from nax-agent (S5-4 M-28); log stays a seam. */
function terminalInteraction(): AuthInteraction {
  return createTerminalAuthInteraction({ log: (text) => _cliAuthDeps.log(text), style: CHALK_STYLE });
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

    try {
      const authConfig = await readGlobalAuthConfig();
      if (authConfig.source === "exec") {
        await naxCredentialStore().read(result.providerId);
        if (servedAuth(result.providerId)?.source === "exec") {
          _cliAuthDeps.log(
            `Note: the credential helper serves ${result.providerId}; this stored login is not used while it does.`,
          );
        }
      }
    } catch (error) {
      // The login succeeded; report the failed status check without changing its exit code.
      _cliAuthDeps.log(
        `Warning: credential helper status check failed: ${errorCode(error, "CREDENTIAL_HELPER_FAILED")}`,
      );
    }

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

export async function authListCommand(
  providerIds: readonly string[] = [],
  options: { json?: boolean } = {},
): Promise<number> {
  try {
    const report: AuthListReport = await _cliAuthDeps.collectAuthList(providerIds);
    const output = options.json ? renderAuthListJson(report) : renderAuthListText(report);
    if (typeof output === "string") {
      _cliAuthDeps.log(output);
    } else {
      for (const line of output) _cliAuthDeps.log(line);
    }
    return 0;
  } catch (error) {
    if (options.json) {
      _cliAuthDeps.log(
        JSON.stringify({
          error: {
            code: errorCode(error, "AUTH_LIST_FAILED"),
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      );
    } else {
      _cliAuthDeps.log(chalk.red((error as Error).message));
    }
    return 1;
  }
}

export async function authRmCommand(providerId: string): Promise<number> {
  try {
    const auth = await readGlobalAuthConfig();
    if (auth.source === "exec") {
      await naxCredentialStore().read(providerId);
      if (servedAuth(providerId)?.source === "exec") {
        _cliAuthDeps.log(`${providerId} is managed by the credential helper; nothing was removed.`);
        return 1;
      }
    }
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
