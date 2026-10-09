# Releasing nax-agent

nax-agent releases in lockstep with the other published nax packages. See the repo-root RELEASING.md. This file keeps the package's acceptance records.

## S3 acceptance (0.2.0)

S3 is complete when the three checks of the S3 spec §10 pass on the release
candidate, the feature PR's merged `main` commit. Both real-provider runs are
billed and need explicit approval **at launch**.

1. **Packed chat smoke, stub provider.** CI's Node 22/24 contract job runs
   `test/node/pack-smoke.test.ts`, which now includes the S3 chat round-trip.
   Green CI on the release candidate is the evidence.
2. **Real-provider chat smoke on Node.** From `packages/nax-agent`:

   ```sh
   rtk bun run build && rtk bun run stage-publish
   PACK=$(mktemp -d) && CONSUMER=$(mktemp -d)
   rtk npm pack ./.publish/ --pack-destination "$PACK"
   cd "$CONSUMER" && npm init -y >/dev/null
   npm install --no-audit --no-fund "$PACK"/nathapp-nax-agent-*.tgz
   cp <repo>/packages/nax-agent/test/node/fixtures/live-chat-smoke.mjs .
   node live-chat-smoke.mjs
   ```

   The script reads provider credentials from `~/.nax` (override with
   `NAX_GLOBAL_CONFIG_DIR`). Its model defaults to `minimax/MiniMax-M2.7`;
   override it with `NAX_AGENT_LIVE_MODEL`. It must print `live chat smoke ok`.
   Record the model, the cost line and the commit.
3. **`nax run` unchanged.** The billed S1-recipe smoke on a fresh fixture copy at
   the release candidate: same story outcome, tool-audit keys and per-tool record
   shapes, cost-row schema, and a `run.start` `naxCommit` equal to the candidate.
