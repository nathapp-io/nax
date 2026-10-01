/**
 * Local stub for ink's optional `react-devtools-core` peer. Not a polyfill --
 * it exists so the specifier resolves, and nothing more.
 *
 * ink declares `react-devtools-core` an optional peer and reaches it from
 * `ink/build/reconciler.js` via `await import('./devtools.js')`, guarded by
 * `process.env.DEV === 'true'`. `devtools.js` imports this package at module
 * scope. Bun's bundler follows that static specifier, so with the package
 * absent `bun run build` fails outright, and with the package merely marked
 * `--external` the binding is hoisted to a top-level `import` in `dist/nax.js`
 * and every `nax` invocation dies at load -- the module *body* stays lazy, but
 * an ESM import binding does not.
 *
 * The real package cannot come back: every published version (through 8.0.0)
 * depends on `ws@^7` and `shell-quote@^1.6.1`, which is precisely the critical
 * + high advisory pair nax#1976 removed it to escape.
 *
 * Resolving to this file instead keeps the bundle buildable and loadable while
 * the devtools payload stays out of it. React DevTools genuinely does not work
 * against the published CLI; that is the intended trade, and `DEV=true` says so
 * rather than failing silently.
 */
const unavailable = (method) => () => {
  console.warn(
    `react-devtools-core.${method}() was called, but nax ships a stub for it.\n` +
      "React DevTools is not available in the published nax bundle: the real\n" +
      "package depends on ws@7 and shell-quote, which nax#1976 removed for\n" +
      "security. Run nax from source if you need to attach DevTools.",
  );
};

const devtools = {
  initialize: unavailable("initialize"),
  connectToDevTools: unavailable("connectToDevTools"),
};

export default devtools;
export const { initialize, connectToDevTools } = devtools;
