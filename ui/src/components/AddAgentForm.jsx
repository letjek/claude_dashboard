import { useId, useState } from 'react';
import { postJson } from '../api.js';

// The daemon holds the same rule, and rejects anything else with `bad_name`. Keeping a copy here is
// what lets the form disable its own submit instead of teaching the rule through a round trip.
const NAME_RULE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

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
  return `Could not create the agent (${code ?? 'unknown error'}).`;
}

export function AddAgentForm({ projectPath = null, onCreated, onCancel }) {
  const id = useId();
  const [scope, setScope] = useState('user');
  const [name, setName] = useState('');
  const [blurred, setBlurred] = useState(false);
  const [description, setDescription] = useState('');
  const [model, setModel] = useState('');
  const [tools, setTools] = useState('');
  const [prompt, setPrompt] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState(null);

  const trimmed = name.trim();
  const nameOk = NAME_RULE.test(trimmed);
  // An untouched empty form should not be shouting a rule at someone who has typed nothing yet, but
  // a name already typed and already wrong should not wait for a blur to say so.
  const showNameError = !nameOk && (blurred || trimmed !== '');

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

      const created = await postJson('/api/catalog/agents', body);
      setName('');
      setBlurred(false);
      setDescription('');
      setModel('');
      setTools('');
      setPrompt('');
      onCreated?.(created?.agent ?? created);
    } catch (err) {
      setFailure(explain(err, trimmed));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="card catalog-form" onSubmit={submit}>
      <h3>New agent</h3>

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

      <div className="field">
        <label htmlFor={`${id}-name`}>Name</label>
        <input
          id={`${id}-name`}
          value={name}
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
        <input
          id={`${id}-model`}
          value={model}
          onChange={(e) => { setModel(e.target.value); setFailure(null); }}
          placeholder="opus"
          autoComplete="off"
          spellCheck="false"
        />
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
          {pending ? 'Creating…' : 'Create agent'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
