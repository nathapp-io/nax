/**
 * Self-contained error type for the nax-finish flow.
 *
 * The flow module is loaded by `acpx flow run` from wherever `flows/` happens
 * to be installed, in acpx's own process, with the *user's* repo as cwd. It
 * therefore cannot import from nax's `src/` — neither via the `@/*` path alias
 * (which only resolves through nax's own tsconfig) nor via a relative path
 * (only `flows/` is published, not `src/`). `FinishError` mirrors `NaxError`'s
 * shape (message + machine-readable code + structured context) so escalation
 * output and logs stay consistent with the rest of nax.
 */
export class FinishError extends Error {
  readonly code: string;
  readonly context: Record<string, unknown>;

  constructor(message: string, code: string, context: Record<string, unknown> = {}) {
    const { cause, ...rest } = context;
    super(message, cause === undefined ? undefined : { cause });
    this.name = "FinishError";
    this.code = code;
    this.context = rest;
  }
}
