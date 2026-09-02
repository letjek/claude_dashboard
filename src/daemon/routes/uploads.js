// src/daemon/routes/uploads.js
//
// The only route that takes file bytes rather than JSON, so it reads `req` itself instead of going
// through `readJson` — the body is piped straight to disk by `uploads.write`, never buffered whole
// in memory the way a JSON body is.
import { json } from './body.js';
import { normalizeProjectPath } from './chat.js';

export function uploadsRoute({ uploads }) {
  return {
    method: 'POST', path: '/api/uploads', stateChanging: true,
    handler: async (req, res, ctx) => {
      const rawProject = ctx.url.searchParams.get('projectPath');
      // No project selected yet is a real, supported case — the composer can attach a file before a
      // project is chosen. Only a project param that was actually sent and does not resolve is an error.
      const projectPath = rawProject === null || rawProject === '' ? null : normalizeProjectPath(rawProject);
      if (rawProject && projectPath === null) return json(res, 400, { error: 'bad_project' });

      const name = ctx.url.searchParams.get('name') ?? '';
      try {
        const { path } = await uploads.write(projectPath, name, req);
        json(res, 201, { path });
      } catch (err) {
        if (err?.code === 'TOO_LARGE') return json(res, 413, { error: 'too_large' });
        json(res, 500, { error: 'upload_failed', detail: String(err?.message ?? err) });
      }
    },
  };
}
