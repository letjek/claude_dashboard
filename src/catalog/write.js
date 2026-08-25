// src/catalog/write.js
//
// Creating an agent or a skill on disk. Pure rendering plus two writers; nothing here knows about
// HTTP, so the rules below hold for any caller.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME = 64;

// This allowlist is the entire path-traversal defence. A name is spliced straight into a filesystem
// path, and lowercase letters, digits and interior hyphens are all it may contain: no slash, no
// backslash, no dot, no `..`, no leading or trailing hyphen can ever be spelled. There is deliberately
// no sanitising step — a name either passes as written or is refused, because a rewrite is exactly
// where a traversal sneaks back in.
export function validateName(name) {
  return typeof name === 'string' && name.length <= MAX_NAME && NAME_RE.test(name);
}

// The directory an agent or skill of a given scope belongs in. `'plugin'` is not a scope you can
// write to — the plugin cache belongs to whoever installed the plugin and is replaced wholesale on
// upgrade — so it returns null here and the caller refuses the request.
export function targetDir({ claudeDir, projectRoot, scope, kind }) {
  const leaf = kind === 'agent' ? 'agents' : kind === 'skill' ? 'skills' : null;
  if (leaf === null) return null;
  if (scope === 'user') return claudeDir ? join(claudeDir, leaf) : null;
  if (scope === 'project') return projectRoot ? join(projectRoot, '.claude', leaf) : null;
  return null;
}

// Values that the frontmatter parser would read back as something other than the string we wrote.
// `true`/`false`/a bare integer coerce to a boolean or a number, `[...]` becomes a list, a `:` or a
// `#` changes how the line itself is cut up, and surrounding whitespace is trimmed away.
function needsQuoting(value) {
  if (value === '') return true;
  if (/[:#"\n]/.test(value)) return true;
  if (value !== value.trim()) return true;
  if (value === 'true' || value === 'false') return true;
  if (/^-?\d+$/.test(value)) return true;
  return value.startsWith('[');
}

export function yamlScalar(value) {
  const text = String(value ?? '');
  return needsQuoting(text) ? JSON.stringify(text) : text;
}

// One value the quoted form cannot carry: a double quote. `JSON.stringify` escapes it as `\"`, and
// the frontmatter parser's `unquote` strips the surrounding quotes without unescaping what is inside,
// so the value reads back with literal backslashes in it. A folded block scalar needs no escaping at
// all and the parser reads `>` in full, so a value containing a quote is written that way instead.
// The text is flattened to one line first: a block scalar's indentation is what delimits it, and a
// stray newline in the middle would end the block early and swallow the rest of the frontmatter.
export function scalarField(key, value) {
  const text = String(value ?? '');
  if (!text.includes('"')) return `${key}: ${yamlScalar(text)}`;
  return `${key}: >-\n  ${text.replace(/\s*\n\s*/g, ' ')}`;
}

// A description is a one-line field in every reader that consumes it, so a pasted paragraph is
// folded rather than rejected: newlines become single spaces and the value stays on its own line.
// Exported because a caller reporting what it just wrote has to report the folded text, or the UI
// shows one description and the next rescan shows another.
export function foldDescription(value) {
  return String(value ?? '').replace(/\s*\n\s*/g, ' ').trim();
}

function toolsValue(tools) {
  const list = Array.isArray(tools) ? tools : String(tools ?? '').split(',');
  const cleaned = list.map((t) => String(t ?? '').trim()).filter((t) => t.length > 0);
  // A flow sequence, which the parser already reads back as an array.
  return cleaned.length > 0 ? `[${cleaned.join(', ')}]` : null;
}

export function renderAgent({ name, description, model, tools, prompt }) {
  const lines = [
    '---',
    scalarField('name', name),
    scalarField('description', foldDescription(description)),
  ];
  // `model` and `tools` are omitted entirely when absent: an empty key reads back as a list, and an
  // explicit null would pin the agent to something the user never chose.
  if (typeof model === 'string' && model.trim() !== '') lines.push(scalarField('model', model.trim()));
  const rendered = toolsValue(tools);
  if (rendered !== null) lines.push(`tools: ${rendered}`);
  lines.push('---', '');
  return `${lines.join('\n')}\n${String(prompt ?? '').trim()}\n`;
}

export function renderSkill({ name, description, body }) {
  const lines = [
    '---',
    scalarField('name', name),
    scalarField('description', foldDescription(description)),
    '---',
    '',
  ];
  return `${lines.join('\n')}\n${String(body ?? '').trim()}\n`;
}

function fail(err) {
  return { ok: false, reason: 'write_failed', detail: err?.code ?? String(err?.message ?? err) };
}

// `recursive: true` is silent when the directory is already there, so anything thrown here is a real
// failure — a plain file sitting where the directory has to go, or a permission the daemon lacks.
// It is kept apart from the write because its EEXIST means "something is in the way", not "this
// agent already exists", and the two must not report the same thing to the caller.
function ensureDir(dir) {
  try { mkdirSync(dir, { recursive: true }); return null; }
  catch (err) { return fail(err); }
}

export function writeAgent({ claudeDir, projectRoot, scope, name, description, model, tools, prompt }) {
  if (!validateName(name)) return { ok: false, reason: 'bad_name' };
  const dir = targetDir({ claudeDir, projectRoot, scope, kind: 'agent' });
  if (dir === null) return { ok: false, reason: 'bad_scope' };

  const path = join(dir, `${name}.md`);
  const dirError = ensureDir(dir);
  if (dirError) return dirError;
  try {
    // `wx` and never anything else: this surface creates files, it does not edit them, so an agent
    // someone spent an afternoon writing can never be replaced by a form submission.
    writeFileSync(path, renderAgent({ name, description, model, tools, prompt }), { flag: 'wx' });
  } catch (err) {
    if (err?.code === 'EEXIST') return { ok: false, reason: 'exists', path };
    return fail(err);
  }
  return { ok: true, path };
}

export function writeSkill({ claudeDir, projectRoot, scope, name, description, body }) {
  if (!validateName(name)) return { ok: false, reason: 'bad_name' };
  const dir = targetDir({ claudeDir, projectRoot, scope, kind: 'skill' });
  if (dir === null) return { ok: false, reason: 'bad_scope' };

  const skillDir = join(dir, name);
  const path = join(skillDir, 'SKILL.md');
  // A skill is a directory, and a directory may hold scripts and references beside its SKILL.md.
  // If it is already there we touch none of it — not even to add a missing SKILL.md.
  if (existsSync(skillDir)) return { ok: false, reason: 'exists', path };

  const dirError = ensureDir(skillDir);
  if (dirError) return dirError;
  try {
    writeFileSync(path, renderSkill({ name, description, body }), { flag: 'wx' });
  } catch (err) {
    if (err?.code === 'EEXIST') return { ok: false, reason: 'exists', path };
    return fail(err);
  }
  return { ok: true, path };
}
