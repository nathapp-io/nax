# SPEC: Session-Manager Prompt Audit Ownership

**Status:** Implemented (#523)
**Supersedes:** Prompt-audit sidecar in `src/agents/acp/prompt-audit.ts`
**Related:** ADR-011 (Session Manager Ownership), ADR-012 (Agent Manager Ownership)

---

## Problem

Prompt-audit invocation and the file-writing module both lived inside `src/agents/acp/`.
This predated the SessionManager — it was built when session identity lived in the adapter.

| Concern | Prior state | Impact |
|:--------|:------------|:-------|
| Stable audit key | Keyed on ACP `sessionName` (volatile on reconnect) | Audit trail fragments across reconnects |
| Cross-adapter portability | Each adapter re-implements audit invocation | Duplication risk |
| Handoff continuity | Audit files spread across per-agent `sessionName`s | Hard to correlate across fallback hops |
| Audit policy ownership | Adapter checked `config.agent.promptAudit.enabled` | Policy scattered outside the session layer |

---

## Decision

Move all prompt-audit logic to `src/session/`:

```
src/session/
├── audit-writer.ts   (moved from src/agents/acp/prompt-audit.ts)
├── audit.ts          (new — policy layer; enriches entries with stable identity)
└── manager.ts        (calls audit.ts via auditPrompt(); injects auditCallback)

src/agents/acp/
├── prompt-audit.ts   (re-export shim → src/session/audit-writer.ts)
└── adapter.ts        (run path: calls options.auditCallback; complete path: direct write)
```

---

## Interface

### `SessionManager.auditPrompt(sessionId, entry, config)`

```typescript
auditPrompt(sessionId: string, entry: AuditTurnEntry, config: NaxConfig): void
```

- Looks up the descriptor by `sessionId`
- No-ops if session not found or `config.agent.promptAudit.enabled` is false
- Enriches entry with `descriptor.id` (stable `sess-<uuid>`), `descriptor.agent`,
  `descriptor.protocolIds`, `descriptor.workdir`, `descriptor.projectDir`
- Delegates to `auditTurn()` in `src/session/audit.ts`

### `AuditTurnEntry` (reported by adapters)

```typescript
interface AuditTurnEntry {
  prompt: string;
  callType: "run" | "complete";
  pipelineStage: string;
  turn?: number;
  resumed?: boolean;
  sessionName?: string;   // volatile ACP name — for filename + backward-compat header
  recordId?: string;      // acpx stable record ID
  sessionId?: string;     // acpx volatile session ID
}
```

### `AgentRunOptions.auditCallback`

```typescript
auditCallback?: (entry: AuditTurnEntry) => void;
```

Injected by `SessionManager.runInSession()` when `config.agent.promptAudit.enabled` is true.
The ACP adapter calls this per turn instead of writing files directly.

---

## Audit file naming and content

File path (unchanged):
```
<auditDir>/<featureName>/<epochMs>-<sessionName>-<stage>[-t<turn>].txt
```

Content additions (new `StableId` field):
```
Timestamp: 2026-04-21T08:00:00.000Z
Session:   nax-abc12345-my-feature-us-001
StableId:  sess-550e8400-e29b-41d4-a716-446655440000   ← new
RecordId:  acpx-record-xyz
SessionId: acpx-session-volatile-abc
Type:      run / turn 1
...
```

The `StableId` field lets operators correlate audit entries across agent swaps and
ACP reconnects using the nax-internal key that never changes.

---

## Audit continuity across fallback hops

When `AgentManager.runWithFallback` swaps agents, `SessionManager.handoff()` updates
`descriptor.agent`. Because `auditCallback` is bound to the session ID, subsequent
hop prompts are written with the same `sess-<uuid>` prefix even after the agent swap.

---

## Scope limitations

- The `complete()` path in the ACP adapter still writes via `writePromptAudit` directly
  (now in `src/session/audit-writer.ts`). `complete()` calls do not have an associated
  `SessionDescriptor`, so the `sess-<uuid>` enrichment is not available.
  This is a known gap — tracked as a follow-up. The policy check (`enabled`) for
  `complete()` remains in the adapter for now.

---

## Migration

- `src/agents/acp/prompt-audit.ts` is now a re-export shim. Existing importers continue
  to work. New code should import from `src/session/audit-writer` or `src/session`.
- Tests migrated from `test/unit/agents/acp/prompt-audit.test.ts` to
  `test/unit/session/audit-writer.test.ts`.
