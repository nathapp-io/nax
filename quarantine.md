## test/unit/review/semantic-agent-session.test.ts
- Reason: Pattern T2-review resisted - complex file with 20 direct runSemanticReview calls and multiple test helpers; edits caused function duplication errors
- First failing test: ReferenceError: callRunSemanticReview is not defined (after multiple edits)
- Last error line: const result = await callRunSemanticReview(agentManager); at line 432