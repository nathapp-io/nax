import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// All criteria are runtime checks. A fresh global directory and restored seams
// isolate credential and CLI state from the user's actual installation.
let root: string;
let dir: string;
let output: string[];
let restores: Array<() => void>;
const originalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
const originalProfile = process.env.NAX_PROFILE;
const ansi = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const clean = (s: string) => s.replace(ansi, '');
function replace(target: any, name: string, value: any) {
  const old = target[name];
  target[name] = value;
  restores.push(() => { target[name] = old; });
}
function configFile(auth: unknown = { source: 'file' }) {
  writeFileSync(path.join(root, 'config.json'), JSON.stringify({ auth }));
}
function profile(name: string, value: unknown = {}) {
  mkdirSync(path.join(root, 'profiles'), { recursive: true });
  writeFileSync(path.join(root, 'profiles', `${name}.json`), JSON.stringify(value));
}
function projectConfig(value: unknown = {}) {
  mkdirSync(path.join(dir, '.nax'), { recursive: true });
  writeFileSync(path.join(dir, '.nax', 'config.json'), JSON.stringify(value));
}
function helper(reply: unknown, exit = 0) {
  const file = path.join(root, 'helper.sh');
  const text = JSON.stringify(reply).replaceAll("'", "'\\''");
  writeFileSync(file, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${text}'\nexit ${exit}\n`);
  chmodSync(file, 0o755);
  configFile({ source: 'exec', exec: { command: [file, '--x'], timeoutMs: 10000 } });
  return file;
}
async function stored(id = 'openai', value: any = { kind: 'api-key', key: 'sk-stored' }) {
  const { naxCredentialStore } = await import('@/agents/native/credentials');
  await naxCredentialStore().modify(id, async () => value);
}
async function authSetup() {
  const { _authDeps } = await import('@/agents/native/auth');
  const { _cliAuthDeps } = await import('@/cli/auth');
  const { _resetCredentialStore } = await import('@/agents/native/credentials');
  _resetCredentialStore();
  replace(_authDeps, 'ambientAuthAvailable', mock(async () => false));
  replace(_cliAuthDeps, 'log', (s: string) => output.push(s));
  restores.push(_resetCredentialStore);
  return { _authDeps, _cliAuthDeps };
}
async function list(ids: string[] = []) {
  const { collectAuthList } = await import('@/cli/auth-list');
  return await collectAuthList(ids);
}
async function authCommand(ids: string[] = [], options?: { json: true }) {
  const { authListCommand } = await import('@/cli/auth');
  return await authListCommand(ids, options);
}
async function jsonCommand(options: any = {}) {
  const { configJsonCommand } = await import('@/cli/config-json');
  const code = await configJsonCommand({ dir, profile: [], ...options });
  return { code, document: JSON.parse(output[0]), text: output[0] };
}
async function jsonSetup() {
  const { _configJsonDeps } = await import('@/cli/config-json');
  replace(_configJsonDeps, 'log', (s: string) => output.push(s));
  return _configJsonDeps;
}
const nativeConfig = () => ({ agent: { default: 'native' }, models: { native: { fast: 'openai/gpt-a', balanced: 'deepseek/ds-b', powerful: 'openai/gpt-c' } } }) as any;
const cfg = (agent: string, extras: any = {}) => ({ agent: { default: agent }, ...extras }) as any;
const provider = (report: any, id: string) => {
  const found = report.providers.find((p: any) => p.providerId === id);
  expect(found).toBeDefined();
  return found;
};
const fixedReport = { source: 'file', providers: [{ providerId: 'mistral', stored: null, ambient: false, available: false }] };
async function mockedAuthReport(report: any = fixedReport) {
  const { _cliAuthDeps } = await import('@/cli/auth');
  const spy = mock(async () => report);
  replace(_cliAuthDeps, 'collectAuthList', spy);
  return spy;
}
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'nax-json-global-'));
  dir = mkdtempSync(path.join(tmpdir(), 'nax-json-project-'));
  process.env.NAX_GLOBAL_CONFIG_DIR = root;
  delete process.env.NAX_PROFILE;
  output = [];
  restores = [];
});
afterEach(() => {
  for (const restore of restores.reverse()) restore();
  if (originalDir === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
  else process.env.NAX_GLOBAL_CONFIG_DIR = originalDir;
  if (originalProfile === undefined) delete process.env.NAX_PROFILE;
  else process.env.NAX_PROFILE = originalProfile;
  rmSync(root, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

test('AC-1: openai tiers preserve iteration order', async () => {
  const { nativeTierProviders } = await import('@/agents/native');
  expect(nativeTierProviders(nativeConfig()).get('openai')).toEqual(['fast', 'powerful']);
});
test('AC-2: deepseek has only balanced tier', async () => {
  const { nativeTierProviders } = await import('@/agents/native');
  expect(nativeTierProviders(nativeConfig()).get('deepseek')).toEqual(['balanced']);
});
test('AC-3: object model provider comes from model id prefix', async () => {
  const { nativeTierProviders } = await import('@/agents/native');
  const map = nativeTierProviders(cfg('native', { models: { native: { fast: { provider: 'anthropic', model: 'anthropic/claude-x' } } } }));
  expect(map.has('anthropic')).toBe(true);
  expect(map.get('anthropic')).toEqual(['fast']);
});
test('AC-4: unqualified model id gives empty map', async () => {
  const { nativeTierProviders } = await import('@/agents/native');
  const map = nativeTierProviders(cfg('native', { models: { native: { fast: 'gpt-a' } } }));
  expect(map).toBeInstanceOf(Map); expect(map.size).toBe(0); expect([...map.keys()]).toHaveLength(0);
});
test('AC-5: catalog-overridden provider is excluded', async () => {
  const { nativeTierProviders } = await import('@/agents/native');
  const map = nativeTierProviders({ agent: { default: 'native', native: { catalogOverrides: [{ provider: 'local' }] } }, models: { native: { fast: 'local/m' } } } as any);
  expect(map.size).toBe(0); expect(map.has('local')).toBe(false);
});
test('AC-6: absent models or native map gives empty map', async () => {
  const { nativeTierProviders } = await import('@/agents/native');
  for (const config of [cfg('native'), cfg('native', { models: {} })]) {
    const map = nativeTierProviders(config);
    expect(map).toBeInstanceOf(Map); expect(map.size).toBe(0); expect([...map.entries()]).toEqual([]);
  }
});
test('AC-7: missing credentials probe receives exactly the map keys', async () => {
  const { _nativeCredentialDeps, findMissingNativeCredentials } = await import('@/precheck/checks-native-credentials');
  replace(_nativeCredentialDeps, 'nativeTierProviders', mock(() => new Map([['x-provider', ['fast']]])));
  const probe = mock(async () => []);
  replace(_nativeCredentialDeps, 'providersWithoutCredentials', probe);
  await findMissingNativeCredentials(cfg('native'));
  expect(probe).toHaveBeenCalledTimes(1); expect(probe).toHaveBeenCalledWith(['x-provider']);
});
test('AC-8: missing credentials preserve provider and tiers', async () => {
  const { _nativeCredentialDeps, findMissingNativeCredentials } = await import('@/precheck/checks-native-credentials');
  replace(_nativeCredentialDeps, 'nativeTierProviders', mock(() => new Map([['x-provider', ['fast']]])));
  replace(_nativeCredentialDeps, 'providersWithoutCredentials', mock(async () => ['x-provider']));
  expect(await findMissingNativeCredentials(cfg('native'))).toEqual([{ provider: 'x-provider', tiers: ['fast'] }]);
});

test('AC-9: file auth report names file source', async () => { await authSetup(); configFile(); await stored(); expect((await list()).source).toBe('file'); });
test('AC-10: file report omits helper', async () => { await authSetup(); configFile(); await stored(); const r: any = await list(); expect(Object.prototype.hasOwnProperty.call(r, 'helper')).toBe(false); expect(r.helper).toBeUndefined(); });
test('AC-11: api-key without expiry has exact stored shape', async () => { await authSetup(); configFile(); await stored(); expect(provider(await list(), 'openai').stored).toEqual({ kind: 'api-key', expired: false }); });
test('AC-12: file provider omits exec field', async () => { await authSetup(); configFile(); await stored(); const p = provider(await list(), 'openai'); expect(Object.prototype.hasOwnProperty.call(p, 'exec')).toBe(false); expect(p.exec).toBeUndefined(); });
test('AC-13: stored credentials make provider available even without ambient auth', async () => { await authSetup(); configFile(); await stored(); expect(provider(await list(), 'openai').available).toBe(true); });
test('AC-14: oauth expiry is ISO timestamp', async () => { await authSetup(); configFile(); await stored('openai', { kind: 'oauth', access: 'x', refresh: 'y', expires: 1000 }); expect(provider(await list(), 'openai').stored.expires).toBe('1970-01-01T00:00:01.000Z'); });
test('AC-15: past oauth expiry is expired', async () => { await authSetup(); configFile(); await stored('openai', { kind: 'oauth', access: 'x', refresh: 'y', expires: 1000 }); expect(provider(await list(), 'openai').stored.expired).toBe(true); });
test('AC-16: requested provider without stored credentials has null stored', async () => { await authSetup(); configFile(); expect(provider(await list(['mistral']), 'mistral').stored).toBeNull(); });
test('AC-17: no stored or ambient credentials means unavailable', async () => { await authSetup(); configFile(); expect(provider(await list(['mistral']), 'mistral').available).toBe(false); });
test('AC-18: ambient probe true appears in report', async () => { const { _authDeps } = await authSetup(); configFile(); _authDeps.ambientAuthAvailable = mock(async () => true); expect(provider(await list(['mistral']), 'mistral').ambient).toBe(true); });
test('AC-19: ambient auth alone makes file provider available', async () => { const { _authDeps } = await authSetup(); configFile(); _authDeps.ambientAuthAvailable = mock(async () => true); const p = provider(await list(['mistral']), 'mistral'); expect(p.ambient).toBe(true); expect(p.available).toBe(true); });
test('AC-20: failed ambient probe is treated as false without rejection', async () => { const { _authDeps } = await authSetup(); configFile(); _authDeps.ambientAuthAvailable = mock(async () => { throw Error('probe failed'); }); expect(provider(await list(['mistral']), 'mistral').ambient).toBe(false); });
test('AC-21: exec report echoes configured helper command verbatim', async () => { await authSetup(); const file = helper({ version: 1, decline: true }); expect((await list()).helper.command).toEqual([file, '--x']); });
test('AC-22: helper-served provider carries account stamp', async () => { await authSetup(); helper({ version: 1, kind: 'api-key', key: 'sk-helper', account: 'team-a' }); expect(provider(await list(['deepseek']), 'deepseek').exec).toEqual({ status: 'served', account: 'team-a' }); });
test('AC-23: served helper makes provider available', async () => { await authSetup(); helper({ version: 1, kind: 'api-key', key: 'sk-helper', account: 'team-a' }); expect(provider(await list(['deepseek']), 'deepseek').available).toBe(true); });
test('AC-24: helper account ANSI sequences are stripped', async () => { await authSetup(); helper({ version: 1, kind: 'api-key', key: 'sk-helper', account: '\x1b[31mteam-a\x1b[0m' }); const e = provider(await list(['deepseek']), 'deepseek').exec; expect(e.status).toBe('served'); expect(e.account).toBe('team-a'); expect(e.account).not.toContain(String.fromCharCode(27)); });
test('AC-25: declined helper has exact status and no account', async () => { await authSetup(); helper({ version: 1, decline: true }); await stored(); expect(provider(await list(), 'openai').exec).toEqual({ status: 'declined' }); });
test('AC-26: declined helper falls back to stored credentials', async () => { await authSetup(); helper({ version: 1, decline: true }); await stored(); expect(provider(await list(), 'openai').available).toBe(true); });
test('AC-27: declined helper without stored or ambient auth is unavailable', async () => { await authSetup(); helper({ version: 1, decline: true }); expect(provider(await list(['mistral']), 'mistral').available).toBe(false); });
test('AC-28: helper exit failure has fallback error code', async () => { await authSetup(); helper({ version: 1, decline: true }, 1); await stored(); expect(provider(await list(), 'openai').exec).toEqual({ status: 'error', code: 'CREDENTIAL_HELPER_FAILED' }); });
test('AC-29: helper failure fails closed despite stored credentials', async () => { await authSetup(); helper({ version: 1, decline: true }, 1); await stored(); expect(provider(await list(), 'openai').available).toBe(false); });
test('AC-30: report never exposes helper secret', async () => { await authSetup(); helper({ version: 1, kind: 'api-key', key: 'sk-helper-secret' }); const r = await list(['deepseek']); expect(JSON.stringify(r).indexOf('sk-helper-secret')).toBe(-1); for (const p of r.providers) expect(Object.values(p)).not.toContain('sk-helper-secret'); });
test('AC-31: providers sort lexicographically', async () => { await authSetup(); configFile(); await stored('openai'); await stored('anthropic'); expect((await list()).providers.map((p: any) => p.providerId)).toEqual(['anthropic', 'openai']); });
test('AC-32: empty credentials return empty provider array', async () => { await authSetup(); configFile(); const r = await list(); expect(Array.isArray(r.providers)).toBe(true); expect(r.providers).toHaveLength(0); });

test('AC-33: JSON auth command calls collector once with requested providers', async () => { await authSetup(); const spy = await mockedAuthReport(); await authCommand(['mistral'], { json: true }); expect(spy).toHaveBeenCalledTimes(1); expect(spy).toHaveBeenCalledWith(['mistral']); });
test('AC-34: JSON auth command prints exact report document', async () => { await authSetup(); await mockedAuthReport(); await authCommand(['mistral'], { json: true }); expect(output).toHaveLength(1); expect(output[0]).toBe(JSON.stringify(fixedReport, null, 2)); expect(JSON.parse(output[0])).toEqual(fixedReport); });
test('AC-35: JSON auth command logs once without ANSI', async () => { await authSetup(); await mockedAuthReport(); await authCommand(['mistral'], { json: true }); expect(output).toHaveLength(1); expect(output[0]).not.toMatch(ansi); });
test('AC-36: successful JSON auth command returns zero', async () => { await authSetup(); await mockedAuthReport(); expect(await authCommand(['mistral'], { json: true })).toBe(0); });
test('AC-37: empty JSON auth report includes empty providers', async () => { await authSetup(); await mockedAuthReport({ source: 'file', providers: [] }); await authCommand([], { json: true }); expect(output).toHaveLength(1); expect(JSON.parse(output[0]).providers).toEqual([]); });
test('AC-38: real JSON auth command lists stored openai', async () => { await authSetup(); configFile(); await stored(); expect(await authCommand([], { json: true })).toBe(0); expect(JSON.parse(output[0]).providers.map((p: any) => p.providerId)).toEqual(['openai']); });
test('AC-39: helper failure still returns success for listing', async () => { await authSetup(); helper({ version: 1, decline: true }, 1); await stored(); expect(await authCommand([], { json: true })).toBe(0); expect(provider(JSON.parse(output[0]), 'openai').exec.status).toBe('error'); });
test('AC-40: invalid exec config returns one', async () => { await authSetup(); configFile({ source: 'exec' }); expect(await authCommand([], { json: true })).toBe(1); });
test('AC-41: invalid exec config emits AUTH_CONFIG_INVALID', async () => { await authSetup(); configFile({ source: 'exec' }); await authCommand([], { json: true }); expect(JSON.parse(output[0]).error.code).toBe('AUTH_CONFIG_INVALID'); });
test('AC-42: invalid exec config emits nonempty error message', async () => { await authSetup(); configFile({ source: 'exec' }); await authCommand([], { json: true }); const msg = JSON.parse(output[0]).error.message; expect(typeof msg).toBe('string'); expect(msg.length).toBeGreaterThan(0); });
test('AC-43: damaged credentials produce CREDENTIAL_FILE_UNREADABLE', async () => { await authSetup(); configFile(); writeFileSync(path.join(root, 'credentials'), '{invalid'); await authCommand([], { json: true }); expect(JSON.parse(output[0]).error.code).toBe('CREDENTIAL_FILE_UNREADABLE'); });
test('AC-44: unknown collector failure produces AUTH_LIST_FAILED', async () => { await authSetup(); const { _cliAuthDeps } = await import('@/cli/auth'); replace(_cliAuthDeps, 'collectAuthList', mock(async () => { throw Error('boom'); })); await authCommand([], { json: true }); expect(JSON.parse(output[0]).error.code).toBe('AUTH_LIST_FAILED'); });
test('AC-45: text listing starts with file source header', async () => { await authSetup(); configFile(); await stored(); await authCommand([]); expect(output[0]).toBe('Credential source: file'); });
test('AC-46: text listing indents openai row', async () => { await authSetup(); configFile(); await stored(); await authCommand([]); expect(clean(output[1]).startsWith('  openai')).toBe(true); });
const execReport = { source: 'exec', helper: { command: ['cred', '--x'] }, providers: [{ providerId: 'deepseek', stored: null, ambient: false, exec: { status: 'served', account: 'team-a' }, available: true }] };
test('AC-47: text header includes exec command', async () => { await authSetup(); await mockedAuthReport(execReport); await authCommand([]); expect(clean(output[0])).toBe('Credential source: exec (cred --x)'); });
test('AC-48: text provider row includes helper account', async () => { await authSetup(); await mockedAuthReport(execReport); await authCommand([]); expect(output.slice(1).map(clean).some(s => s.includes('exec (team-a)'))).toBe(true); });
test('AC-49: empty text listing gives actionable message', async () => { await authSetup(); await mockedAuthReport({ source: 'file', providers: [] }); await authCommand([]); expect(output).toHaveLength(2); expect(clean(output[1])).toBe('No credentials stored. Add one with `nax auth login <provider>`.'); });

async function requirements(config: any) { const { buildConfigRequirements } = await import('@/cli/config-requirements'); return buildConfigRequirements(config); }
test('AC-50: requirements echo default agent', async () => { expect((await requirements(cfg('claude'))).agent).toBe('claude'); });
test('AC-51: non-native agent uses acp transport', async () => { expect((await requirements(cfg('claude'))).transport).toBe('acp'); });
test('AC-52: native agent uses native transport', async () => { expect((await requirements(cfg('native', { execution: {} }))).transport).toBe('native'); });
test('AC-53: absent protocol defaults to hybrid', async () => { expect((await requirements({ execution: {} })).protocol).toBe('hybrid'); expect((await requirements(cfg('claude', { execution: {} }))).protocol).toBe('hybrid'); });
test('AC-54: configured protocol is echoed', async () => { expect((await requirements({ agent: { default: 'native', protocol: 'native' }, execution: {} })).protocol).toBe('native'); });
test('AC-55: native provider list is unique and sorted', async () => { expect((await requirements({ ...nativeConfig(), execution: {} })).providers).toEqual(['deepseek', 'openai']); });
test('AC-56: acp transport ignores native models and never probes them', async () => { const { _configRequirementsDeps } = await import('@/cli/config-requirements'); const spy = mock(() => new Map([['openai', ['fast']]])); replace(_configRequirementsDeps, 'nativeTierProviders', spy); expect((await requirements(cfg('claude', { models: nativeConfig().models }))).providers).toEqual([]); expect(spy).not.toHaveBeenCalled(); });
test('AC-57: native sandbox defaults enabled', async () => { expect((await requirements(cfg('native', { execution: {} }))).sandbox).toBe(true); });
test('AC-58: explicitly disabled native sandbox is false', async () => { expect((await requirements(cfg('native', { execution: { sandbox: { enabled: false } } }))).sandbox).toBe(false); });
test('AC-59: acp sandbox is false even when enabled in config', async () => { expect((await requirements(cfg('claude', { execution: { sandbox: { enabled: true } } }))).sandbox).toBe(false); });
test('AC-60: requirements use injected tier map keys', async () => { const { _configRequirementsDeps } = await import('@/cli/config-requirements'); replace(_configRequirementsDeps, 'nativeTierProviders', mock(() => new Map([['stub-provider', ['fast']]]))); expect((await requirements(cfg('native', { execution: {} }))).providers).toEqual(['stub-provider']); });
test('AC-61: native requirements call injected mapper once with identical config', async () => { const { _configRequirementsDeps } = await import('@/cli/config-requirements'); const spy = mock(() => new Map()); replace(_configRequirementsDeps, 'nativeTierProviders', spy); const config = cfg('native', { execution: {} }); await requirements(config); expect(spy).toHaveBeenCalledTimes(1); expect(spy.mock.calls[0][0]).toBe(config); });

test('AC-62: JSON config reports profile chain', async () => { await jsonSetup(); profile('p'); const r = await jsonCommand({ profile: ['p'] }); expect(r.code).toBe(0); expect(output).toHaveLength(1); expect(r.document.profileChain).toEqual(['p']); });
test('AC-63: valid profile JSON command returns zero', async () => { await jsonSetup(); profile('p'); expect((await jsonCommand({ profile: ['p'] })).code === 0).toBe(true); });
test('AC-64: multiple profile names join with plus', async () => { await jsonSetup(); profile('a'); profile('b'); const r = await jsonCommand({ profile: ['a', 'b'] }); expect(r.code).toBe(0); expect(r.document.profile).toBe('a+b'); });
test('AC-65: comma-separated profile argument expands to chain', async () => { await jsonSetup(); profile('a'); profile('b'); const r = await jsonCommand({ profile: ['a,b'] }); expect(r.code).toBe(0); expect(r.document.profileChain).toEqual(['a', 'b']); });
test('AC-66: project-local profile resolves from nested directory', async () => { await jsonSetup(); projectConfig(); mkdirSync(path.join(dir, '.nax', 'profiles')); writeFileSync(path.join(dir, '.nax', 'profiles', 'proj.json'), '{}'); mkdirSync(path.join(dir, 'src')); const r = await jsonCommand({ dir: path.join(dir, 'src'), profile: ['proj'] }); expect(r.code).toBe(0); expect(r.document.profileChain).toEqual(['proj']); });
test('AC-67: nested directory locates project config source', async () => { await jsonSetup(); projectConfig(); mkdirSync(path.join(dir, 'src')); const r = await jsonCommand({ dir: path.join(dir, 'src') }); expect(r.code).toBe(0); expect(r.document.sources.project.replace('/private/var/', '/var/')).toBe(path.resolve(dir, '.nax', 'config.json').replace('/private/var/', '/var/')); });
test('AC-68: profile native models yield sorted unique provider requirements', async () => { await jsonSetup(); profile('p', { agent: { default: 'native' }, models: { native: { fast: 'openai/gpt-a', balanced: 'openai/gpt-b', powerful: 'deepseek/ds-c' } } }); const r = await jsonCommand({ profile: ['p'] }); expect(r.code).toBe(0); expect(r.document.requirements.providers).toEqual(['deepseek', 'openai']); });
test('AC-69: JSON report uses injected requirements value', async () => { const deps = await jsonSetup(); profile('p'); const fixture = { agent: 'native', transport: 'native', protocol: 'hybrid', providers: ['fixture'], sandbox: true }; replace(deps, 'buildConfigRequirements', mock(() => fixture)); const r = await jsonCommand({ profile: ['p'] }); expect(r.code).toBe(0); expect(r.document.requirements).toEqual(fixture); });
test('AC-70: JSON report passes resolved profile config to requirements builder', async () => { const deps = await jsonSetup(); profile('p'); const spy = mock(() => ({ agent: 'claude', transport: 'acp', protocol: 'hybrid', providers: [], sandbox: false })); replace(deps, 'buildConfigRequirements', spy); const r = await jsonCommand({ profile: ['p'] }); expect(r.code).toBe(0); expect(spy).toHaveBeenCalledTimes(1); expect(spy.mock.calls[0][0].profile).toBe('p'); });
test('AC-71: masked profile env secret never appears in JSON', async () => { await jsonSetup(); profile('p', { models: { native: { fast: { provider: 'openai', model: 'openai/gpt-a', env: { OPENAI_API_KEY: 'sk-profile-secret' } } } } }); const r = await jsonCommand({ profile: ['p'] }); expect(r.code).toBe(0); expect(r.text).not.toContain('sk-profile-secret'); });
test('AC-72: project config is reported as project source', async () => { await jsonSetup(); projectConfig(); const r = await jsonCommand(); expect(r.code).toBe(0); expect(r.document.sources.project.replace('/private/var/', '/var/')).toBe(path.resolve(dir, '.nax', 'config.json').replace('/private/var/', '/var/')); });
test('AC-73: existing global config is reported as global source', async () => { await jsonSetup(); writeFileSync(path.join(root, 'config.json'), '{}'); const r = await jsonCommand(); expect(r.code).toBe(0); expect(r.document.sources.global).toBe(path.join(root, 'config.json')); });
test('AC-74: global profile resolves without project config', async () => { await jsonSetup(); profile('p'); expect((await jsonCommand({ profile: ['p'] })).code === 0).toBe(true); });
test('AC-75: missing project config source is null', async () => { await jsonSetup(); profile('p'); const r = await jsonCommand({ profile: ['p'] }); expect(r.code).toBe(0); expect(r.document.sources.project).toBeNull(); });
test('AC-76: missing profile returns failure exit code', async () => { await jsonSetup(); expect((await jsonCommand({ profile: ['missing'] })).code === 1).toBe(true); });
test('AC-77: missing profile emits clean JSON error', async () => { await jsonSetup(); const r = await jsonCommand({ profile: ['missing'] }); expect(r.code).toBe(1); expect(r.text).not.toMatch(ansi); expect(r.document.error.code).toBe('PROFILE_NOT_FOUND'); });
test('AC-78: profile cannot configure global-only auth', async () => { await jsonSetup(); profile('p', { auth: { source: 'file' } }); const r = await jsonCommand({ profile: ['p'] }); expect(r.code).toBe(1); expect(r.document.error.code).toBe('AUTH_CONFIG_NOT_GLOBAL'); });
test('AC-79: nonexistent directory yields structured path error', async () => { await jsonSetup(); const r = await jsonCommand({ dir: path.join(dir, 'does-not-exist') }); expect(r.code).toBe(1); expect(r.document.error.code).toBe('PATH_DIRECTORY_NOT_FOUND'); });
test('AC-80: explain conflicts with JSON mode', async () => { await jsonSetup(); const r = await jsonCommand({ explain: true }); expect(r.code).toBe(1); expect(r.document.error.code).toBe('CONFIG_FLAGS_CONFLICT'); });
test('AC-81: diff conflicts with JSON mode', async () => { await jsonSetup(); const r = await jsonCommand({ diff: true }); expect(r.code).toBe(1); expect(r.document.error.code).toBe('CONFIG_FLAGS_CONFLICT'); });
test('AC-82: thrown requirements error becomes JSON failure', async () => { const deps = await jsonSetup(); replace(deps, 'buildConfigRequirements', mock(() => { throw Error('boom'); })); const r = await jsonCommand(); expect(r.code).toBe(1); expect(r.document.error.code).toBe('CONFIG_JSON_FAILED'); });
test('AC-83: config JSON error is logged in one call', async () => { await jsonSetup(); const r = await jsonCommand({ profile: ['missing'] }); expect(r.code).toBe(1); expect(output).toHaveLength(1); });
test('AC-84: text config rejects diff with profile via exit one', async () => { const { configCommand } = await import('@/cli/config'); const { DEFAULT_CONFIG } = await import('@/config'); const errors: string[] = []; const exits: number[] = []; replace(console, 'error', (s: string) => errors.push(s)); replace(process, 'exit', (code: number) => { exits.push(code); throw Error('exit'); }); await expect(configCommand(DEFAULT_CONFIG, { diff: true, profile: ['p'] } as any)).rejects.toThrow('exit'); expect(errors[0]).toContain('--diff'); expect(errors[0]).toContain('--profile'); expect(exits).toEqual([1]); });
test('AC-85: synchronous source resolver finds project config', async () => { projectConfig(); const { determineConfigSources } = await import('@/cli/config'); expect(determineConfigSources(dir).project).toBe(path.resolve(dir, '.nax', 'config.json')); });