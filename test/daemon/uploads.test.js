// test/daemon/uploads.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createUploadsStore, sanitizeFilename } from '../../src/daemon/uploads.js';

function stateDir() {
  return mkdtempSync(join(tmpdir(), 'ap-uploads-'));
}

test('sanitizeFilename keeps an ordinary name', () => {
  assert.equal(sanitizeFilename('schema.sql'), 'schema.sql');
});

test('sanitizeFilename strips directory traversal down to a bare name', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('/etc/passwd'), 'passwd');
});

test('sanitizeFilename falls back to a default for nothing usable', () => {
  assert.equal(sanitizeFilename(''), 'file');
  assert.equal(sanitizeFilename('..'), 'file');
  assert.equal(sanitizeFilename(undefined), 'file');
});

test('write streams the source into a file under a project-scoped directory', async () => {
  const uploads = createUploadsStore({ stateDir: stateDir() });
  const { path } = await uploads.write('/Users/daps/project', 'notes.pdf', Readable.from([Buffer.from('hello pdf')]));
  assert.ok(existsSync(path));
  assert.equal(readFileSync(path, 'utf8'), 'hello pdf');
  assert.ok(path.endsWith('-notes.pdf'));
});

test('two uploads for the same project land in the same directory, different projects do not', async () => {
  const uploads = createUploadsStore({ stateDir: stateDir() });
  const a = await uploads.write('/proj/a', 'x.png', Readable.from([Buffer.from('1')]));
  const b = await uploads.write('/proj/a', 'y.png', Readable.from([Buffer.from('2')]));
  const c = await uploads.write('/proj/b', 'z.png', Readable.from([Buffer.from('3')]));
  assert.equal(join(a.path, '..'), join(b.path, '..'));
  assert.notEqual(join(a.path, '..'), join(c.path, '..'));
});

test('a source over the byte limit is rejected and nothing is left on disk', async () => {
  const uploads = createUploadsStore({ stateDir: stateDir(), maxBytes: 4 });
  await assert.rejects(
    uploads.write('/proj/a', 'big.bin', Readable.from([Buffer.from('way too big')])),
    (err) => err.code === 'TOO_LARGE',
  );
  const dir = uploads.dirFor('/proj/a');
  assert.deepEqual(readdirSync(dir), []);
});

test('clear removes everything written for a project without touching another', async () => {
  const uploads = createUploadsStore({ stateDir: stateDir() });
  const a = await uploads.write('/proj/a', 'x.png', Readable.from([Buffer.from('1')]));
  const b = await uploads.write('/proj/b', 'y.png', Readable.from([Buffer.from('2')]));
  await uploads.clear('/proj/a');
  assert.ok(!existsSync(a.path));
  assert.ok(existsSync(b.path));
});

test('clear on a project with nothing uploaded is a no-op, not an error', async () => {
  const uploads = createUploadsStore({ stateDir: stateDir() });
  await assert.doesNotReject(uploads.clear('/never/uploaded'));
});
