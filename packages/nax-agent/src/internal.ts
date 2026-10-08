/**
 * @nathapp/nax-agent/internal: what nax reaches below the public entry -- shared
 * helpers, NaxError, deep modules and the _*Deps test seams.
 *
 * NAX-ONLY AND OUTSIDE SEMVER. Nothing here is a supported API for any other
 * consumer: names, shapes and behaviour change in any release, patch included.
 * It exists because nax bundles this package and its tests patch the seams. It
 * re-exports the same module instances, so patching a seam here patches the
 * object the agent reads. `.` exports no "_" name; every seam and reset hook
 * lives here (S2 spec section 5.3).
 *
 * Written by the S1-5 move script; maintained by hand from here on.
 */

export * from "#src/coding-tools/coding-tool-bash";
export * from "#src/coding-tools/coding-tool-sandbox";
export * from "#src/coding-tools/coding-tool-support";
export * as codingToolSupportModule from "#src/coding-tools/coding-tool-support";
export * from "#src/coding-tools/universal-coding-tools";
export * from "#src/command-interceptor/index";
export { _commandShadowDeps } from "#src/command-safety/shadow";
export { _systemOneClientDeps } from "#src/command-safety/systemone-client";
export * from "#src/config/bash-approval";
export * from "#src/config/catalog-overrides";
export * from "#src/config/native-agent/index";
export * from "#src/config/schemas-sandbox";
export * as coreModule from "#src/cost/core/index";
export * from "#src/infra/errors";
export * from "#src/infra/index";
export * as infraModule from "#src/infra/index";
export * from "#src/infra/spin-breaker/index";
export * from "#src/internal/agent-output-env";
export * from "#src/internal/argv-exec";
export * from "#src/internal/atomic-write";
export * from "#src/internal/command-spec/index";
export * from "#src/internal/file-lock";
export * from "#src/internal/git-add";
export * from "#src/internal/git-env";
export * from "#src/internal/git-exec";
export * as gitExecModule from "#src/internal/git-exec";
export * from "#src/internal/path-file-lock";
export * from "#src/internal/process-alive";
export * from "#src/internal/process-kill";
export * from "#src/internal/realpath";
export * from "#src/internal/redact";
export * from "#src/internal/shell-quote";
export * from "#src/internal/sort";
export * from "#src/internal/strip-control-chars";
export * from "#src/internal/thenable";
export * from "#src/native/adapter-deps";
export * from "#src/native/auth";
export * from "#src/native/client";
export * from "#src/native/credentials/chained-store";
export * from "#src/native/credentials/change-guard";
export * from "#src/native/credentials/exec-source";
export * from "#src/native/credentials/fingerprint";
export * from "#src/native/credentials/index";
export * from "#src/native/errors";
export * from "#src/native/model-resolver";
export * from "#src/native/models";
export * from "#src/native/session/compaction";
export { DEFAULT_INSTRUCTION_FILE_NAME, isInstructionFileName } from "#src/native/session/instruction-file-name";
export * from "#src/native/session/loop-events/external-handler";
export * from "#src/native/session/loop-events/index";
export * from "#src/native/session/loop-events/types";
export * from "#src/native/session/memory-transcript-store";
export { _repositoryInstructionDeps } from "#src/native/session/repository-instructions";
export * from "#src/native/session/session";
export * as sessionModule from "#src/native/session/session";
export * from "#src/native/session/tool-mapping";
export * from "#src/native/session/transcript-identity";
export * from "#src/native/session/transcript-store";
export * as transcriptStoreModule from "#src/native/session/transcript-store";
export * from "#src/native/session/transcript-types";
export * from "#src/native/session/turn-accumulator";
export * from "#src/native/session/turn-complete-step";
export * from "#src/native/session/turn-events";
export * from "#src/native/session/turn-loop";
export * from "#src/native/session/turn-retry";
export * from "#src/native/session/turn-types";
export { nativeSessionStateOf } from "#src/native/session-adapter";
export * from "#src/native/session-affinity";
export * from "#src/permissions/index";
export * from "#src/sandbox/index";
export * as policyInputsModule from "#src/sandbox/policy-inputs";
export * from "#src/session/agent-session-deps";
export * from "#src/tools/credential-read-deny";
export * from "#src/tools/git";
export * from "#src/tools/git-commit";
export * from "#src/tools/grep";
export * from "#src/tools/index";
export { _instructionAccessDeps } from "#src/tools/instruction-access";
// S3-2: the port (nax supplies the policy behind it from its own module).
export * from "#src/tools/owned-paths";
export * from "#src/tools/package-managers";
export * from "#src/tools/policy";
export * from "#src/tools/provider-grants";
export * as readFileModule from "#src/tools/read-file";
export * from "#src/tools/registry";
export * from "#src/tools/run-command";
export * from "#src/tools/run-command-exec";
export * from "#src/tools/runtime";
export * from "#src/tools/tool-audit";
export * as truncateModule from "#src/tools/truncate";
