# Releasing nax-agent-acp

nax-agent releases in lockstep with the other published nax packages. See the repo-root RELEASING.md. This file keeps the package's acceptance records.

## S4 acceptance (0.3.0)

S4 is complete when the four checks of the S4 spec §11 pass on the release
candidate, the S4-6 PR's merged `main` commit. The live smoke is billed and needs
explicit approval **at launch**.

1. **CI.** Green on the candidate: `nax-agent-acp` (unit, fake-agent conformance,
   MCP security tests, coverage, API snapshot) and `nax-agent-acp: node 22/24`
   (Node contract suite and the packed smoke of both tarballs).
2. **Live Claude smoke (billed).** From the repo root on the candidate:

   ```sh
   (cd packages/nax-agent && rtk bun run build && rtk bun run stage-publish)
   (cd packages/nax-agent-acp && rtk bun run build)
   ```

   Then pack both at one version, as `test/node/pack-smoke.test.ts` does. Both
   packages already share one version (lockstep), so `rtk bun run stage-publish`
   works for both directly. Install both
   tarballs into a fresh `npm init -y` project, copy
   `packages/nax-agent-acp/test/node/fixtures/live-claude-smoke.mjs` into it, and run:

   ```sh
   node live-claude-smoke.mjs
   ```

   It needs a Claude Code login (or `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`).
   `NAX_AGENT_ACP_LIVE_MODEL` picks a model. It must print `live claude smoke ok`.
   Record the printed JSON (model, per-phase usage, whether a question was observed,
   the first resumed turn's cost), the total cost and the commit in the master plan.
   A question that is not observed is recorded, not failed.
3. **Initialize-only smoke.** In the same project, copy
   `test/node/fixtures/init-smoke.mjs` and run `node init-smoke.mjs`. It starts each
   installed non-Claude agent (codex, gemini, opencode, pi), sends `initialize` and
   `session/new`, and prompts nothing. Record the capability lines as the master
   plan's capability matrix.
4. **nax unaffected.** `git diff --exit-code <S4 base> -- packages/nax/` is empty
   apart from the lockfile, and the nax suite and `bun run typecheck` pass. The S4-0
   and S4-6 billed `nax run` S1-recipe smoke results are already recorded.
