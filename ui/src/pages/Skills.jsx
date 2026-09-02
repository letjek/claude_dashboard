import { useState } from 'react';
import { AddSkillForm } from '../components/AddSkillForm.jsx';
import { PlusIcon } from '../components/icons.jsx';

export function Skills({ skills, initialQuery = '', catalogError, projectPath = null, onCreated }) {
  const [query, setQuery] = useState(initialQuery);
  const [adding, setAdding] = useState(false);
  const term = query.trim().toLowerCase();
  const shown = term
    ? skills.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(term))
    : skills;
  const failedToLoad = Boolean(catalogError) && skills.length === 0;

  return (
    <div>
      {/* The add affordance sits above every other state deliberately. It used to live below an early
          return for the empty catalog, which hid it in the one situation where writing a skill is the
          only thing left to do — and again whenever the catalog failed to load. */}
      <div className="page-actions">
        {adding
          ? (
            <AddSkillForm
              projectPath={projectPath}
              onCreated={(created) => { setAdding(false); onCreated?.(created); }}
              onCancel={() => setAdding(false)}
            />
          )
          : (
            <button type="button" className="btn accent" onClick={() => setAdding(true)}>
              <PlusIcon />
              Add skill
            </button>
          )}
      </div>

      {failedToLoad
        ? <p className="empty">Could not load the skill catalog ({catalogError}). Check the daemon is running and reload.</p>
        : (
          <>
            {catalogError && <p className="notice">Could not refresh the skill catalog ({catalogError}). Showing the last known list.</p>}
            {/* Hidden while the catalog is unread: a search box over nothing filters nothing, and
                offering it says the list below is complete when it is not. */}
            <label className="search">
              <span className="sr-only">Search skills</span>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search skills" />
            </label>
            {shown.length === 0
              ? (term
                  ? <p className="empty">No skills match “{query}”.</p>
                  : <p className="empty">No skills found in ~/.claude/skills, this project, or any enabled plugin.</p>)
              : <ul className="cards">
                  {shown.map((s) => (
                    <li key={`${s.scope}:${s.source ?? ''}:${s.name}`} className="card">
                      <h3>{s.name}</h3>
                      <p>{s.description}</p>
                      <dl>
                        <dt>scope</dt><dd><span className={`badge ${s.scope}`}>{s.scope}</span></dd>
                        {s.source && <><dt>from</dt><dd>{s.source}{s.version ? ` ${s.version}` : ''}</dd></>}
                      </dl>
                    </li>
                  ))}
                </ul>}
          </>
        )}
    </div>
  );
}
