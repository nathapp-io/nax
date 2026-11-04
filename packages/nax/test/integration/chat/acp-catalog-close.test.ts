import { afterEach, expect, test } from "bun:test";
import { AgentSessionError, type BackendOpenContext, type SessionBackend } from "@nathapp/nax-agent";
import { withTempDir } from "@test/helpers";
import { _acpCatalogDeps, createAcpCatalog } from "@/chat/acp/acp-catalog";
import { _acpProbeDeps } from "@/chat/acp/acp-probe";

const originalCatalog = { ..._acpCatalogDeps };
const originalProbe = { ..._acpProbeDeps };
afterEach(() => {
  Object.assign(_acpCatalogDeps, originalCatalog);
  Object.assign(_acpProbeDeps, originalProbe);
});

test("AC-16 real probe and session facade propagate catalog abort into backend open", async () => {
  await withTempDir(async (dir) => {
    const entered = Promise.withResolvers<BackendOpenContext>();
    const pending = Promise.withResolvers<never>();
    const backend: SessionBackend = {
      kind: "acp:codex",
      open(ctx) {
        entered.resolve(ctx);
        ctx.openSignal.addEventListener(
          "abort",
          () => {
            pending.reject(new AgentSessionError("closed", "AGENT_SESSION_CLOSED"));
          },
          { once: true },
        );
        return pending.promise;
      },
    };
    _acpCatalogDeps.launchCandidateKind = (agent) => (agent === "codex" ? "local" : undefined);
    _acpProbeDeps.acpBackend = () => backend;
    const catalog = createAcpCatalog({ env: {}, closeBoundMs: 60_000 });
    catalog.warm(dir);
    try {
      const ctx = await entered.promise;
      expect(ctx.openSignal.aborted).toBe(false);
      await catalog.close();
      expect(ctx.openSignal.aborted).toBe(true);
    } finally {
      pending.reject(new AgentSessionError("cleanup", "AGENT_SESSION_CLOSED"));
      await catalog.close();
    }
  });
}, 1000);
