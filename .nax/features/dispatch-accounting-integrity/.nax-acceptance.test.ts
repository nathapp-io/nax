import { describe, test, expect } from "bun:test";

describe("dispatch-accounting-integrity - Acceptance Tests", () => {
  test("AC-1: Given a SessionTurnError instance with tokenUsage = { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 }, estimatedCostUsd = 0.002, and exactCostUsd = 0.003, calling buildDispatchErrorEvent({ origin, agentName, stage, error, dispatchOptions, startedAt }) returns a DispatchErrorEvent where event.tokenUsage deep-equals { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 }.", async () => {
    // TODO: Implement acceptance test for AC-1
    // Given a SessionTurnError instance with tokenUsage = { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 }, estimatedCostUsd = 0.002, and exactCostUsd = 0.003, calling buildDispatchErrorEvent({ origin, agentName, stage, error, dispatchOptions, startedAt }) returns a DispatchErrorEvent where event.tokenUsage deep-equals { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 }.
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-2: Given a SessionTurnError with estimatedCostUsd = 0.002, calling buildDispatchErrorEvent returns a DispatchErrorEvent where event.estimatedCostUsd === 0.002 (strict numeric equality).", async () => {
    // TODO: Implement acceptance test for AC-2
    // Given a SessionTurnError with estimatedCostUsd = 0.002, calling buildDispatchErrorEvent returns a DispatchErrorEvent where event.estimatedCostUsd === 0.002 (strict numeric equality).
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-3: Given a SessionTurnError with exactCostUsd = 0.003, calling buildDispatchErrorEvent returns a DispatchErrorEvent where event.exactCostUsd === 0.003 (strict numeric equality).", async () => {
    // TODO: Implement acceptance test for AC-3
    // Given a SessionTurnError with exactCostUsd = 0.003, calling buildDispatchErrorEvent returns a DispatchErrorEvent where event.exactCostUsd === 0.003 (strict numeric equality).
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-4: Given a plain new Error('boom') (not a SessionTurnError), calling buildDispatchErrorEvent returns a DispatchErrorEvent where event.tokenUsage === undefined, event.estimatedCostUsd === undefined, and event.exactCostUsd === undefined.", async () => {
    // TODO: Implement acceptance test for AC-4
    // Given a plain new Error('boom') (not a SessionTurnError), calling buildDispatchErrorEvent returns a DispatchErrorEvent where event.tokenUsage === undefined, event.estimatedCostUsd === undefined, and event.exactCostUsd === undefined.
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-5: Given a SessionTurnError with tokenUsage === undefined, calling buildDispatchErrorEvent returns a DispatchErrorEvent where event.tokenUsage === undefined, typeof event.errorCode === 'string' and event.errorCode.length > 0, and typeof event.durationMs === 'number'.", async () => {
    // TODO: Implement acceptance test for AC-5
    // Given a SessionTurnError with tokenUsage === undefined, calling buildDispatchErrorEvent returns a DispatchErrorEvent where event.tokenUsage === undefined, typeof event.errorCode === 'string' and event.errorCode.length > 0, and typeof event.durationMs === 'number'.
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-6: Given dispatchOptions = { storyId: 'S-1', callId: 'c-42', scopeId: 'scope-7', sessionRole: 'coder' }, calling buildDispatchErrorEvent returns a DispatchErrorEvent where event.storyId === 'S-1', event.callId === 'c-42', event.scopeId === 'scope-7', and event.sessionRole === 'coder'.", async () => {
    // TODO: Implement acceptance test for AC-6
    // Given dispatchOptions = { storyId: 'S-1', callId: 'c-42', scopeId: 'scope-7', sessionRole: 'coder' }, calling buildDispatchErrorEvent returns a DispatchErrorEvent where event.storyId === 'S-1', event.callId === 'c-42', event.scopeId === 'scope-7', and event.sessionRole === 'coder'.
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-7: Given dispatchOptions = { storyId: 'S-1' } (sessionRole key absent), calling buildDispatchErrorEvent returns a DispatchErrorEvent where event.sessionRole === undefined.", async () => {
    // TODO: Implement acceptance test for AC-7
    // Given dispatchOptions = { storyId: 'S-1' } (sessionRole key absent), calling buildDispatchErrorEvent returns a DispatchErrorEvent where event.sessionRole === undefined.
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-8: Given a DispatchErrorEvent with tokenUsage = { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 }, exactCostUsd = 0.003, estimatedCostUsd = 0.002, and sessionRole = 'coder', after the cost subscriber processes the event, the aggregator's recorded CostErrorEvent satisfies tokens.input === 100, tokens.output === 50, tokens.cacheRead === 10, tokens.cacheWrite === 5, estimatedCostUsd === 0.002, exactCostUsd === 0.003, and sessionRole === 'coder'.", async () => {
    // TODO: Implement acceptance test for AC-8
    // Given a DispatchErrorEvent with tokenUsage = { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 }, exactCostUsd = 0.003, estimatedCostUsd = 0.002, and sessionRole = 'coder', after the cost subscriber processes the event, the aggregator's recorded CostErrorEvent satisfies tokens.input === 100, tokens.output === 50, tokens.cacheRead === 10, tokens.cacheWrite === 5, estimatedCostUsd === 0.002, exactCostUsd === 0.003, and sessionRole === 'coder'.
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-9: Given a DispatchErrorEvent with tokenUsage === undefined, after the cost subscriber processes the event, the recorded CostErrorEvent satisfies event.tokens === undefined (strictly undefined, not an object with all-zero input/output values).", async () => {
    // TODO: Implement acceptance test for AC-9
    // Given a DispatchErrorEvent with tokenUsage === undefined, after the cost subscriber processes the event, the recorded CostErrorEvent satisfies event.tokens === undefined (strictly undefined, not an object with all-zero input/output values).
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-10: Given a DispatchErrorEvent with exactCostUsd = 0.003 and estimatedCostUsd = 0.002, after the cost subscriber processes the event, the recorded CostErrorEvent satisfies event.costUsd === 0.003 (exactCostUsd takes precedence over estimatedCostUsd).", async () => {
    // TODO: Implement acceptance test for AC-10
    // Given a DispatchErrorEvent with exactCostUsd = 0.003 and estimatedCostUsd = 0.002, after the cost subscriber processes the event, the recorded CostErrorEvent satisfies event.costUsd === 0.003 (exactCostUsd takes precedence over estimatedCostUsd).
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-11: Given a DispatchErrorEvent with estimatedCostUsd = 0.002 and exactCostUsd === undefined, after the cost subscriber processes the event, the recorded CostErrorEvent satisfies event.costUsd === 0.002 (estimatedCostUsd is the fallback).", async () => {
    // TODO: Implement acceptance test for AC-11
    // Given a DispatchErrorEvent with estimatedCostUsd = 0.002 and exactCostUsd === undefined, after the cost subscriber processes the event, the recorded CostErrorEvent satisfies event.costUsd === 0.002 (estimatedCostUsd is the fallback).
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-12: Given two error events recorded with costUsd = 0.002 and costUsd = 0.003 (and no other error events), CostAggregator.snapshot() returns totalErrorCostUsd === 0.005, and totalCostUsd equals the value it had before these error events were recorded (error costs contribute 0 to totalCostUsd).", async () => {
    // TODO: Implement acceptance test for AC-12
    // Given two error events recorded with costUsd = 0.002 and costUsd = 0.003 (and no other error events), CostAggregator.snapshot() returns totalErrorCostUsd === 0.005, and totalCostUsd equals the value it had before these error events were recorded (error costs contribute 0 to totalCostUsd).
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-13: Given a CostErrorEvent recorded with tokens = { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 }, costUsd = 0.003, and errorCode = 'E_TEST', after calling CostAggregator.drain(), parsing each line of the written <runId>.jsonl as JSON yields exactly one row with kind === 'error' where row.tokens deep-equals { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 }, row.costUsd === 0.003, and row.errorCode === 'E_TEST'.", async () => {
    // TODO: Implement acceptance test for AC-13
    // Given a CostErrorEvent recorded with tokens = { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 }, costUsd = 0.003, and errorCode = 'E_TEST', after calling CostAggregator.drain(), parsing each line of the written <runId>.jsonl as JSON yields exactly one row with kind === 'error' where row.tokens deep-equals { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 }, row.costUsd === 0.003, and row.errorCode === 'E_TEST'.
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-14: Stub sendPrompt to throw a SessionTurnError with tokenUsage = { input: 100, output: 50 } and exactCostUsd = 0.003. Calling AgentManager.runAsSession(...) rejects (rethrows the same SessionTurnError instance), and a dispatch-error listener registered via the runtime event stream receives exactly one event with kind === 'error' where event.tokenUsage deep-equals { input: 100, output: 50 } and event.exactCostUsd === 0.003.", async () => {
    // TODO: Implement acceptance test for AC-14
    // Stub sendPrompt to throw a SessionTurnError with tokenUsage = { input: 100, output: 50 } and exactCostUsd = 0.003. Calling AgentManager.runAsSession(...) rejects (rethrows the same SessionTurnError instance), and a dispatch-error listener registered via the runtime event stream receives exactly one event with kind === 'error' where event.tokenUsage deep-equals { input: 100, output: 50 } and event.exactCostUsd === 0.003.
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-15: Given a directory containing 53 files matching the native transcript file pattern (e.g., <name>.transcript.json and failed-<stamp>.transcript.json), when await pruneRetainedTranscripts(dir, 50) resolves, it returns the number 3 and the directory contains exactly 50 transcript files afterwards.", async () => {
    // TODO: Implement acceptance test for AC-15
    // Given a directory containing 53 files matching the native transcript file pattern (e.g., <name>.transcript.json and failed-<stamp>.transcript.json), when await pruneRetainedTranscripts(dir, 50) resolves, it returns the number 3 and the directory contains exactly 50 transcript files afterwards.
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-16: Given a directory containing N transcript files where N < maxRetained (e.g., 10 files with maxRetained = 50), when await pruneRetainedTranscripts(dir, maxRetained) resolves, it returns 0 and the directory still contains exactly N files with identical names and unchanged mtimes (no file is deleted or rewritten).", async () => {
    // TODO: Implement acceptance test for AC-16
    // Given a directory containing N transcript files where N < maxRetained (e.g., 10 files with maxRetained = 50), when await pruneRetainedTranscripts(dir, maxRetained) resolves, it returns 0 and the directory still contains exactly N files with identical names and unchanged mtimes (no file is deleted or rewritten).
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-17: Given a directory with maxRetained + k transcript files whose mtimes are set to distinct known values via fs.utimes, when await pruneRetainedTranscripts(dir, maxRetained) resolves, it returns k and the set of remaining file names is exactly the k files with the newest mtimes that were removed and the maxRetained newest-mtime files that remain; fs.stat confirms the retained files are precisely the maxRetained files with the largest mtimes in their original order.", async () => {
    // TODO: Implement acceptance test for AC-17
    // Given a directory with maxRetained + k transcript files whose mtimes are set to distinct known values via fs.utimes, when await pruneRetainedTranscripts(dir, maxRetained) resolves, it returns k and the set of remaining file names is exactly the k files with the newest mtimes that were removed and the maxRetained newest-mtime files that remain; fs.stat confirms the retained files are precisely the maxRetained files with the largest mtimes in their original order.
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-18: Given a fixture tree <transcriptRoot>/features/<featureName>/sessions containing MAX_RETAINED_TRANSCRIPTS + 3 transcript files, when await sweepFeatureTranscripts({ featureName: 'f', transcriptRoot: root }) resolves, it returns 3, the sessions directory contains exactly MAX_RETAINED_TRANSCRIPTS files, and the derived path matches what deriveNativeTranscriptDir(transcriptRoot, featureName) returns.", async () => {
    // TODO: Implement acceptance test for AC-18
    // Given a fixture tree <transcriptRoot>/features/<featureName>/sessions containing MAX_RETAINED_TRANSCRIPTS + 3 transcript files, when await sweepFeatureTranscripts({ featureName: 'f', transcriptRoot: root }) resolves, it returns 3, the sessions directory contains exactly MAX_RETAINED_TRANSCRIPTS files, and the derived path matches what deriveNativeTranscriptDir(transcriptRoot, featureName) returns.
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-19: Given a sessions directory over MAX_RETAINED_TRANSCRIPTS where the oldest-by-mtime files include one named <name>.transcript.json and one named failed-<stamp>.transcript.json, when await sweepFeatureTranscripts({ featureName, transcriptRoot }) resolves, both the live-name file and the failed- file are absent from the directory and the returned count reflects both deletions (neither filename pattern is exempt from pruning).", async () => {
    // TODO: Implement acceptance test for AC-19
    // Given a sessions directory over MAX_RETAINED_TRANSCRIPTS where the oldest-by-mtime files include one named <name>.transcript.json and one named failed-<stamp>.transcript.json, when await sweepFeatureTranscripts({ featureName, transcriptRoot }) resolves, both the live-name file and the failed- file are absent from the directory and the returned count reflects both deletions (neither filename pattern is exempt from pruning).
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-20: Given a fixture tree under transcriptRoot containing transcript files, when await sweepFeatureTranscripts({ transcriptRoot }) resolves, it returns 0, no file under transcriptRoot is deleted (directory contents byte-identical), and deriveNativeTranscriptDir is never invoked with a feature name (no disk access under the features path).", async () => {
    // TODO: Implement acceptance test for AC-20
    // Given a fixture tree under transcriptRoot containing transcript files, when await sweepFeatureTranscripts({ transcriptRoot }) resolves, it returns 0, no file under transcriptRoot is deleted (directory contents byte-identical), and deriveNativeTranscriptDir is never invoked with a feature name (no disk access under the features path).
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-21: Given featureName is provided but transcriptRoot is undefined, when await sweepFeatureTranscripts({ featureName }) resolves, it returns 0 and no filesystem calls occur (assert via injected/mocked fs deps or fs spy: zero read/write/unlink calls).", async () => {
    // TODO: Implement acceptance test for AC-21
    // Given featureName is provided but transcriptRoot is undefined, when await sweepFeatureTranscripts({ featureName }) resolves, it returns 0 and no filesystem calls occur (assert via injected/mocked fs deps or fs spy: zero read/write/unlink calls).
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-22: Given a sessions directory containing MAX_RETAINED_TRANSCRIPTS + 3 transcript files, when await sweepFeatureTranscripts({ featureName, transcriptRoot, dryRun: true }) resolves, it returns 0 and the directory still contains all MAX_RETAINED_TRANSCRIPTS + 3 files (no unlink calls made).", async () => {
    // TODO: Implement acceptance test for AC-22
    // Given a sessions directory containing MAX_RETAINED_TRANSCRIPTS + 3 transcript files, when await sweepFeatureTranscripts({ featureName, transcriptRoot, dryRun: true }) resolves, it returns 0 and the directory still contains all MAX_RETAINED_TRANSCRIPTS + 3 files (no unlink calls made).
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-23: Given featureName and transcriptRoot such that deriveNativeTranscriptDir yields a path that does not exist on disk, when await sweepFeatureTranscripts({ featureName, transcriptRoot }) resolves, it returns 0 and rejects neither (handles the missing-directory stat error internally, e.g., ENOENT), and no directory is created.", async () => {
    // TODO: Implement acceptance test for AC-23
    // Given featureName and transcriptRoot such that deriveNativeTranscriptDir yields a path that does not exist on disk, when await sweepFeatureTranscripts({ featureName, transcriptRoot }) resolves, it returns 0 and rejects neither (handles the missing-directory stat error internally, e.g., ENOENT), and no directory is created.
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-24: With sweepFeatureTranscripts replaced by a test double (via module mock or injectable dep), when setupRun executes for a run with feature 'F' and runtime.outputDir = '/out', it calls the stub exactly once with a single options object satisfying { featureName: 'F', transcriptRoot: '/out' }, where '/out' is the same value threaded to SessionManager as transcriptRoot.", async () => {
    // TODO: Implement acceptance test for AC-24
    // With sweepFeatureTranscripts replaced by a test double (via module mock or injectable dep), when setupRun executes for a run with feature 'F' and runtime.outputDir = '/out', it calls the stub exactly once with a single options object satisfying { featureName: 'F', transcriptRoot: '/out' }, where '/out' is the same value threaded to SessionManager as transcriptRoot.
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-25: With sweepFeatureTranscripts stubbed and a run whose runtime.dryRun === true, when setupRun executes, the recorded stub call includes dryRun: true in its options object (assert deep-equal on the options: { featureName: <run feature>, transcriptRoot: <outputDir>, dryRun: true }).", async () => {
    // TODO: Implement acceptance test for AC-25
    // With sweepFeatureTranscripts stubbed and a run whose runtime.dryRun === true, when setupRun executes, the recorded stub call includes dryRun: true in its options object (assert deep-equal on the options: { featureName: <run feature>, transcriptRoot: <outputDir>, dryRun: true }).
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-26: When runInSession is invoked with declaredTools non-empty, codingToolRoot set, outputDir set, and request.runOptions.codingToolRuntime undefined, the runtime injected into the runner resolves auditDir via toolAuditDir(root, outputDir) and dispatching a tool call through that runtime appends a JSONL ledger record whose filename is buildLedgerSessionName(storyId) under that auditDir; assert the file exists and contains one record after dispatch.", async () => {
    // TODO: Implement acceptance test for AC-26
    // When runInSession is invoked with declaredTools non-empty, codingToolRoot set, outputDir set, and request.runOptions.codingToolRuntime undefined, the runtime injected into the runner resolves auditDir via toolAuditDir(root, outputDir) and dispatching a tool call through that runtime appends a JSONL ledger record whose filename is buildLedgerSessionName(storyId) under that auditDir; assert the file exists and contains one record after dispatch.
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-27: Given request.runOptions.codingToolRuntime is undefined and declaredTools is a non-empty array, runTrackedSession invokes the runner with runOptions.codingTools deep-equal to the advertised tool descriptors produced for declaredTools (the codingTools field of the CodingToolSupport returned by resolveCodingToolSupport); assert via a runner stub capturing received runOptions.", async () => {
    // TODO: Implement acceptance test for AC-27
    // Given request.runOptions.codingToolRuntime is undefined and declaredTools is a non-empty array, runTrackedSession invokes the runner with runOptions.codingTools deep-equal to the advertised tool descriptors produced for declaredTools (the codingTools field of the CodingToolSupport returned by resolveCodingToolSupport); assert via a runner stub capturing received runOptions.
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-28: Given request.runOptions.codingToolRuntime is a non-undefined runtime instance R, runTrackedSession does not call resolveCodingToolSupport to build a replacement and the runner receives runOptions.codingToolRuntime === R (identity comparison via toBe); the caller's runtime audit directory and ledger are untouched by runTrackedSession.", async () => {
    // TODO: Implement acceptance test for AC-28
    // Given request.runOptions.codingToolRuntime is a non-undefined runtime instance R, runTrackedSession does not call resolveCodingToolSupport to build a replacement and the runner receives runOptions.codingToolRuntime === R (identity comparison via toBe); the caller's runtime audit directory and ledger are untouched by runTrackedSession.
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-29: Given declaredTools is an empty array and request.runOptions.codingToolRuntime is undefined, runTrackedSession invokes the runner with runOptions.codingToolRuntime === undefined and runOptions.codingTools === undefined (no codingTool keys injected); assert via a runner stub capturing received runOptions.", async () => {
    // TODO: Implement acceptance test for AC-29
    // Given declaredTools is an empty array and request.runOptions.codingToolRuntime is undefined, runTrackedSession invokes the runner with runOptions.codingToolRuntime === undefined and runOptions.codingTools === undefined (no codingTool keys injected); assert via a runner stub capturing received runOptions.
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-30: Given declaredTools.length > 0 and codingToolRoot === \"\", runTrackedSession returns a rejected promise whose error is an instance of NaxError with error.code === \"CODING_TOOL_ROOT_MISSING\"; assert with await expect(...).rejects.toMatchObject({ code: \"CODING_TOOL_ROOT_MISSING\" }).", async () => {
    // TODO: Implement acceptance test for AC-30
    // Given declaredTools.length > 0 and codingToolRoot === "", runTrackedSession returns a rejected promise whose error is an instance of NaxError with error.code === "CODING_TOOL_ROOT_MISSING"; assert with await expect(...).rejects.toMatchObject({ code: "CODING_TOOL_ROOT_MISSING" }).
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-31: When runInSession executes with declaredTools non-empty and request.runOptions.codingToolRuntime undefined, the runner stub receives a runOptions object where runOptions.codingToolRuntime !== undefined, and immediately after the runner receives the request, the tracked session state (as observed by the runner, e.g., via session state passed in context) equals RUNNING.", async () => {
    // TODO: Implement acceptance test for AC-31
    // When runInSession executes with declaredTools non-empty and request.runOptions.codingToolRuntime undefined, the runner stub receives a runOptions object where runOptions.codingToolRuntime !== undefined, and immediately after the runner receives the request, the tracked session state (as observed by the runner, e.g., via session state passed in context) equals RUNNING.
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-32: Given _planDeps.claimProjectIdentity is stubbed to reject with a NaxError whose code property is RUN_NAME_COLLISION, when planCommand(workdir, config, options) is called, the returned promise rejects with an Error instance whose code property equals RUN_NAME_COLLISION.", async () => {
    // TODO: Implement acceptance test for AC-32
    // Given _planDeps.claimProjectIdentity is stubbed to reject with a NaxError whose code property is RUN_NAME_COLLISION, when planCommand(workdir, config, options) is called, the returned promise rejects with an Error instance whose code property equals RUN_NAME_COLLISION.
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-33: Given _planDeps.claimProjectIdentity rejects with a NaxError whose code is RUN_NAME_COLLISION, when planCommand is called and the rejection propagates, the plan strategy object returned by createPlanStrategy has its execute method invocation count equal to 0 (verified via a spy/mock).", async () => {
    // TODO: Implement acceptance test for AC-33
    // Given _planDeps.claimProjectIdentity rejects with a NaxError whose code is RUN_NAME_COLLISION, when planCommand is called and the rejection propagates, the plan strategy object returned by createPlanStrategy has its execute method invocation count equal to 0 (verified via a spy/mock).
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-34: Given _planDeps.claimProjectIdentity is a mock whose implementation records (projectKey, workdir, remoteUrl) and resolves, when planCommand('wd', config, options) is called, the recorded call has workdir === 'wd', and the plan strategy execute spy has invocation count 1.", async () => {
    // TODO: Implement acceptance test for AC-34
    // Given _planDeps.claimProjectIdentity is a mock whose implementation records (projectKey, workdir, remoteUrl) and resolves, when planCommand('wd', config, options) is called, the recorded call has workdir === 'wd', and the plan strategy execute spy has invocation count 1.
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-35: Given _planDeps.claimProjectIdentity is stubbed to resolve (no rejection), when planCommand is called, the claimProjectIdentity spy has invocation count 1, the plan strategy execute spy has invocation count 1, and the claimProjectIdentity mock resolves without throwing (idempotent same-workdir claim update including lastSeen).", async () => {
    // TODO: Implement acceptance test for AC-35
    // Given _planDeps.claimProjectIdentity is stubbed to resolve (no rejection), when planCommand is called, the claimProjectIdentity spy has invocation count 1, the plan strategy execute spy has invocation count 1, and the claimProjectIdentity mock resolves without throwing (idempotent same-workdir claim update including lastSeen).
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-36: Given config.name = '  myproj  ', when planCommand is called, _planDeps.claimProjectIdentity is invoked with its first argument (projectKey) equal to 'myproj' (config.name.trim(), not basename(workdir)).", async () => {
    // TODO: Implement acceptance test for AC-36
    // Given config.name = '  myproj  ', when planCommand is called, _planDeps.claimProjectIdentity is invoked with its first argument (projectKey) equal to 'myproj' (config.name.trim(), not basename(workdir)).
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-37: Given config.name is undefined (and separately given config.name = '   '), when planCommand('/abs/path/to/wd', config, options) is called, _planDeps.claimProjectIdentity is invoked with its first argument (projectKey) equal to 'wd' (basename(workdir)) in both cases.", async () => {
    // TODO: Implement acceptance test for AC-37
    // Given config.name is undefined (and separately given config.name = '   '), when planCommand('/abs/path/to/wd', config, options) is called, _planDeps.claimProjectIdentity is invoked with its first argument (projectKey) equal to 'wd' (basename(workdir)) in both cases.
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-38: Given _planDeps.spawnSync is stubbed to return { status: 0, stdout: '  https://example.com/repo.git  \\n' } for args ['git', 'remote', 'get-url', 'origin'], when planCommand is called, _planDeps.claimProjectIdentity is invoked with its third argument (remoteUrl) equal to 'https://example.com/repo.git' (trimmed stdout).", async () => {
    // TODO: Implement acceptance test for AC-38
    // Given _planDeps.spawnSync is stubbed to return { status: 0, stdout: '  https://example.com/repo.git  \n' } for args ['git', 'remote', 'get-url', 'origin'], when planCommand is called, _planDeps.claimProjectIdentity is invoked with its third argument (remoteUrl) equal to 'https://example.com/repo.git' (trimmed stdout).
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-39: Given _planDeps.spawnSync is stubbed to return { status: 128, stdout: '', stderr: 'fatal: ...' } (and separately null status), when planCommand is called, _planDeps.claimProjectIdentity is invoked with its third argument (remoteUrl) strictly equal to null.", async () => {
    // TODO: Implement acceptance test for AC-39
    // Given _planDeps.spawnSync is stubbed to return { status: 128, stdout: '', stderr: 'fatal: ...' } (and separately null status), when planCommand is called, _planDeps.claimProjectIdentity is invoked with its third argument (remoteUrl) strictly equal to null.
    expect(true).toBe(true); // Replace with actual test
  });

  test("AC-40: Given _planDeps.claimProjectIdentity rejects with an Error whose code is 'SOME_OTHER_CODE' (e.g. 'EPERM'), when planCommand is called, the returned promise resolves (does not reject), the rejection is swallowed (warn-and-proceed), and the plan strategy execute spy has invocation count 1.", async () => {
    // TODO: Implement acceptance test for AC-40
    // Given _planDeps.claimProjectIdentity rejects with an Error whose code is 'SOME_OTHER_CODE' (e.g. 'EPERM'), when planCommand is called, the returned promise resolves (does not reject), the rejection is swallowed (warn-and-proceed), and the plan strategy execute spy has invocation count 1.
    expect(true).toBe(true); // Replace with actual test
  });
});
