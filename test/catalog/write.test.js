// test/catalog/write.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFrontmatter } from '../../src/core/frontmatter.js';
import {
  validateName, targetDir, renderAgent, renderSkill, writeAgent, writeSkill,
  updateAgent, readAgentSource,
} from '../../src/catalog/write.js';

function tree() {
  const claudeDir = mkdtempSync(join(tmpdir(), 'ap-wcat-'));
  const projectRoot = mkdtempSync(join(tmpdir(), 'ap-wproj-'));
  return { claudeDir, projectRoot };
}

test('the name allowlist accepts the shapes a catalog file actually has', () => {
  for (const name of ['reviewer', 'ink-security-auditor', 'a', 'a1', 'agent-2-b', 'x'.repeat(64)]) {
    assert.equal(validateName(name), true, `expected ${JSON.stringify(name)} to pass`);
  }
});

// The allowlist is the whole traversal defence, so the rejections matter more than the acceptances:
// none of these can be spelled, therefore none of them can escape the target directory.
test('the name allowlist rejects anything that could leave the target directory', () => {
  const rejected = [
    '../evil', 'a/b', '..', '.hidden', 'a.b', 'Reviewer', 'REVIEWER', '', '   ',
    'x'.repeat(65), '-leading', 'trailing-', 'double--hyphen', 'has space', 'a\\b',
    'a\nb', 'agent%2f..', null, undefined, 42, {}, ['reviewer'],
  ];
  for (const name of rejected) {
    assert.equal(validateName(name), false, `expected ${JSON.stringify(name)} to be refused`);
  }
});

test('a target directory is chosen per scope and kind, and plugin is not a write target', () => {
  const { claudeDir, projectRoot } = tree();
  assert.equal(targetDir({ claudeDir, projectRoot, scope: 'user', kind: 'agent' }), join(claudeDir, 'agents'));
  assert.equal(targetDir({ claudeDir, projectRoot, scope: 'user', kind: 'skill' }), join(claudeDir, 'skills'));
  assert.equal(targetDir({ claudeDir, projectRoot, scope: 'project', kind: 'agent' }), join(projectRoot, '.claude', 'agents'));
  assert.equal(targetDir({ claudeDir, projectRoot, scope: 'project', kind: 'skill' }), join(projectRoot, '.claude', 'skills'));

  assert.equal(targetDir({ claudeDir, projectRoot, scope: 'plugin', kind: 'agent' }), null);
  assert.equal(targetDir({ claudeDir, projectRoot, scope: 'nonsense', kind: 'agent' }), null);
  assert.equal(targetDir({ claudeDir, projectRoot, scope: 'user', kind: 'command' }), null);
  // Project scope with no project is not silently redirected into the user's home directory.
  assert.equal(targetDir({ claudeDir, projectRoot: null, scope: 'project', kind: 'agent' }), null);
});

test('a rendered agent survives a round trip through the frontmatter parser', () => {
  const text = renderAgent({
    name: 'reviewer',
    description: 'Reviews code.',
    model: 'opus',
    tools: ['Read', 'Grep', 'Glob'],
    prompt: 'You review code.\n\nBe specific.',
  });
  const { data, body } = parseFrontmatter(text);
  assert.equal(data.name, 'reviewer');
  assert.equal(data.description, 'Reviews code.');
  assert.equal(data.model, 'opus');
  assert.deepEqual(data.tools, ['Read', 'Grep', 'Glob']);
  assert.equal(body.trim(), 'You review code.\n\nBe specific.');
});

// A colon in a description is what breaks a naive `key: value` writer: the parser would cut the line
// at the wrong colon, or the value would arrive truncated.
test('a description containing a colon round trips intact', () => {
  const description = 'Use when: the diff touches auth. #1 priority.';
  const { data } = parseFrontmatter(renderAgent({ name: 'auth-reviewer', description, prompt: 'body' }));
  assert.equal(data.description, description);
});

test('a description containing newlines is folded to a single line and stays one line', () => {
  const { data } = parseFrontmatter(renderAgent({
    name: 'folder', description: 'First line.\nSecond line.\n\nThird line.', prompt: 'body',
  }));
  assert.equal(data.description, 'First line. Second line. Third line.');
});

test('a description that would otherwise coerce stays a string', () => {
  for (const description of ['true', 'false', '42', '-7', '[not, a, list]', '  padded  ']) {
    const { data } = parseFrontmatter(renderAgent({ name: 'coercer', description, prompt: 'body' }));
    assert.equal(typeof data.description, 'string', `expected ${JSON.stringify(description)} to stay a string`);
    assert.equal(data.description, description.trim());
  }
});

