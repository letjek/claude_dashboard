import { useState } from 'react';
import { AddAgentForm } from '../components/AddAgentForm.jsx';

export function Agents({ agents, catalogError, projectPath = null, onCreated }) {
  const [adding, setAdding] = useState(false);
  const failedToLoad = Boolean(catalogError) && agents.length === 0;

  return (
    <div>
      {/* The add affordance sits above every other state deliberately. It used to live below an early
          return for the empty catalog, which hid it in the one situation where writing an agent is
          the only thing left to do — and again whenever the catalog failed to load. */}
      <div className="page-actions">
        {adding
          ? (
            <AddAgentForm
              projectPath={projectPath}
              onCreated={(created) => { setAdding(false); onCreated?.(created); }}
              onCancel={() => setAdding(false)}
            />
          )
          : <button type="button" className="btn subtle" onClick={() => setAdding(true)}>Add agent</button>}
      </div>

      {failedToLoad && <p className="empty">Could not load the agent catalog ({catalogError}). Check the daemon is running and reload.</p>}
      {catalogError && agents.length > 0 && <p className="notice">Could not refresh the agent catalog ({catalogError}). Showing the last known list.</p>}
      {!catalogError && agents.length === 0 && <p className="empty">No agents found in ~/.claude/agents, this project, or any enabled plugin.</p>}

      {agents.length > 0 && (
        <ul className="cards">
          {agents.map((a) => {
            const hasTools = Array.isArray(a.tools) ? a.tools.length > 0 : Boolean(a.tools);
            return (
              <li key={`${a.scope}:${a.source ?? ''}:${a.name}`} className="card">
                <h3>{a.name}</h3>
                <p>{a.description}</p>
                <dl>
                  <dt>scope</dt><dd><span className={`badge ${a.scope}`}>{a.scope}</span></dd>
                  {a.source && <><dt>from</dt><dd>{a.source}</dd></>}
                  {a.model && <><dt>model</dt><dd>{a.model}</dd></>}
                  {hasTools && <><dt>tools</dt><dd className="mono">{Array.isArray(a.tools) ? a.tools.join(', ') : a.tools}</dd></>}
                </dl>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
