import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

process.env.OMNI_DB_PATH = path.join(os.tmpdir(), `superglookoquery-test-server-${process.pid}.sqlite`);
process.env.GLOOKO_EMAIL = ''; // offline mode — never touches the network
process.env.GLOOKO_PASSWORD = '';

const { ensureDbReady, recordFieldCapabilities, _wipe } = await import('../src/store.js');
const { registerCapabilityGatedModules } = await import('../src/server.js');

before(async () => {
  await ensureDbReady();
});

beforeEach(() => {
  _wipe();
});

function fakeServer() {
  const registered = [];
  return { registered, registerTool: (name) => registered.push(name) };
}

test('the CamAPS pump-mode module registers once its capability is confirmed', async () => {
  recordFieldCapabilities('stats', { camapsPumpModeAutomaticPercentage: 76 }, 12345);
  const srv = fakeServer();
  await registerCapabilityGatedModules(srv);
  assert.ok(srv.registered.includes('get_camaps_pump_mode_breakdown'));
});

test('the CamAPS pump-mode module does NOT register for an account that has never shown the field', async () => {
  // Deliberately do not record any 'stats' capability.
  const srv = fakeServer();
  await registerCapabilityGatedModules(srv);
  assert.ok(!srv.registered.includes('get_camaps_pump_mode_breakdown'), 'must genuinely not appear, not appear-and-error');
});

test('an unrelated confirmed capability does not satisfy the CamAPS module\'s requirement', async () => {
  recordFieldCapabilities('stats', { someOtherStatField: 1 }, 12345);
  const srv = fakeServer();
  await registerCapabilityGatedModules(srv);
  assert.ok(!srv.registered.includes('get_camaps_pump_mode_breakdown'));
});
