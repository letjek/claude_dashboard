import { useId, useState } from 'react';
import { postJson } from '../api.js';

// The daemon holds the same rule, and rejects anything else with `bad_name`. Keeping a copy here is
// what lets the form disable its own submit instead of teaching the rule through a round trip.
const NAME_RULE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// What the daemon reports, turned into a sentence that names the field or the file at fault. A bare
// `empty_body` or `bad_name` is a code the user cannot act on: it does not even say which of the
// inputs above it is wrong.
function explain(err, name) {
  const code = err?.message;
  const body = err?.body ?? {};
  if (code === 'exists') {
    // Nothing was written. Saying so matters because the obvious guess about a form that comes back
    // with an error is that it half-saved something.
    return `A skill called “${name}” already exists at ${body.path ?? 'that scope'}. Pick another name — nothing was written.`;
  }
  if (code === 'bad_name') return 'The name has to be lowercase kebab-case: letters and digits, joined by single hyphens.';
  if (code === 'bad_scope') return 'That scope is not one the daemon accepts. Choose user or project.';
  if (code === 'bad_project') return 'The selected project is no longer a folder on this machine. Pick another project, or write this skill into your user scope.';
  if (code === 'empty_description') return 'The description is empty. It is the only thing Claude reads when deciding whether to load this skill, so it cannot be blank.';
  if (code === 'empty_body') return 'The instructions are empty. A skill with no body is a file that does nothing.';
  if (code === 'write_failed') return `The file could not be written (${body.detail ?? 'unknown error'}). Check the permissions on the folder it was going into.`;
  if (code === 'unauthorized') return 'Session expired — reopen the URL printed by agentpanel open.';
  return `Could not create the skill (${code ?? 'unknown error'}).`;
}

export function AddSkillForm({ projectPath = null, onCreated, onCancel }) {
  const id = useId();
  const [scope, setScope] = useState('user');
  const [name, setName] = useState('');
  const [blurred, setBlurred] = useState(false);
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
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
      const payload = { scope, name: trimmed, description: description.trim(), body };
      if (scope === 'project') payload.projectPath = projectPath;

      const created = await postJson('/api/catalog/skills', payload);
      setName('');
      setBlurred(false);
      setDescription('');
      setBody('');
      onCreated?.(created?.skill ?? created);
    } catch (err) {
      setFailure(explain(err, trimmed));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="card catalog-form" onSubmit={submit}>
      <h3>New skill</h3>

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
          <span>User <span className="mono">~/.claude/skills</span></span>
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
          <span>Project <span className="mono">{projectPath === null ? '.claude/skills' : `${projectPath}/.claude/skills`}</span></span>
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
          placeholder="release-checklist"
          autoComplete="off"
          spellCheck="false"
          aria-describedby={`${id}-name-hint`}
          aria-invalid={showNameError || undefined}
        />
        <p className="hint" id={`${id}-name-hint`}>Lowercase kebab-case — letters and digits joined by single hyphens. It becomes the folder name.</p>
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
          placeholder="Runs the release checklist before a tag is cut."
          autoComplete="off"
        />
        <p className="hint">One line. This is the only part Claude reads when deciding whether to load the skill.</p>
      </div>

      <div className="field">
        <label htmlFor={`${id}-body`}>Instructions</label>
        <textarea
          id={`${id}-body`}
          value={body}
          onChange={(e) => { setBody(e.target.value); setFailure(null); }}
          rows={10}
          placeholder={'## Steps\n\n1. …'}
        />
        <p className="hint">Markdown. Written as the body of SKILL.md, under the frontmatter the daemon generates.</p>
      </div>

      {failure && <div className="notice" role="alert">{failure}</div>}

      <div className="catalog-form-actions">
        <button type="submit" className="btn primary" disabled={pending || !nameOk}>
          {pending ? 'Creating…' : 'Create skill'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
