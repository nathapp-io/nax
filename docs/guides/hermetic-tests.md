---
title: Hermetic Test Enforcement
description: Status of the quality.testing config keys
---

## Hermetic Test Enforcement

The `quality.testing` config keys (`hermetic`, `externalBoundaries`, `mockGuidance`) have been removed. Config loading warns and strips `quality.testing`; no hermetic-test requirement is injected into prompts from these keys.

To steer agents toward hermetic tests, state test and mocking policy in a project `.nax/rules/` file (for example "mock all I/O; use `ioredis-mock` for Redis").

---

[Back to README](../../README.md)