test('model and tools are omitted entirely when nothing was chosen', () => {
  const text = renderAgent({ name: 'plain', description: 'No extras.', prompt: 'body' });
  assert.equal(/^model:/m.test(text), false);
  assert.equal(/^tools:/m.test(text), false);
  const { data } = parseFrontmatter(text);
  assert.equal(data.model, undefined);
  assert.equal(data.tools, undefined);
});

test('a rendered skill survives a round trip too', () => {
  const { data, body } = parseFrontmatter(renderSkill({
    name: 'brainstorm', description: 'Turns ideas into designs: fast.', body: '# Brainstorm\n\nSteps.',
  }));
  assert.equal(data.name, 'brainstorm');
  assert.equal(data.description, 'Turns ideas into designs: fast.');
  assert.equal(body.trim(), '# Brainstorm\n\nSteps.');
});

test('a user-scoped agent lands in <claudeDir>/agents and reads back as a scanned agent would', () => {
  const { claudeDir, projectRoot } = tree();
  const result = writeAgent({
    claudeDir, projectRoot, scope: 'user', name: 'reviewer',
    description: 'Reviews code.', model: 'opus', tools: ['Read'], prompt: 'You review code.',
  });
  assert.equal(result.ok, true);
  assert.equal(result.path, join(claudeDir, 'agents', 'reviewer.md'));
  const { data } = parseFrontmatter(readFileSync(result.path, 'utf8'));
  assert.equal(data.name, 'reviewer');
  assert.deepEqual(data.tools, ['Read']);
});

test('a project-scoped agent lands under <projectRoot>/.claude and never in the home directory', () => {
  const { claudeDir, projectRoot } = tree();
  const result = writeAgent({
    claudeDir, projectRoot, scope: 'project', name: 'local-helper',
    description: 'Project scoped.', prompt: 'Help locally.',
  });
  assert.equal(result.ok, true);
  assert.equal(result.path, join(projectRoot, '.claude', 'agents', 'local-helper.md'));
  assert.equal(existsSync(join(claudeDir, 'agents', 'local-helper.md')), false);
});

test('writing creates the missing parent directories', () => {
  const { claudeDir, projectRoot } = tree();
  assert.equal(existsSync(join(projectRoot, '.claude')), false);
  const result = writeAgent({ claudeDir, projectRoot, scope: 'project', name: 'fresh', description: 'd', prompt: 'p' });
  assert.equal(result.ok, true);
  assert.equal(existsSync(result.path), true);
});

// This route creates files; it does not edit them. An agent someone spent an afternoon writing must
// survive a second submission of the same name.
test('writing the same agent twice reports exists and leaves the first file untouched', () => {
  const { claudeDir, projectRoot } = tree();
  const args = { claudeDir, projectRoot, scope: 'user', name: 'reviewer', description: 'Original.', prompt: 'first body' };
  const first = writeAgent(args);
  assert.equal(first.ok, true);
  const original = readFileSync(first.path, 'utf8');

  const second = writeAgent({ ...args, description: 'Replacement.', prompt: 'second body' });
  assert.deepEqual(second, { ok: false, reason: 'exists', path: first.path });
  assert.equal(readFileSync(first.path, 'utf8'), original);
});

// updateAgent is the deliberate exception to the "creates, never edits" rule above: it is reached
// only from a form that opened by reading the file that already exists, and it refuses to invent
// one that does not.
test('updateAgent overwrites an agent that already exists', () => {
  const { claudeDir, projectRoot } = tree();
  const first = writeAgent({ claudeDir, projectRoot, scope: 'user', name: 'reviewer', description: 'Original.', prompt: 'first body' });
  assert.equal(first.ok, true);

  const result = updateAgent({
    claudeDir, projectRoot, scope: 'user', name: 'reviewer',
    description: 'Replacement.', model: 'opus', tools: ['Read'], prompt: 'second body',
  });
  assert.deepEqual(result, { ok: true, path: first.path });
  const { data, body } = parseFrontmatter(readFileSync(first.path, 'utf8'));
  assert.equal(data.description, 'Replacement.');
  assert.equal(data.model, 'opus');
  assert.equal(body.trim(), 'second body');
});

test('updateAgent refuses to invent a file that was never created', () => {
  const { claudeDir, projectRoot } = tree();
  const result = updateAgent({ claudeDir, projectRoot, scope: 'user', name: 'ghost', description: 'x', prompt: 'y' });
  assert.deepEqual(result, { ok: false, reason: 'not_found', path: join(claudeDir, 'agents', 'ghost.md') });
  assert.equal(existsSync(join(claudeDir, 'agents', 'ghost.md')), false);
});

test('readAgentSource returns the prompt body of an existing agent', () => {
  const { claudeDir, projectRoot } = tree();
  writeAgent({ claudeDir, projectRoot, scope: 'project', name: 'qa', description: 'x', prompt: 'Write tests.\n\nDo not fix bugs.' });
  const result = readAgentSource({ claudeDir, projectRoot, scope: 'project', name: 'qa' });
  assert.equal(result.ok, true);
  assert.equal(result.prompt, 'Write tests.\n\nDo not fix bugs.');
});

