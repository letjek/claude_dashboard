// src/daemon/routes/catalog.js
//
// Reading the catalog is a plain GET; creating an agent or a skill is a write to the user's home
// directory, so both create routes declare `stateChanging: true` and neither is `public` — the
// daemon's Origin + token guard runs before a page on another 127.0.0.1 port can drop a file in
// `~/.claude/agents`.
import { json, readJson } from './body.js';
import { normalizeProjectPath } from './chat.js';
import {
  foldDescription, validateName, writeAgent, writeSkill, updateAgent, readAgentSource,
} from '../../catalog/write.js';

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
      // The one place an agent file is opened for editing rather than created: reached only from a
      // form that read this same file first, so overwriting it is the edit the user asked for. Never
      // creates one that was not already there — that is still exclusively `/api/catalog/agents`.
      method: 'POST', path: '/api/catalog/agents/update', stateChanging: true,
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
        const result = updateAgent({
          claudeDir, projectRoot: scope.projectRoot, scope: body.scope,
          name: body.name, description, model, tools, prompt,
        });
        if (!result.ok) {
          if (result.reason === 'not_found') return json(res, 404, { error: 'not_found' });
          return failure(res, result);
        }

        announce();
        json(res, 200, {
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
      // Read-only, and needed only by the edit form: the catalog scan itself never reads a prompt
      // body, since a listing has no use for it and a body can run to several kilobytes.
      method: 'GET', path: '/api/catalog/agents/body',
      handler: (_req, res, ctx) => {
        const rawScope = ctx.url.searchParams.get('scope');
        const scope = resolveScope({ scope: rawScope, projectPath: ctx.url.searchParams.get('projectPath') });
        if (!scope.ok) return json(res, scope.status, { error: scope.error });

        const name = ctx.url.searchParams.get('name') ?? '';
        if (!validateName(name)) return json(res, 400, { error: 'bad_name' });

        const result = readAgentSource({ claudeDir, projectRoot: scope.projectRoot, scope: rawScope, name });
        if (!result.ok) return json(res, 404, { error: 'not_found' });
        json(res, 200, { prompt: result.prompt });
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
