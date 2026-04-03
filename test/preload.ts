/**
 * Bun test preload — runs once before any test file in this process.
 *
 * Clears environment variables that may be inherited from a parent nax session.
 * Tests that need these variables set them explicitly in beforeEach/afterEach.
 */

// NAX_GLOBAL_CONFIG_DIR may be set by the nax harness to a temp dir for the
// session. The paths integration test expects globalConfigDir() to return
// ~/.nax (the default) when the env var is not set. Clear it here so the
// test environment starts clean; individual tests save/restore it as needed.
delete process.env.NAX_GLOBAL_CONFIG_DIR;
