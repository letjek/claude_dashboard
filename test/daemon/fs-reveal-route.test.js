// test/daemon/fs-reveal-route.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from '../../src/daemon/server.js';
import { fsRevealRoute } from '../../src/daemon/routes/fs.js';

const TOKEN = 'r'.repeat(64);
const AUTH = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

// A fake `run` in place of `execFile`: records what would have launched a real process, and lets a
// test control what the callback reports back, without ever actually opening a window on the
// machine running the suite.
function fakeRun(err = null) {
  const calls = [];
  const run = (cmd, args, cb) => { calls.push({ cmd, args }); cb(err); };
  run.calls = calls;
  return run;
}

async function boot({ platform = 'darwin', run = fakeRun() } = {}) {
  const routes = [fsRevealRoute({ platform, run })];
  const server = createServer({ token: TOKEN, port: 0, hub: { broadcast() {} }, routes });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    run, base,
    post: (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: AUTH, body: JSON.stringify(body) }),
    stop: () => server.close(),
  };
}

test('the route is state-changing and not public', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  const [route] = [fsRevealRoute({ run: fakeRun() })];
  assert.equal(route.stateChanging, true);
  assert.notEqual(route.public, true);
});

test('reveals an existing file on macOS with `open -R`', async (t) => {
  const h = await boot({ platform: 'darwin' });
  t.after(() => h.stop());
  const file = join(realpathSync(mkdtempSync(join(tmpdir(), 'ap-reveal-'))), 'notes.pdf');
  writeFileSync(file, 'x');

  const res = await h.post('/api/fs/reveal', { path: file });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(h.run.calls, [{ cmd: 'open', args: ['-R', file] }]);
});

test('opens the containing folder on Linux, since xdg-open cannot select a file', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-reveal-')));
  const file = join(dir, 'notes.pdf');
  writeFileSync(file, 'x');
  const h = await boot({ platform: 'linux' });
  t.after(() => h.stop());

  const res = await h.post('/api/fs/reveal', { path: file });
  assert.equal(res.status, 200);
  assert.deepEqual(h.run.calls, [{ cmd: 'xdg-open', args: [dirname(file)] }]);
});

test('a path that does not exist is a 404, and nothing is launched', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  const res = await h.post('/api/fs/reveal', { path: '/definitely/not/a/real/path/here' });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });
  assert.equal(h.run.calls.length, 0);
});

test('a relative path is refused before anything is launched', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  for (const path of ['relative/path', '', undefined, null, 42]) {
    const res = await h.post('/api/fs/reveal', { path });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(path)}`);
    assert.deepEqual(await res.json(), { error: 'bad_path' });
  }
  assert.equal(h.run.calls.length, 0);
});

test('an unsupported platform is a 501, not a crash', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-reveal-')));
  const h = await boot({ platform: 'win32' });
  t.after(() => h.stop());
  const res = await h.post('/api/fs/reveal', { path: dir });
  assert.equal(res.status, 501);
  assert.deepEqual(await res.json(), { error: 'unsupported_platform' });
});

test('the opener failing is a 500, not a hang', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-reveal-')));
  const h = await boot({ run: fakeRun(new Error('spawn ENOENT')) });
  t.after(() => h.stop());
  const res = await h.post('/api/fs/reveal', { path: dir });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'reveal_failed', detail: 'spawn ENOENT' });
});

test('without a token, nothing is launched', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  const res = await fetch(`${h.base}/api/fs/reveal`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/tmp' }),
  });
  assert.equal(res.status, 401);
  assert.equal(h.run.calls.length, 0);
});
