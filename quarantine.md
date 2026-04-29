## test/unit/review/semantic-agent-session.test.ts
- Reason: Tests check that agent.run() is called with specific runOptions (sessionRole, keepOpen, etc.). With runtime path, these options are buried in the hopCallback closure, not directly visible on agentManager.run mock.
- The semanticReviewOp hopBody calls ctx.send() which eventually calls runWithFallback, but the mock's runWithFallback is called without the expected runOptions assertions.
- First failing test: calls agent.run() for the non-debate path (agentManager.run not called, agentManager.runWithFallback called instead)
- Last error: Expected number of calls: >= 1, Received: 0

## test/unit/review/semantic-findings.test.ts
- Status: MIGRATED successfully
- Notes: 13 pass, 0 fail after applying callRunSemanticReview helper with runtime injection