test('readAgentSource reports not_found rather than inventing an empty prompt', () => {
  const { claudeDir, projectRoot } = tree();
  const result = readAgentSource({ claudeDir, projectRoot, scope: 'user', name: 'ghost' });
  assert.deepEqual(result, { ok: false, reason: 'not_found' });
});

test('a skill is written to <dir>/<name>/SKILL.md', () => {
  const { claudeDir, projectRoot } = tree();
  const user = writeSkill({ claudeDir, projectRoot, scope: 'user', name: 'brainstorm', description: 'Ideas.', body: 'Steps.' });
  assert.equal(user.ok, true);
  assert.equal(user.path, join(claudeDir, 'skills', 'brainstorm', 'SKILL.md'));

  const project = writeSkill({ claudeDir, projectRoot, scope: 'project', name: 'brainstorm', description: 'Ideas.', body: 'Steps.' });
  assert.equal(project.ok, true);
  assert.equal(project.path, join(projectRoot, '.claude', 'skills', 'brainstorm', 'SKILL.md'));
});

// A skill is a directory that may hold scripts and references beside its SKILL.md. An existing one
// is refused whole, so a create can never drop a file into someone else's skill.
test('an existing skill directory is refused without being touched, even with no SKILL.md in it', () => {
  const { claudeDir, projectRoot } = tree();
  const dir = join(claudeDir, 'skills', 'brainstorm');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'reference.md'), 'keep me');

  const result = writeSkill({ claudeDir, projectRoot, scope: 'user', name: 'brainstorm', description: 'Ideas.', body: 'Steps.' });
  assert.deepEqual(result, { ok: false, reason: 'exists', path: join(dir, 'SKILL.md') });
  assert.equal(existsSync(join(dir, 'SKILL.md')), false);
  assert.equal(readFileSync(join(dir, 'reference.md'), 'utf8'), 'keep me');
});

test('the writers refuse a bad name and a scope with nowhere to write', () => {
  const { claudeDir, projectRoot } = tree();
  for (const name of ['../evil', 'a/b', '.hidden', 'Reviewer', '']) {
    assert.deepEqual(
      writeAgent({ claudeDir, projectRoot, scope: 'user', name, description: 'd', prompt: 'p' }),
      { ok: false, reason: 'bad_name' },
    );
    assert.deepEqual(
      writeSkill({ claudeDir, projectRoot, scope: 'user', name, description: 'd', body: 'b' }),
      { ok: false, reason: 'bad_name' },
    );
  }
  assert.deepEqual(
    writeAgent({ claudeDir, projectRoot, scope: 'plugin', name: 'ok', description: 'd', prompt: 'p' }),
    { ok: false, reason: 'bad_scope' },
  );
  assert.deepEqual(
    writeSkill({ claudeDir, projectRoot: null, scope: 'project', name: 'ok', description: 'd', body: 'b' }),
    { ok: false, reason: 'bad_scope' },
  );
});

test('a filesystem that refuses the write is reported rather than thrown', (t) => {
  const { claudeDir, projectRoot } = tree();
  const locked = join(claudeDir, 'agents');
  mkdirSync(locked, { recursive: true });
  // Read-and-execute only: traversable, but nothing may be created inside it.
  chmodSync(locked, 0o500);
  t.after(() => chmodSync(locked, 0o700));       // or the temp dir cannot be cleaned up

  const result = writeAgent({ claudeDir, projectRoot, scope: 'user', name: 'blocked', description: 'd', prompt: 'p' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'write_failed');
  assert.equal(result.detail, 'EACCES');
});

test('a description containing a double quote survives the round-trip', () => {
  // The quoted form cannot carry it: the parser strips the surrounding quotes without unescaping,
  // so `\"` would come back as literal backslash-quote. A folded block scalar is written instead.
  const text = renderAgent({
    name: 'quoter',
    description: 'Use when the user says "ship it" or similar.',
    prompt: 'body',
  });
  const { data } = parseFrontmatter(text);
  assert.equal(data.description, 'Use when the user says "ship it" or similar.');
  assert.equal(data.name, 'quoter');
});

test('a quoted description followed by another key does not swallow it', () => {
  const text = renderAgent({
    name: 'quoter',
    description: 'Say "hi".',
    model: 'claude-opus-5',
    tools: ['Read', 'Write'],
    prompt: 'body',
  });
  const { data } = parseFrontmatter(text);
  assert.equal(data.description, 'Say "hi".');
  assert.equal(data.model, 'claude-opus-5');
  assert.deepEqual(data.tools, ['Read', 'Write']);
});
