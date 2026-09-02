import { useState } from 'react';
import { AddAgentForm } from '../components/AddAgentForm.jsx';
import { PlusIcon } from '../components/icons.jsx';

export function Agents({ agents, catalogError, projectPath = null, onCreated }) {
  const [adding, setAdding] = useState(false);
  // Identity, not the object reference: a `catalog.changed` refresh replaces every agent with a new
  // object, and keying on reference would silently drop out of the form the instant that broadcast
  // landed mid-edit.
  const [editingKey, setEditingKey] = useState(null);
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
          : (
            <button type="button" className="btn accent" onClick={() => setAdding(true)}>
              <PlusIcon />
              Add agent
            </button>
          )}
      </div>

      {failedToLoad && <p className="empty">Could not load the agent catalog ({catalogError}). Check the daemon is running and reload.</p>}
      {catalogError && agents.length > 0 && <p className="notice">Could not refresh the agent catalog ({catalogError}). Showing the last known list.</p>}
      {!catalogError && agents.length === 0 && <p className="empty">No agents found in ~/.claude/agents, this project, or any enabled plugin.</p>}

      {agents.length > 0 && (
        <ul className="cards">
          {agents.map((a) => {
            const key = `${a.scope}:${a.source ?? ''}:${a.name}`;
            // A plugin's files belong to whoever installed the plugin and are replaced wholesale on
            // upgrade — there is no write route for that scope, so no edit affordance pretends there is.
            const writable = a.scope === 'user' || a.scope === 'project';

            if (writable && editingKey === key) {
              return (
                <li key={key} className="card">
                  <AddAgentForm
                    projectPath={projectPath}
                    agent={a}
                    onCreated={(saved) => { setEditingKey(null); onCreated?.(saved); }}
                    onCancel={() => setEditingKey(null)}
                  />
                </li>
              );
            }

            const hasTools = Array.isArray(a.tools) ? a.tools.length > 0 : Boolean(a.tools);
            const body = (
              <>
                <h3>{a.name}</h3>
                <p>{a.description}</p>
                <dl>
                  <dt>scope</dt><dd><span className={`badge ${a.scope}`}>{a.scope}</span></dd>
                  {a.source && <><dt>from</dt><dd>{a.source}</dd></>}
                  {a.model && <><dt>model</dt><dd>{a.model}</dd></>}
                  {hasTools && <><dt>tools</dt><dd className="mono">{Array.isArray(a.tools) ? a.tools.join(', ') : a.tools}</dd></>}
                </dl>
              </>
            );

            return (
              <li key={key} className="card">
                {writable
                  ? (
                    <button type="button" className="card-trigger" aria-label={`Edit ${a.name}`} onClick={() => setEditingKey(key)}>
                      {body}
                    </button>
                  )
                  : body}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
