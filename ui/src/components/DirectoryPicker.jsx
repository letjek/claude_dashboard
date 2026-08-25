import { useEffect, useState } from 'react';
import { fetchJson } from '../api.js';

// Keyed on the daemon's own error code, the way every sibling form here is. `fetchJson` reports it
// as the thrown message and attaches the body, so `outside_home` can name the ceiling it was
// confined to and `not_a_directory` is distinguishable from `bad_path` — a status code alone could
// tell neither apart.
function explain(err, path) {
  const code = err?.message;
  const where = path ? `${path} ` : '';
  if (code === 'outside_home') {
    const root = err?.body?.root;
    return `${where}is outside your home folder. The daemon will not look above ${root ?? 'it'}, so start again from Home.`;
  }
  if (code === 'not_found') return `${where}is not there any more. It may have been moved or deleted since this list was drawn.`;
  if (code === 'not_a_directory') return `${where}cannot be opened — it is a file rather than a folder.`;
  if (code === 'bad_path') return `${where}is not a path the daemon accepts. Paths here start at the root of the disk.`;
  if (code === 'unauthorized') return 'Session expired — reopen the URL printed by agentpanel open.';
  return `Could not read that folder (${code ?? 'unknown error'}).`;
}

// Home is the ceiling, so the first crumb is labelled for what it is rather than repeating an
// absolute path the user already sees in full below the trail.
function crumbs(root, path) {
  const trail = [{ label: 'Home', path: root }];
  if (path === root || !path.startsWith(`${root}/`)) return trail;
  let acc = root;
  for (const segment of path.slice(root.length + 1).split('/')) {
    acc = `${acc}/${segment}`;
    trail.push({ label: segment, path: acc });
  }
  return trail;
}

export function DirectoryPicker({ onPick, onClose }) {
  // Null means "wherever the daemon opens", which is home. Sending no `path` on the first request is
  // what keeps the home directory the daemon's business rather than something the browser guesses.
  const [target, setTarget] = useState(null);
  const [view, setView] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState(null);
  // Bumped on every navigation, including one back to where we already are. Without it, clicking a
  // folder whose read just failed is a same-value setState: React bails out, the effect never runs
  // again, and a folder that failed once — a transient ENOENT while a build rewrites it — could
  // never be opened again for the life of the picker. The same dead end caught the crumb of the
  // folder currently on screen.
  const [attempt, setAttempt] = useState(0);
  const go = (path) => { setTarget(path); setAttempt((n) => n + 1); };

  useEffect(() => {
    let live = true;
    setLoading(true);
    setFailure(null);
    fetchJson(target === null ? '/api/fs/list' : `/api/fs/list?path=${encodeURIComponent(target)}`)
      .then((d) => { if (live) setView(d); })
      // The previous listing stays on screen behind the message on purpose: a folder deleted under
      // the user is a reason to pick a different one, not a reason to lose the trail back to it.
      .catch((e) => { if (live) setFailure(explain(e, target)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [target, attempt]);

  const trail = view ? crumbs(view.root, view.path) : [];

  return (
    <div className="picker">
      <div className="picker-head">
        <h3>Browse folders</h3>
        <button type="button" className="btn subtle" onClick={onClose}>Close</button>
      </div>

      {view && (
        <div className="picker-crumbs">
          {trail.map((crumb, i) => (
            <span key={crumb.path}>
              {i > 0 && <span aria-hidden="true">/</span>}
              <button type="button" className="picker-crumb" onClick={() => go(crumb.path)}>{crumb.label}</button>
            </span>
          ))}
        </div>
      )}

      {failure && <div className="notice" role="alert">{failure}</div>}

      {loading && <p className="empty">Reading the folder…</p>}

      {view && !loading && (
        <>
          {view.parent !== null && (
            <button type="button" className="btn subtle picker-up" onClick={() => go(view.parent)}>↑ Up one folder</button>
          )}

          {view.entries.length === 0
            ? <p className="empty">Nothing but files in here — no folders to open. You can still use this one.</p>
            : (
              <ul className="picker-list">
                {view.entries.map((entry) => (
                  <li key={entry.path}>
                    <button type="button" className="picker-entry" onClick={() => go(entry.path)}>
                      <span className="picker-name mono">{entry.name}</span>
                      {/* These two markers are the whole reason for browsing rather than typing: they
                          say which of a dozen sibling folders is the repository the user meant, and
                          which one agentpanel is already tracking. */}
                      {entry.hasGit && <span className="badge">git</span>}
                      {entry.added && <span className="badge project">added</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}

          <p className="picker-path mono" title={view.path}>{view.path}</p>
          <button type="button" className="btn primary" onClick={() => onPick?.(view.path)}>Use this folder</button>
        </>
      )}
    </div>
  );
}
