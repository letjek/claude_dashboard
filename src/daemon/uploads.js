// src/daemon/uploads.js
//
// The composer's attach button is the one place this dashboard actually takes file bytes rather
// than a path: a click-based file picker can never reveal an absolute path (unlike a Finder drag,
// which sometimes carries a `file://` URI), so a path-only button would be strictly worse than
// typing the path by hand. What lands here is scoped per project — sha256 rather than the raw path,
// so a project directory never becomes a literal folder name on disk — and cleared by `/api/chat/reset`,
// the same moment the transcript it was attached to disappears.
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

// Only a bare filename ever reaches disk. `basename` alone strips `../` traversal; the character
// filter is for the rest of what a browser-supplied name can contain (null bytes, slashes it forgot
// to encode) without punishing ordinary names with spaces or dots.
export function sanitizeFilename(name) {
  const base = basename(typeof name === 'string' ? name : '');
  const cleaned = base.replace(/[^\w.\- ]+/g, '_').trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'file' : cleaned;
}

function keyFor(projectPath) {
  return createHash('sha256').update(projectPath ?? '').digest('hex').slice(0, 16);
}

export function createUploadsStore({ stateDir, maxBytes = DEFAULT_MAX_BYTES }) {
  const root = join(stateDir, 'uploads');
  const dirFor = (projectPath) => join(root, keyFor(projectPath));

  async function write(projectPath, name, source) {
    const dir = dirFor(projectPath);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${randomBytes(6).toString('hex')}-${sanitizeFilename(name)}`);
    const out = createWriteStream(path);
    let size = 0;

    try {
      await new Promise((settle, fail) => {
        source.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) fail(Object.assign(new Error('too_large'), { code: 'TOO_LARGE' }));
        });
        source.on('error', fail);
        out.on('error', fail);
        out.on('finish', settle);
        source.pipe(out);
      });
    } catch (err) {
      out.destroy();
      await rm(path, { force: true }).catch(() => {});
      throw err;
    }
    return { path };
  }

  async function clear(projectPath) {
    await rm(dirFor(projectPath), { recursive: true, force: true }).catch(() => {});
  }

  return { dirFor, write, clear };
}
