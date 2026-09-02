// src/daemon/routes/fs.js
//
// A read-only directory browser for the add-project form, so picking a folder is not a matter of
// typing an absolute path from memory. It lists names only — never file contents — and it is
// neither `public` nor `stateChanging`, so it inherits the daemon's token + Origin guard like
// every other route.
import { readdirSync, statSync, existsSync, realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join, dirname, sep } from 'node:path';
import { json, readJson } from './body.js';

// The whole security property of this file lives in the order of these two steps: resolve first,
// then confine. `realpathSync` collapses `..`, symlinks and macOS's /tmp -> /private/tmp before
// anything is compared, so a symlink sitting inside home that points at /etc is tested as /etc and
// rejected. Checking the string first and resolving after would happily follow that link out.
//
// The `+ sep` matters as much as the resolve: a bare `startsWith(root)` treats /Users/someone-else
// as living inside /Users/someone, which is another user's home directory.
function confine(real, root) {
  return real === root || real.startsWith(root + sep);
}

// A single entry is worth skipping, never worth failing the listing for: one unreadable directory
// in a folder of forty should not turn the browser into an error page.
function describe(dirPath, entry, projects) {
  const path = join(dirPath, entry.name);
  try {
    // Symlinked directories are followed so a `~/code -> /Volumes/work/code` shortcut still browses,
    // but the entry is reported at its joined path rather than its target: the next request resolves
    // and re-confines it anyway, so nothing escapes home by being listed.
    if (!entry.isDirectory() && !(entry.isSymbolicLink() && statSync(path).isDirectory())) return null;
    return {
      name: entry.name,
      path,
      // The marker that answers "which of these is actually the project" without opening any of them.
      hasGit: existsSync(join(path, '.git')),
      added: projects.get(path) !== null,
    };
  } catch {
    return null;                                  // broken symlink, EACCES, vanished mid-listing
  }
}

export function fsRoutes({ projects, home = homedir() }) {
  return [
    {
      method: 'GET', path: '/api/fs/list',
      handler: (_req, res, ctx) => {
        let root;
        try {
          root = realpathSync(home);
        } catch {
          return json(res, 404, { error: 'not_found', path: home });
        }

        const requested = (ctx.url.searchParams.get('path') ?? '').trim();
        if (requested !== '' && !isAbsolute(requested)) return json(res, 400, { error: 'bad_path' });

        let path;
        if (requested === '') {
          path = root;
        } else {
          try {
            path = realpathSync(requested);
          } catch (err) {
            // ENOTDIR is a file *along* the path — `/tmp/notes.txt/x`. It is the same answer as the
            // path itself being a file, and it is reported before the confinement check only
            // because there is no real path to confine.
            if (err?.code === 'ENOTDIR') return json(res, 400, { error: 'not_a_directory', path: requested });
            return json(res, 404, { error: 'not_found', path: requested });
          }
          if (!confine(path, root)) return json(res, 403, { error: 'outside_home', root });
        }

        let stat;
        try {
          stat = statSync(path);
        } catch {
          return json(res, 404, { error: 'not_found', path });
        }
        if (!stat.isDirectory()) return json(res, 400, { error: 'not_a_directory', path });

        let dirents;
        try {
          dirents = readdirSync(path, { withFileTypes: true });
        } catch {
          return json(res, 404, { error: 'not_found', path });
        }

        // Dot-directories are dropped rather than shown: `.git`, `.cache` and `node_modules`' kin
        // are never the project root someone is hunting for, and listing them buries the answer.
        const entries = dirents
          .filter((entry) => !entry.name.startsWith('.'))
          .map((entry) => describe(path, entry, projects))
          .filter((entry) => entry !== null)
          .sort((a, b) => a.name.localeCompare(b.name));

        json(res, 200, { root, path, parent: path === root ? null : dirname(path), entries });
      },
    },
  ];
}

// `open -R` selects the file itself in Finder; `xdg-open` has no equivalent across Linux desktop
// environments, so the best it can do is open the folder the file lives in. No win32 entry, same as
// the CLI's own opener table — package.json's `os` field declares only darwin and linux supported.
const REVEALERS = {
  darwin: (path) => ['open', ['-R', path]],
  linux: (path) => ['xdg-open', [dirname(path)]],
};

// A click on a path in the transcript, not a browse — the daemon already runs code as this user, so
// asking it to point Finder at one of their own files is not a new trust boundary. `run` stands in
// for `execFile` in tests, the same seam the CLI's own `openUrl` uses to avoid actually launching a
// window during a test run.
export function fsRevealRoute({ platform = process.platform, run = execFile } = {}) {
  return {
    method: 'POST', path: '/api/fs/reveal', stateChanging: true,
    handler: async (req, res) => {
      const body = await readJson(req, res);
      if (body === undefined) return;

      const target = typeof body.path === 'string' ? body.path : '';
      if (target === '' || !isAbsolute(target)) return json(res, 400, { error: 'bad_path' });

      let real;
      try { real = realpathSync(target); }
      catch { return json(res, 404, { error: 'not_found' }); }

      const build = REVEALERS[platform];
      if (!build) return json(res, 501, { error: 'unsupported_platform' });

      const [cmd, args] = build(real);
      run(cmd, args, (err) => {
        if (err) return json(res, 500, { error: 'reveal_failed', detail: err.message });
        json(res, 200, { ok: true });
      });
    },
  };
}
