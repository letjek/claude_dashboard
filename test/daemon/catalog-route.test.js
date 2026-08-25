// test/daemon/catalog-route.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../../src/daemon/server.js';
import { createCatalog } from '../../src/catalog/index.js';
import { parseFrontmatter } from '../../src/core/frontmatter.js';
import { catalogRoute, catalogWriteRoutes } from '../../src/daemon/routes/catalog.js';

const TOKEN = 'e'.repeat(64);
const AUTH = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

async function boot() {
  const events = [];
  const hub = {
    broadcast(event, data) { events.push({ event, data }); },
    of(name) { return events.filter((e) => e.event === name).map((e) => e.data); },
  };
  const claudeDir = mkdtempSync(join(tmpdir(), 'ap-wcat-'));
  // Resolved: on macOS /tmp is a symlink, and the route stores the real path it wrote to.
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ap-wproj-')));
  const catalog = createCatalog({ claudeDir, projectRoot });
  const routes = [catalogRoute({ catalog }), ...catalogWriteRoutes({ catalog, claudeDir, hub })];

  const server = createServer({ token: TOKEN, port: 0, hub, routes });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    hub, catalog, claudeDir, projectRoot, routes, base,
    post: (path, body, headers = {}) => fetch(`${base}${path}`, {
      method: 'POST', headers: { ...AUTH, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    get: (path, headers = {}) => fetch(`${base}${path}`, { headers: { ...AUTH, ...headers } }),
    stop() { catalog.close(); server.close(); },
  };
}

const AGENT = { scope: 'user', name: 'reviewer', description: 'Reviews code.', prompt: 'You review code.' };
const SKILL = { scope: 'user', name: 'brainstorm', description: 'Turns ideas into designs.', body: '# Steps' };

test('both create routes are state-changing and neither is public', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  const mutating = h.routes.filter((r) => r.method === 'POST');
  assert.equal(mutating.length, 2);
  for (const route of mutating) {
    assert.equal(route.stateChanging, true, `${route.path} must declare stateChanging`);
    assert.notEqual(route.public, true);
  }
});

test('reading the catalog still works alongside the create routes', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  const res = await h.get('/api/catalog');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.agents, []);
  assert.deepEqual(body.skills, []);
});

test('creating an agent without a token writes nothing', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  const res = await fetch(`${h.base}/api/catalog/agents`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(AGENT),
  });
  assert.equal(res.status, 401);
  assert.equal(existsSync(join(h.claudeDir, 'agents', 'reviewer.md')), false);
});

// A page on another 127.0.0.1 port must not be able to drop a file in the user's home directory
// through the browser's ambient credentials.
test('a foreign Origin cannot create an agent', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  const res = await h.post('/api/catalog/agents', AGENT, { origin: 'http://127.0.0.1:5173' });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'bad_origin' });
  assert.equal(existsSync(join(h.claudeDir, 'agents', 'reviewer.md')), false);
});

test('an unwritable scope is refused, and the plugin cache is never a write target', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  for (const scope of ['plugin', 'global', '', null, 42, undefined]) {
    for (const path of ['/api/catalog/agents', '/api/catalog/skills']) {
      const payload = path.endsWith('agents') ? { ...AGENT, scope } : { ...SKILL, scope };
      const res = await h.post(path, payload);
      assert.equal(res.status, 400, `expected 400 for scope ${JSON.stringify(scope)} on ${path}`);
      assert.deepEqual(await res.json(), { error: 'bad_scope' });
    }
  }
});

