// test/daemon/chat-reset-uploads.test.js
//
// The other half of the upload lifecycle: a reset is the moment the transcript an attachment
// belonged to disappears, so whatever was uploaded for that project should not outlive it either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createServer } from '../../src/daemon/server.js';
import { openDb } from '../../src/store/db.js';
import { createChatRepo } from '../../src/store/chat.js';
import { createProjectsRepo } from '../../src/store/projects.js';
import { createSessionManager } from '../../src/chat/session.js';
import { createPermissionGate } from '../../src/chat/permissions.js';
import { createUploadsStore } from '../../src/daemon/uploads.js';
import { chatRoutes } from '../../src/daemon/routes/chat.js';
import { createFakeSdk } from '../chat/fake-sdk.js';

const TOKEN = 'f'.repeat(64);
const AUTH = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

async function boot() {
  const hub = { broadcast() {} };
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ap-cru-')), 'data.db'));
  const chat = createChatRepo(db);
  const projects = createProjectsRepo(db);
  const permissions = createPermissionGate({ hub });
  const sessions = createSessionManager({ store: chat, hub, sdk: createFakeSdk(), permissions });
  const uploads = createUploadsStore({ stateDir: mkdtempSync(join(tmpdir(), 'ap-crustate-')) });
  const routes = chatRoutes({ sessions, permissions, chat, projects, uploads });
  const server = createServer({ token: TOKEN, port: 0, hub, routes });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-crproj-')));
  return {
    uploads, base, dir,
    post: (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: AUTH, body: JSON.stringify(body) }),
    async stop() { await sessions.close(); permissions.close(); server.close(); },
  };
}

test('resetting a project clears whatever was uploaded for it', async () => {
  const h = await boot();
  try {
    const { path } = await h.uploads.write(h.dir, 'notes.pdf', Readable.from([Buffer.from('x')]));
    assert.ok(existsSync(path));

    const res = await h.post('/api/chat/reset', { projectPath: h.dir });
    assert.equal(res.status, 200);
    assert.ok(!existsSync(path));
  } finally {
    await h.stop();
  }
});
