import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, updateCheck, updateCheckEnabled, updateAdvice, DIST_TAGS_URL, UPGRADE_COMMAND } from '../src/update.mjs';
import { serverURL } from '../src/network.mjs';

const reply = (status, body) => async (url, init) => {
  assert.equal(url, DIST_TAGS_URL); assert.equal(init.redirect, 'error'); assert.match(init.headers['User-Agent'], /^EvoLinkCLI\//);
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
};

test('version comparison is numeric per component and rejects anything but plain releases', () => {
  assert.ok(compareVersions('0.9.2', '0.9.10') < 0);
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  for (const bad of ['1.0.0-beta.1', 'latest', '1.0', '', undefined]) assert.equal(compareVersions(bad, '1.0.0'), undefined);
});

test('update check reports a newer release, stays quiet otherwise and never throws', async () => {
  const newer = await updateCheck({ fetchFn: reply(200, { latest: '0.9.3' }), current: '0.9.2' });
  assert.deepEqual(newer, { cli_version: '0.9.2', latest_version: '0.9.3', update_available: true, checked: true, upgrade_command: UPGRADE_COMMAND });
  assert.match(updateAdvice(newer), /0\.9\.3.*0\.9\.2.*npm install -g @evolinkai\/cli@latest.*skills install/);
  for (const current of ['0.9.3', '0.9.4', '1.0.0']) {
    const same = await updateCheck({ fetchFn: reply(200, { latest: '0.9.3' }), current });
    assert.deepEqual(same, { cli_version: current, latest_version: '0.9.3', update_available: false, checked: true });
    assert.equal(updateAdvice(same), undefined);
  }
  const unchecked = { cli_version: '0.9.2', latest_version: null, update_available: false, checked: false };
  // A real request keeps the event loop alive until the timeout fires; this stand-in does the same with a timer.
  const hanging = async (url, init) => new Promise((resolve, reject) => {
    const socket = setTimeout(() => {}, 5000);
    init.signal.addEventListener('abort', () => { clearTimeout(socket); reject(init.signal.reason); });
  });
  for (const fetchFn of [reply(500, {}), reply(200, { latest: 'next' }), reply(200, {}), reply(200, []), async () => { throw new Error('offline'); }, hanging]) {
    assert.deepEqual(await updateCheck({ fetchFn, current: '0.9.2', timeout: 50 }), unchecked);
  }
  assert.equal(updateAdvice(undefined), undefined);
});

test('update checks stay off for loopback test resources and when disabled by environment', () => {
  assert.equal(updateCheckEnabled(serverURL(), {}), true);
  assert.equal(updateCheckEnabled(serverURL('http://127.0.0.1:1/mcp'), {}), false);
  assert.equal(updateCheckEnabled(serverURL(), { EVOLINK_CLI_UPDATE_CHECK: '0' }), false);
  assert.equal(updateCheckEnabled(serverURL(), { EVOLINK_CLI_UPDATE_CHECK: '1' }), true);
});