test('project scope needs a real project directory', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  writeFileSync(join(h.projectRoot, 'a-file'), 'x');
  for (const projectPath of [undefined, '', 'relative/path', join(h.projectRoot, 'nope'), join(h.projectRoot, 'a-file'), 42]) {
    const res = await h.post('/api/catalog/agents', { ...AGENT, scope: 'project', projectPath });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(projectPath)}`);
    assert.deepEqual(await res.json(), { error: 'bad_project' });
  }
});

test('a name that could escape the target directory is refused before anything is written', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  for (const name of ['../evil', 'a/b', '.hidden', 'Reviewer', '', 'x'.repeat(65), null, 42]) {
    const agent = await h.post('/api/catalog/agents', { ...AGENT, name });
    assert.equal(agent.status, 400, `expected 400 for ${JSON.stringify(name)}`);
    assert.deepEqual(await agent.json(), { error: 'bad_name' });

    const skill = await h.post('/api/catalog/skills', { ...SKILL, name });
    assert.equal(skill.status, 400, `expected 400 for ${JSON.stringify(name)}`);
    assert.deepEqual(await skill.json(), { error: 'bad_name' });
  }
  // Not one of those names produced a file anywhere near the catalog directories.
  assert.equal(existsSync(join(h.claudeDir, 'agents')), false);
  assert.equal(existsSync(join(h.claudeDir, 'skills')), false);
});

test('a missing or blank description and a missing or blank body are refused', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  for (const description of [undefined, '', '   ', null, 42]) {
    const agent = await h.post('/api/catalog/agents', { ...AGENT, description });
    assert.equal(agent.status, 400);
    assert.deepEqual(await agent.json(), { error: 'empty_description' });

    const skill = await h.post('/api/catalog/skills', { ...SKILL, description });
    assert.equal(skill.status, 400);
    assert.deepEqual(await skill.json(), { error: 'empty_description' });
  }
  for (const empty of [undefined, '', '   ', null, 42]) {
    const agent = await h.post('/api/catalog/agents', { ...AGENT, prompt: empty });
    assert.equal(agent.status, 400);
    assert.deepEqual(await agent.json(), { error: 'empty_body' });

    const skill = await h.post('/api/catalog/skills', { ...SKILL, body: empty });
    assert.equal(skill.status, 400);
    assert.deepEqual(await skill.json(), { error: 'empty_body' });
  }
});

test('a created agent lands on disk and comes back shaped like a scanned one', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  const res = await h.post('/api/catalog/agents', {
    ...AGENT, model: 'opus', tools: 'Read, Grep , , Glob', description: 'Use when: a diff needs review.',
  });
  assert.equal(res.status, 201);
  const { agent } = await res.json();
  assert.deepEqual(agent, {
    kind: 'agent',
    name: 'reviewer',
    description: 'Use when: a diff needs review.',
    tools: ['Read', 'Grep', 'Glob'],
    model: 'opus',
    scope: 'user',
    source: null,
    path: join(h.claudeDir, 'agents', 'reviewer.md'),
  });

  const { data, body } = parseFrontmatter(readFileSync(agent.path, 'utf8'));
  assert.equal(data.name, 'reviewer');
  assert.equal(data.description, 'Use when: a diff needs review.');
  assert.deepEqual(data.tools, ['Read', 'Grep', 'Glob']);
  assert.equal(body.trim(), 'You review code.');

  // And the refreshed catalog reports exactly what the route just said it wrote.
  const scanned = (await (await h.get('/api/catalog')).json()).agents;
  assert.deepEqual(scanned.map((a) => a.name), ['reviewer']);
  assert.deepEqual(scanned[0].tools, agent.tools);
  assert.equal(scanned[0].description, agent.description);
});

test('tools accept an array as well as a string, and are omitted when nothing is left', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  const listed = await h.post('/api/catalog/agents', { ...AGENT, name: 'listed', tools: ['Read', ' Write ', '', 7] });
  assert.deepEqual((await listed.json()).agent.tools, ['Read', 'Write']);

  for (const [name, tools] of [['empty-string', '  ,  '], ['empty-array', []], ['absent', undefined], ['nonsense', 42]]) {
    const res = await h.post('/api/catalog/agents', { ...AGENT, name, tools });
    assert.equal(res.status, 201, `expected 201 for tools ${JSON.stringify(tools)}`);
    const { agent } = await res.json();
    assert.equal(agent.tools, null);
    assert.equal(/^tools:/m.test(readFileSync(agent.path, 'utf8')), false);
  }
});

test('a created skill lands at <dir>/<name>/SKILL.md', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  const res = await h.post('/api/catalog/skills', { ...SKILL, body: '# Brainstorm\n\nSteps.' });
  assert.equal(res.status, 201);
  const { skill } = await res.json();
  assert.equal(skill.kind, 'skill');
  assert.equal(skill.scope, 'user');
  assert.equal(skill.source, null);
  assert.equal(skill.version, null);
  assert.equal(skill.path, join(h.claudeDir, 'skills', 'brainstorm', 'SKILL.md'));

  const { data, body } = parseFrontmatter(readFileSync(skill.path, 'utf8'));
  assert.equal(data.name, 'brainstorm');
  assert.equal(data.description, 'Turns ideas into designs.');
  assert.equal(body.trim(), '# Brainstorm\n\nSteps.');
});

test('a project-scoped create lands under the project, not the home directory', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  const agent = await h.post('/api/catalog/agents', { ...AGENT, scope: 'project', projectPath: h.projectRoot, name: 'local-helper' });
  assert.equal(agent.status, 201);
  const created = (await agent.json()).agent;
  assert.equal(created.scope, 'project');
  assert.equal(created.path, join(h.projectRoot, '.claude', 'agents', 'local-helper.md'));
  assert.equal(existsSync(join(h.claudeDir, 'agents', 'local-helper.md')), false);

  const skill = await h.post('/api/catalog/skills', { ...SKILL, scope: 'project', projectPath: h.projectRoot });
  assert.equal((await skill.json()).skill.path, join(h.projectRoot, '.claude', 'skills', 'brainstorm', 'SKILL.md'));
});

// This surface creates; it never edits. A second submission of the same name must not replace work.
test('a duplicate agent or skill is a 409 and the first file is untouched', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  const first = await h.post('/api/catalog/agents', AGENT);
  const path = (await first.json()).agent.path;
  const original = readFileSync(path, 'utf8');

  const again = await h.post('/api/catalog/agents', { ...AGENT, description: 'Replacement.', prompt: 'other body' });
  assert.equal(again.status, 409);
  assert.deepEqual(await again.json(), { error: 'exists', path });
  assert.equal(readFileSync(path, 'utf8'), original);

  await h.post('/api/catalog/skills', SKILL);
  const dupSkill = await h.post('/api/catalog/skills', { ...SKILL, body: 'other body' });
  assert.equal(dupSkill.status, 409);
  assert.deepEqual(await dupSkill.json(), { error: 'exists', path: join(h.claudeDir, 'skills', 'brainstorm', 'SKILL.md') });
});

// A project directory outside the daemon's cwd is not watched, so nothing else would tell the other
// open tabs that the catalog moved.
test('a successful create broadcasts catalog.changed and a rejected one does not', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  await h.post('/api/catalog/agents', AGENT);
  assert.equal(h.hub.of('catalog.changed').length, 1);
  assert.equal(typeof h.hub.of('catalog.changed')[0].scannedAt, 'number');

  await h.post('/api/catalog/skills', SKILL);
  assert.equal(h.hub.of('catalog.changed').length, 2);

  await h.post('/api/catalog/agents', AGENT);                       // duplicate
  await h.post('/api/catalog/agents', { ...AGENT, name: '../evil' });
  await h.post('/api/catalog/agents', { ...AGENT, scope: 'plugin', name: 'nope' });
  assert.equal(h.hub.of('catalog.changed').length, 2);
});

test('a malformed body and a non-object body are refused without writing', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  assert.equal((await h.post('/api/catalog/agents', 'not json at all')).status, 400);
  assert.equal((await h.post('/api/catalog/skills', '[1,2,3]')).status, 400);
  assert.equal(existsSync(join(h.claudeDir, 'agents')), false);
  assert.equal(existsSync(join(h.claudeDir, 'skills')), false);
});

test('a filesystem that refuses the write is a 500, not a crashed daemon', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  // A file where the agents directory has to go: mkdir cannot make a directory out of it.
  writeFileSync(join(h.claudeDir, 'agents'), 'in the way');

  const res = await h.post('/api/catalog/agents', AGENT);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, 'write_failed');
  assert.equal(typeof body.detail, 'string');
  assert.equal(h.hub.of('catalog.changed').length, 0);

  // The daemon is still answering.
  assert.equal((await h.get('/api/catalog')).status, 200);
});

test('an existing skill directory is never added to', async (t) => {
  const h = await boot();
  t.after(() => h.stop());
  const dir = join(h.claudeDir, 'skills', 'brainstorm');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'reference.md'), 'keep me');

  const res = await h.post('/api/catalog/skills', SKILL);
  assert.equal(res.status, 409);
  assert.equal(existsSync(join(dir, 'SKILL.md')), false);
  assert.equal(readFileSync(join(dir, 'reference.md'), 'utf8'), 'keep me');
});
