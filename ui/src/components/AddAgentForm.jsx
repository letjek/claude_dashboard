import { useEffect, useId, useState } from 'react';
import { fetchJson, postJson } from '../api.js';

// The daemon holds the same rule, and rejects anything else with `bad_name`. Keeping a copy here is
// what lets the form disable its own submit instead of teaching the rule through a round trip.
const NAME_RULE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// The exact set the SDK's AgentInput.model accepts, plus blank for "inherit whatever the session is
// running" — the only other value the daemon's frontmatter writer understands (an absent `model` key).
const MODEL_OPTIONS = [
  { value: '', label: 'Inherit (default)' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
  { value: 'haiku', label: 'Haiku' },
  { value: 'fable', label: 'Fable' },
];

// What the daemon reports, turned into a sentence that names the field or the file at fault. A bare
// `empty_description` or `bad_name` is a code the user cannot act on: with five inputs on screen it
// does not even say which one is wrong.
function explain(err, name) {
  const code = err?.message;
  const body = err?.body ?? {};
  if (code === 'exists') {
    // Nothing was written. Saying so matters because the obvious guess about a form that comes back
    // with an error is that it half-saved something.
    return `An agent called “${name}” already exists at ${body.path ?? 'that scope'}. Pick another name — nothing was written.`;
  }
  if (code === 'bad_name') return 'The name has to be lowercase kebab-case: letters and digits, joined by single hyphens.';
  if (code === 'bad_scope') return 'That scope is not one the daemon accepts. Choose user or project.';
  if (code === 'bad_project') return 'The selected project is no longer a folder on this machine. Pick another project, or write this agent into your user scope.';
  if (code === 'empty_description') return 'The description is empty. It is what the orchestrator reads when deciding whether to hand work to this agent, so it cannot be blank.';
  if (code === 'empty_body') return 'The system prompt is empty.';
  if (code === 'write_failed') return `The file could not be written (${body.detail ?? 'unknown error'}). Check the permissions on the folder it was going into.`;
  if (code === 'unauthorized') return 'Session expired — reopen the URL printed by agentpanel open.';
  if (code === 'not_found') return 'This agent no longer exists on disk — it may have been deleted or moved since this page loaded. Reload and try again.';
  return `Could not create the agent (${code ?? 'unknown error'}).`;
}

const toolsText = (tools) => (Array.isArray(tools) ? tools.join(', ') : (tools ?? ''));

// `agent` is present only when editing one that already exists — the daemon refuses to invent a
// file through `/api/catalog/agents/update`, so this form always opened by reading the real one.
export function AddAgentForm({ projectPath = null, agent = null, onCreated, onCancel }) {
  const id = useId();
  const editing = agent !== null;
  const [scope, setScope] = useState(agent?.scope ?? 'user');
  const [name, setName] = useState(agent?.name ?? '');
  const [blurred, setBlurred] = useState(false);
  const [description, setDescription] = useState(agent?.description ?? '');
  const [model, setModel] = useState(agent?.model ?? '');
  const [tools, setTools] = useState(toolsText(agent?.tools));
  const [prompt, setPrompt] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState(null);

  // The catalog scan never reads past an agent's frontmatter, so editing needs its own round trip
  // for the one field that scan does not carry.
  useEffect(() => {
    if (!editing) return;
    const params = new URLSearchParams({ scope: agent.scope, name: agent.name });
    if (agent.scope === 'project' && projectPath) params.set('projectPath', projectPath);
    fetchJson(`/api/catalog/agents/body?${params}`)
      .then((r) => setPrompt(r.prompt))
      .catch((err) => setFailure(explain(err, agent.name)));
    // Runs once, keyed by which agent is being edited: fetchJson/explain are stable module-level
    // helpers, not reactive inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, agent?.scope, agent?.name]);

  const trimmed = name.trim();
  const nameOk = editing || NAME_RULE.test(trimmed);
  // An untouched empty form should not be shouting a rule at someone who has typed nothing yet, but
  // a name already typed and already wrong should not wait for a blur to say so.
  const showNameError = !editing && !nameOk && (blurred || trimmed !== '');

  async function submit(e) {
    e.preventDefault();
    if (pending || !nameOk) return;
    setPending(true);
    setFailure(null);
    try {
      const body = { scope, name: trimmed, description: description.trim(), prompt };
      if (scope === 'project') body.projectPath = projectPath;
      if (model.trim() !== '') body.model = model.trim();
      // Blank is not the same as an empty list: an omitted `tools` inherits every tool, while a
      // present-but-empty one would mean an agent that can do nothing.
      const chosen = tools.split(',').map((t) => t.trim()).filter((t) => t !== '');
      if (chosen.length > 0) body.tools = chosen;

      const saved = await postJson(editing ? '/api/catalog/agents/update' : '/api/catalog/agents', body);
      if (!editing) {
        setName('');
        setBlurred(false);
        setDescription('');
        setModel('');
        setTools('');
        setPrompt('');
      }
      onCreated?.(saved?.agent ?? saved);
    } catch (err) {
      setFailure(explain(err, trimmed));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="card catalog-form" onSubmit={submit}>
      <h3>{editing ? 'Edit agent' : 'New agent'}</h3>

      {editing
        ? <p className="hint">Scope: <span className="badge">{scope}</span> — scope and name cannot be changed here.</p>
        : (
          <fieldset className="scope-choice">
            <legend>Scope</legend>
            <label>
              <input
                type="radio"
                name={`${id}-scope`}
                value="user"
                checked={scope === 'user'}
                onChange={() => { setScope('user'); setFailure(null); }}
              />
              <span>User <span className="mono">~/.claude/agents</span></span>
            </label>
            <label>
              <input
                type="radio"
                name={`${id}-scope`}
                value="project"
                checked={scope === 'project'}
                disabled={projectPath === null}
                onChange={() => { setScope('project'); setFailure(null); }}
              />
              <span>Project <span className="mono">{projectPath === null ? '.claude/agents' : `${projectPath}/.claude/agents`}</span></span>
            </label>
            {projectPath === null && <p className="hint">Choose a project first — there is no project folder to write into.</p>}
          </fieldset>
        )}

      <div className="field">
        <label htmlFor={`${id}-name`}>Name</label>
        <input
          id={`${id}-name`}
          value={name}
          disabled={editing}
          onChange={(e) => { setName(e.target.value); setFailure(null); }}
          onBlur={() => setBlurred(true)}
          placeholder="code-reviewer"
          autoComplete="off"
          spellCheck="false"
          aria-describedby={`${id}-name-hint`}
          aria-invalid={showNameError || undefined}
        />
        <p className="hint" id={`${id}-name-hint`}>Lowercase kebab-case — letters and digits joined by single hyphens. It becomes the filename.</p>
        {showNameError && (
          <p className="hint bad">
            {trimmed === '' ? 'A name is required.' : `“${trimmed}” is not lowercase kebab-case.`}
          </p>
        )}
      </div>

      <div className="field">
        <label htmlFor={`${id}-description`}>Description</label>
        <input
          id={`${id}-description`}
          value={description}
          onChange={(e) => { setDescription(e.target.value); setFailure(null); }}
          placeholder="Reviews a diff and reports defects. Read-only."
          autoComplete="off"
        />
        <p className="hint">One line. This is what the orchestrator reads when it decides whether to dispatch to this agent.</p>
      </div>

      <div className="field">
        <label htmlFor={`${id}-model`}>Model</label>
        <select
          id={`${id}-model`}
          value={model}
          onChange={(e) => { setModel(e.target.value); setFailure(null); }}
        >
          {MODEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <p className="hint">Optional. Blank inherits whatever model the session is running.</p>
      </div>

      <div className="field">
        <label htmlFor={`${id}-tools`}>Tools</label>
        <input
          id={`${id}-tools`}
          value={tools}
          onChange={(e) => { setTools(e.target.value); setFailure(null); }}
          placeholder="Read, Grep, Glob"
          autoComplete="off"
          spellCheck="false"
        />
        <p className="hint">Optional, comma-separated. Blank means every tool.</p>
      </div>

      <div className="field">
        <label htmlFor={`${id}-prompt`}>System prompt</label>
        <textarea
          id={`${id}-prompt`}
          value={prompt}
          onChange={(e) => { setPrompt(e.target.value); setFailure(null); }}
          rows={8}
          placeholder="You review code. You do not write it."
        />
      </div>

      {failure && <div className="notice" role="alert">{failure}</div>}

      <div className="catalog-form-actions">
        <button type="submit" className="btn primary" disabled={pending || !nameOk}>
          {editing ? (pending ? 'Saving…' : 'Save changes') : (pending ? 'Creating…' : 'Create agent')}
        </button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
