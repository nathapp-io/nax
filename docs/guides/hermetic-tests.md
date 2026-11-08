---
title: Hermetic Test Enforcement
description: Status of the quality.testing config keys
---

## Hermetic Test Enforcement

The `quality.testing` config keys (`hermetic`, `externalBoundaries`, `mockGuidance`) are accepted by config validation, including per-package overrides in monorepos, but they currently have no effect. Nothing in nax reads them, and no hermetic-test requirement is injected into any prompt. The keys are kept in the schema so existing configs keep loading; tracking is in #2832.

To steer agents toward hermetic tests, state the rule in `.nax/rules/` or `context.md` (for example "mock all I/O; use `ioredis-mock` for Redis").

---

[Back to README](../../README.md)
