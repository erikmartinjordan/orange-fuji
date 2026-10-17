'use strict';

const assert = require('assert');
const { createApiBridge } = require('../src/api-bridge');

const TOKEN = 'test-token-123';

function makeHandlers() {
  return {
    listDisplays: () => [{ id: 7, primary: true, bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: 2 }],
    getSettings: () => ({ apiEnabled: true, defaultSavePath: '' }),
    updateSettings: (patch) => ({ apiEnabled: true, ...patch }),
    capture: (params) => ({
      success: true,
      mode: params.mode,
      width: 42,
      height: 24,
      dataUrl: 'data:image/png;base64,AAAA',
      region: params.rect || null,
    }),
    copyToClipboard: () => ({ success: true }),
    saveFile: (_dataUrl, filename) => ({ success: true, path: `/tmp/${filename || 'capture.png'}` }),
  };
}

async function request(base, route, { method = 'GET', body, token = TOKEN } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

async function run() {
  const bridge = createApiBridge({ token: TOKEN, version: '9.9.9', handlers: makeHandlers() });
  const { url } = await bridge.listen();
  let failures = 0;

  const check = async (name, fn) => {
    try {
      await fn();
      console.log(`\x1b[32m✓\x1b[0m ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`✗ ${name}\n  ${error.message}`);
    }
  };

  try {
    await check('rejects requests without a valid token', async () => {
      const res = await request(url, '/health', { token: 'wrong' });
      assert.strictEqual(res.status, 401);
    });

    await check('GET /health reports the app', async () => {
      const res = await request(url, '/health');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.ok, true);
      assert.strictEqual(res.body.version, '9.9.9');
    });

    await check('GET /displays returns injected displays', async () => {
      const res = await request(url, '/displays');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.displays[0].id, 7);
    });

    await check('GET /settings then POST /settings merges a patch', async () => {
      const before = await request(url, '/settings');
      assert.strictEqual(before.body.settings.apiEnabled, true);
      const after = await request(url, '/settings', { method: 'POST', body: { patch: { hideDesktopIcons: false } } });
      assert.strictEqual(after.body.settings.hideDesktopIcons, false);
    });

    await check('POST /capture/fullscreen returns a capture', async () => {
      const res = await request(url, '/capture/fullscreen', { method: 'POST', body: { save: false } });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.mode, 'fullscreen');
    });

    await check('POST /capture/region validates and normalizes the region', async () => {
      const res = await request(url, '/capture/region', { method: 'POST', body: { x: 1, y: 2, width: 3, height: 4 } });
      assert.strictEqual(res.body.region.width, 3);
      const bad = await request(url, '/capture/region', { method: 'POST', body: { x: 1, y: 2, width: 0, height: 4 } });
      assert.strictEqual(bad.status, 400);
    });

    await check('POST /save requires a dataUrl', async () => {
      const res = await request(url, '/save', { method: 'POST', body: {} });
      assert.strictEqual(res.status, 400);
    });

    await check('unknown routes return 404', async () => {
      const res = await request(url, '/nope');
      assert.strictEqual(res.status, 404);
    });
  } finally {
    await bridge.close();
  }

  if (failures) throw new Error(`${failures} api-bridge test(s) failed`);
}

run().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
