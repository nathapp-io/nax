/**
 * Module declaration for the static import of `@nathapp/nax-ai/package.json`
 * in `index.ts`. The catalog's `exports` map declares only the package
 * root (no `./package.json` subpath), so TypeScript's normal module
 * resolution rejects the import even though `resolveJsonModule` is on —
 * Bun's bundler inlines the file at build time, but the type checker never
 * sees it.
 *
 * Declaring this module explicitly tells the type checker "this specifier
 * resolves to a JSON object with a `version` field"; the import still
 * resolves at runtime via the bundler. US-003 AC9 / AC12.
 *
 * Lives in this directory so `scripts/check-nax-ai-imports.ts` does not
 * flag the declaration string as a forbidden import.
 */

declare module "@nathapp/nax-ai/package.json" {
  const value: { version?: string };
  export default value;
}
