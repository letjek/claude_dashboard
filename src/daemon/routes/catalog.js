// src/daemon/routes/catalog.js
//
// Reading the catalog is a plain GET; creating an agent or a skill is a write to the user's home
// directory, so both create routes declare `stateChanging: true` and neither is `public` — the
// daemon's Origin + token guard runs before a page on another 127.0.0.1 port can drop a file in
// `~/.claude/agents`.
import { json, readJson } from './body.js';
import { normalizeProjectPath } from './chat.js';
import { foldDescription, validateName, writeAgent, writeSkill } from '../../catalog/write.js';

export function catalogRoute({ catalog }) {
  return {
    method: 'GET',
    path: '/api/catalog',
    handler: (_req, res) => {
      const payload = JSON.stringify(catalog.get());
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    },
  };
}

// `"Read, Write"` and `['Read', 'Write']` are both what a form sends depending on how the field is
// built; both mean the same thing. Nothing left after trimming means the key is omitted entirely,
// which is what an agent with no `tools` restriction looks like.
function normalizeTools(tools) {
  const list = Array.isArray(tools) ? tools : typeof tools === 'string' ? tools.split(',') : [];
  const cleaned = list.map((t) => (typeof t === 'string' ? t.trim() : '')).filter((t) => t.length > 0);
  return cleaned.length > 0 ? cleaned : null;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

// The scope decides which tree is written to, and `'plugin'` is not one of them: the plugin cache is
// replaced wholesale on upgrade, so anything written there is lost and was never the user's to edit.
function resolveScope(body) {
  if (body.scope === 'user') return { ok: true, projectRoot: null };
  if (body.scope !== 'project') return { ok: false, status: 400, error: 'bad_scope' };
  const projectRoot = normalizeProjectPath(body.projectPath);
  if (projectRoot === null) return { ok: false, status: 400, error: 'bad_project' };
  return { ok: true, projectRoot };
}

function failure(res, result) {
  if (result.reason === 'exists') return json(res, 409, { error: 'exists', path: result.path });
  return json(res, 500, { error: 'write_failed', detail: result.detail ?? null });
}

export function catalogWriteRoutes({ catalog, claudeDir, hub }) {
  // A project directory outside the daemon's cwd is not watched, so the file landing on disk raises
  // no fs event and other tabs would keep showing the old catalog. The explicit refresh + broadcast
  // is the only thing that makes a new agent appear everywhere.
  const announce = () => {
    catalog.refresh();
    hub.broadcast('catalog.changed', { scannedAt: Date.now() });
  };

  return [
    {
      method: 'POST', path: '/api/catalog/agents', stateChanging: true,
      handler: async (req, res) => {
        const body = await readJson(req, res);
        if (body === undefined) return;

        const scope = resolveScope(body);
        if (!scope.ok) return json(res, scope.status, { error: scope.error });
        if (!validateName(body.name)) return json(res, 400, { error: 'bad_name' });

        const description = nonEmpty(body.description);
        if (description === null) return json(res, 400, { error: 'empty_description' });
        const prompt = nonEmpty(body.prompt);
        if (prompt === null) return json(res, 400, { error: 'empty_body' });

        const model = nonEmpty(body.model);
        const tools = normalizeTools(body.tools);
        const result = writeAgent({
          claudeDir, projectRoot: scope.projectRoot, scope: body.scope,
          name: body.name, description, model, tools, prompt,
        });
        if (!result.ok) return failure(res, result);

        announce();
        json(res, 201, {
          agent: {
            kind: 'agent',
            name: body.name,
            description: foldDescription(description),
            tools,
            model: model ? model.trim() : null,
            scope: body.scope,
            source: null,
            path: result.path,
          },
        });
      },
    },
    {
      method: 'POST', path: '/api/catalog/skills', stateChanging: true,
      handler: async (req, res) => {
        const body = await readJson(req, res);
        if (body === undefined) return;

        const scope = resolveScope(body);
        if (!scope.ok) return json(res, scope.status, { error: scope.error });
        if (!validateName(body.name)) return json(res, 400, { error: 'bad_name' });

        const description = nonEmpty(body.description);
        if (description === null) return json(res, 400, { error: 'empty_description' });
        const skillBody = nonEmpty(body.body);
        if (skillBody === null) return json(res, 400, { error: 'empty_body' });

        const result = writeSkill({
          claudeDir, projectRoot: scope.projectRoot, scope: body.scope,
          name: body.name, description, body: skillBody,
        });
        if (!result.ok) return failure(res, result);

        announce();
        json(res, 201, {
          skill: {
            kind: 'skill',
            name: body.name,
            description: foldDescription(description),
            tools: null,
            model: null,
            scope: body.scope,
            source: null,
            version: null,
            path: result.path,
          },
        });
      },
    },
  ];
}
