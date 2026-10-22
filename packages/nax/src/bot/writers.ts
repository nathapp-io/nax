import { errorMessage } from "@nathapp/nax-agent/internal";
import type { ForgeDeps, hasWriteAccess, PrComment, PrRef } from "@/forge";

export type WriterCheck = (who: { readonly login: string; readonly id?: number }) => Promise<boolean>;

/** Cache in-flight and settled permission checks per login for this reader only. */
export function writerCheck(
  input: { readonly ref: PrRef; readonly deps: ForgeDeps; readonly cwd: string },
  check: typeof hasWriteAccess,
  warn: (login: string, error: string) => void,
): WriterCheck {
  const permissions = new Map<string, Promise<boolean>>();
  return (who) => {
    let pending = permissions.get(who.login);
    if (!pending) {
      pending = Promise.resolve()
        .then(() => check(input.ref, who, input.deps, input.cwd))
        .catch((error: unknown) => {
          warn(who.login, errorMessage(error));
          return false;
        });
      permissions.set(who.login, pending);
    }
    return pending;
  };
}

/** Only authorized authors become writers; preserve forge-specific author ids. */
export async function readWriters(comments: readonly PrComment[], check: WriterCheck): Promise<ReadonlySet<string>> {
  const allowed = await Promise.all(
    comments.map(async (comment) =>
      (await check({ login: comment.author, id: comment.authorId })) ? comment.author : null,
    ),
  );
  return new Set(allowed.filter((login): login is string => login !== null));
}
