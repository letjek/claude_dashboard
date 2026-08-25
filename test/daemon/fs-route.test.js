// test/daemon/fs-route.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../../src/daemon/server.js';
import { fsRoutes } from '../../src/daemon/routes/fs.js';

const TOKEN = 'f'.repeat(64);
const AUTH = { authorization: `Bearer ${TOKEN}` };

// Enough of `createProjectsRepo` for the route: `get` answers whether a path is already in the
// switcher, which is the only thing the listing asks it.
function fakeProjects(paths = []) {
  const rows = new Map(paths.map((p) => [p, { path: p, name: p, addedAt: 1, lastUsedAt: 1 }]));
  return { get: (path) => rows.get(path) ?? null, add(path) { rows.set(path, { path }); } };
}

// On macOS /tmp is a symlink to /private/tmp, so the fixture root is realpath'd here: every path
// the route reports has been through `realpathSync`, and unresolved spellings would never match.
async function boot({ projects = fakeProjects() } = {}) {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ap-fs-out-')));
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'ap-fs-')));
  const home = join(parent, 'home');
  mkdirSync(home);

  const routes = fsRoutes({ projects, home });
  const server = createServer({ token: TOKEN, port: 0, hub: { broadcast() {} }, routes });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    routes, projects, base, home, parent, outside,
    list: (path) => fetch(
      path === undefined ? `${base}/api/fs/list` : `${base}/api/fs/list?path=${encodeURIComponent(path)}`,
      { headers: AUTH },
    ),
    stop() { server.close(); },
  };
}

test('the listing route is neither public nor state-changing, so the token guard runs', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  assert.equal(h.routes.length, 1);
  const [route] = h.routes;
  assert.equal(route.method, 'GET');
  assert.equal(route.path, '/api/fs/list');
  assert.notEqual(route.public, true);
  assert.notEqual(route.stateChanging, true);

  const res = await fetch(`${h.base}/api/fs/list`);
  assert.equal(res.status, 401);
});

test('with no path the listing is home itself, and home has no parent', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  mkdirSync(join(h.home, 'beta'));
  mkdirSync(join(h.home, 'alpha'));
  writeFileSync(join(h.home, 'notes.txt'), 'x');

  const res = await h.list();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.root, h.home);
  assert.equal(body.path, h.home);
  assert.equal(body.parent, null);
  // Directories only, sorted by name — the file is not a folder anyone can pick.
  assert.deepEqual(body.entries.map((e) => e.name), ['alpha', 'beta']);
  assert.deepEqual(body.entries.map((e) => e.path), [join(h.home, 'alpha'), join(h.home, 'beta')]);

  // The empty spelling is the same request as no parameter at all.
  assert.deepEqual(await (await h.list('')).json(), body);
});

test('a nested directory reports the directory above it as its parent', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  const nested = join(h.home, 'code', 'project');
  mkdirSync(nested, { recursive: true });

  const res = await h.list(join(h.home, 'code'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.path, join(h.home, 'code'));
  assert.equal(body.parent, h.home);
  assert.deepEqual(body.entries.map((e) => e.name), ['project']);
});

test('dot-directories are absent, so the real answer is not buried', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  mkdirSync(join(h.home, '.cache'));
  mkdirSync(join(h.home, '.config'));
  mkdirSync(join(h.home, 'visible'));

  const body = await (await h.list(h.home)).json();
  assert.deepEqual(body.entries.map((e) => e.name), ['visible']);
});

test('hasGit marks the directory that is actually a project', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  const repo = join(h.home, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(h.home, 'plain'));

  const body = await (await h.list(h.home)).json();
  assert.deepEqual(
    body.entries.map((e) => [e.name, e.hasGit]),
    [['plain', false], ['repo', true]],
  );
});

test('a folder already in the switcher is visibly already there', async (t) => {
  const known = realpathSync(mkdtempSync(join(tmpdir(), 'ap-fs-known-')));
  const h = await boot();
  t.after(() => h.stop());
  mkdirSync(join(h.home, 'added'));
  mkdirSync(join(h.home, 'fresh'));
  h.projects.add(join(h.home, 'added'));
  h.projects.add(known);                          // a row the listing never sees must not leak in

  const body = await (await h.list(h.home)).json();
  assert.deepEqual(
    body.entries.map((e) => [e.name, e.added]),
    [['added', true], ['fresh', false]],
  );
});

test('a path outside home is refused', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  const res = await h.list(h.outside);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'outside_home', root: h.home });

  // `..` out of home resolves before it is compared, so it is refused too.
  const up = await h.list(join(h.home, '..'));
  assert.equal(up.status, 403);
});

// The separator bug: `/tmp/x/home-evil`.startsWith('/tmp/x/home') is true, and without the `+ sep`
// that is how a browser rooted at one user's home ends up listing another's.
test('a sibling whose name merely prefixes home is still outside it', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  const evil = join(h.parent, 'home-evil');
  mkdirSync(evil);
  mkdirSync(join(evil, 'secrets'));

  const res = await h.list(evil);
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'outside_home', root: h.home });
});

// The reason the confinement check runs on the *real* path: the string `<home>/escape` passes any
// prefix test, and only resolving it first reveals that it lands outside home.
test('a symlink inside home pointing out of it is refused', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  mkdirSync(join(h.outside, 'private'));
  symlinkSync(h.outside, join(h.home, 'escape'));

  const res = await h.list(join(h.home, 'escape'));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'outside_home', root: h.home });

  // Following it one level deeper is refused for the same reason.
  const deeper = await h.list(join(h.home, 'escape', 'private'));
  assert.equal(deeper.status, 403);
});

test('a symlinked directory inside home is listed at its joined path, not its target', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  const target = join(h.home, 'code');
  mkdirSync(target);
  symlinkSync(target, join(h.home, 'shortcut'));

  const body = await (await h.list(h.home)).json();
  const shortcut = body.entries.find((e) => e.name === 'shortcut');
  assert.equal(shortcut.path, join(h.home, 'shortcut'));
});

test('a missing path is a 404, a file is a 400 and a relative path is a 400', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  const missing = join(h.home, 'not-there');
  const notFound = await h.list(missing);
  assert.equal(notFound.status, 404);
  assert.deepEqual(await notFound.json(), { error: 'not_found', path: missing });

  const file = join(h.home, 'a-file.txt');
  writeFileSync(file, 'x');
  const notADir = await h.list(file);
  assert.equal(notADir.status, 400);
  assert.deepEqual(await notADir.json(), { error: 'not_a_directory', path: file });

  // A file *along* the path rather than at the end of it — same answer.
  const under = await h.list(join(file, 'child'));
  assert.equal(under.status, 400);
  assert.equal((await under.json()).error, 'not_a_directory');

  for (const path of ['relative/path', 'Users/me/code', '~/code']) {
    const res = await h.list(path);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(path)}`);
    assert.deepEqual(await res.json(), { error: 'bad_path' });
  }
});
