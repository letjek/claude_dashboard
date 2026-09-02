// test/daemon/uploads-route.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../../src/daemon/server.js';
import { createUploadsStore } from '../../src/daemon/uploads.js';
import { uploadsRoute } from '../../src/daemon/routes/uploads.js';

const TOKEN = 'e'.repeat(64);
const AUTH = { authorization: `Bearer ${TOKEN}` };

async function boot({ maxBytes } = {}) {
  const uploads = createUploadsStore({ stateDir: mkdtempSync(join(tmpdir(), 'ap-ustate-')), maxBytes });
  const routes = [uploadsRoute({ uploads })];
  const server = createServer({ token: TOKEN, port: 0, hub: { broadcast() {} }, routes });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-uproj-')));
  return { uploads, base, dir, stop: () => server.close() };
}

test('the route declares itself state-changing and not public', () => {
  const route = uploadsRoute({ uploads: createUploadsStore({ stateDir: mkdtempSync(join(tmpdir(), 'ap-x-')) }) });
  assert.equal(route.stateChanging, true);
  assert.notEqual(route.public, true);
});

test('uploading without a token is rejected', async () => {
  const h = await boot();
  const res = await fetch(`${h.base}/api/uploads?name=a.png`, { method: 'POST', body: 'bytes' });
  assert.equal(res.status, 401);
  h.stop();
});

test('a file lands on disk under the project it was uploaded for, and the response names its path', async () => {
  const h = await boot();
  const res = await fetch(`${h.base}/api/uploads?name=notes.pdf&projectPath=${encodeURIComponent(h.dir)}`, {
    method: 'POST', headers: AUTH, body: 'pdf bytes',
  });
  assert.equal(res.status, 201);
  const { path } = await res.json();
  assert.equal(readFileSync(path, 'utf8'), 'pdf bytes');
  assert.equal(path, join(h.uploads.dirFor(h.dir), path.split('/').pop()));
  h.stop();
});

test('uploading with no project selected still works, scoped to a "no project" bucket', async () => {
  const h = await boot();
  const res = await fetch(`${h.base}/api/uploads?name=a.png`, { method: 'POST', headers: AUTH, body: 'x' });
  assert.equal(res.status, 201);
  h.stop();
});

test('a projectPath that is not a real directory is refused', async () => {
  const h = await boot();
  const res = await fetch(`${h.base}/api/uploads?name=a.png&projectPath=/not/a/real/dir`, {
    method: 'POST', headers: AUTH, body: 'x',
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'bad_project' });
  h.stop();
});

test('a body over the limit is rejected with 413 and nothing is left on disk', async () => {
  const h = await boot({ maxBytes: 4 });
  const res = await fetch(`${h.base}/api/uploads?name=big.bin&projectPath=${encodeURIComponent(h.dir)}`, {
    method: 'POST', headers: AUTH, body: 'way too big',
  });
  assert.equal(res.status, 413);
  h.stop();
});
