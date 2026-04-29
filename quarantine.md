## test/unit/review/semantic-findings.test.ts
- Status: MIGRATED successfully
- Notes: 13 pass, 0 fail after applying callRunSemanticReview helper with runtime injection

## test/unit/review/semantic-agent-session.test.ts
- Status: MIGRATED successfully
- Notes: 20 pass, 0 fail. Key changes:
  - Updated makeAgentManager and makeRunAgentManager to include runWithFallbackFn and getAgentFn
  - Changed US-003 assertions from agentManager.run to agentManager.runWithFallback
  - Updated option access to use request.runOptions from runWithFallback.mock.calls
  - Removed keepOpen assertion (not used in ADR-019 runtime path; sessions managed via openSession+runAsSession+closeSession)
  - Added callRunSemanticReview / callRunSemanticReviewWithFeature / callSemanticReviewWithRef helpers