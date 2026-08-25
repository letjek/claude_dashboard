import { useState } from 'react';
import { postJson } from '../api.js';
import { RunRow } from './RunRow.jsx';
import { finishedIds, runToolUseId, visibleRuns } from './runList.js';

const rank = (r) => (r.status === 'running' ? 0 : 1);

// A failed clear used to blame the connection whatever went wrong, which sent the reader looking in
// entirely the wrong place: the daemon that has no `/api/runs/dismiss` at all answers `not_found`
// from its route table, and it is a daemon still running the code it was started with. Restarting it
// is the fix, and nothing about waiting for a connection was ever going to help.
function explainClear(err) {
  if (err?.status === 404) {
    return 'this daemon has no clear endpoint — it is still running the code it was started with. Stop it and open the dashboard again to pick up the current version';
  }
  if (err?.status === 401 || err?.message === 'unauthorized') {
    return 'the session expired — reopen the URL printed by agentpanel open';
  }
  return `${err?.message ?? String(err)} — try again when the connection is back`;
}

export function LiveRail({ runs, now, taskActivity = {}, projectPath = null }) {
  // One row open at a time, and kept here rather than in App: which row a user has expanded is a
  // property of this panel, and lifting it would re-render the whole shell on every click.
  const [openId, setOpenId] = useState(null);
  // Only the optimistic half of clearing. The durable half is the daemon's — `POST /api/runs/dismiss`
  // takes the rows out of `GET /api/runs`, and the `run.dismiss` broadcast takes them out of App's
  // list in every open tab. This set is what makes the press feel instant, and what is undone again
  // when the request turns out to have failed: hiding a row this side alone is what let three
  // cleared rows come back on the next reload.
  const [dismissed, setDismissed] = useState(() => new Set());
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState(null);

  const scoped = visibleRuns(runs, { projectPath, dismissed });
  const ordered = [...scoped].sort((a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt);
  const finished = finishedIds(ordered);

  async function clearFinished() {
    const ids = finished;
    if (ids.length === 0) return;
    setDismissed((prev) => new Set([...prev, ...ids]));
    setClearing(true);
    setClearError(null);
    try {
      await postJson('/api/runs/dismiss', { ids });
    } catch (err) {
      // The rows come back rather than staying hidden on a promise the daemon never kept: a reload
      // would return them anyway, and a panel that quietly disagrees with the next page load is the
      // bug this whole change exists to fix.
      setDismissed((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
      setClearError(explainClear(err));
    } finally {
      setClearing(false);
    }
  }

  return (
    // aria-live: the whole point of this panel is that it changes while the user watches it.
    // Left at the spec default relevance ("additions text") rather than narrowed to "additions
    // removals" — a run finishing or erroring updates its row's badge/status text in place (an
    // addition of a differently-typed node, or a text mutation) rather than adding or removing a
    // list item, and the default set is what actually catches those. The per-second elapsed clock
    // that ticks inside every row is marked aria-hidden in RunRow so it never gets announced.
    <aside className="rail" aria-label="Live agents" aria-live="polite">
      <div className="rail-head">
        <h2>Live agents</h2>
        {finished.length > 0 && (
          <button
            type="button"
            className="btn subtle rail-clear"
            disabled={clearing}
            onClick={clearFinished}
          >
            {clearing ? 'Clearing…' : 'Clear finished'}
          </button>
        )}
      </div>
      {clearError && (
        <p className="notice" role="status">
          Those rows could not be cleared: {clearError}. They are still here, and still in the daemon.
        </p>
      )}
      {ordered.length === 0
        ? (
          <p className="empty">
            {projectPath === null
              ? 'No agents running. Dispatch one from any Claude Code session and it appears here.'
              : 'No agents running in this project. Dispatch one here, or from a Claude Code session in this directory, and it appears here.'}
          </p>
        )
        : (
          <ul>
            {ordered.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                now={now}
                // Progress events only exist for the project whose session is open in the chat, so a
                // row dispatched from a terminal elsewhere gets undefined here and falls back to
                // what the hooks recorded. That is a gap in the data, not in the row.
                activity={taskActivity[runToolUseId(run)]}
                expanded={openId === run.id}
                onToggle={(id) => setOpenId((current) => (current === id ? null : id))}
              />
            ))}
          </ul>
        )}
    </aside>
  );
}
