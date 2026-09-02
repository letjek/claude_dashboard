// Reads report the daemon's own error code the same way writes do. The directory picker is what
// forced this: a 403 from `/api/fs/list` carries the home directory it confined the request to, and
// a 400 says whether the path was a file or was not absolute — all of it thrown away when this only
// ever raised `request_failed_<status>`.
export async function fetchJson(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (res.status === 401) throw Object.assign(new Error('unauthorized'), { status: 401 });
  if (!res.ok) {
    let payload = null;
    try { payload = await res.json(); } catch { /* an error response may carry no body at all */ }
    throw Object.assign(new Error(payload?.error ?? `request_failed_${res.status}`), { status: res.status, body: payload });
  }
  return res.json();
}

// Writes report the daemon's own error code (`bad_project`, `unknown_request`, `empty_message`) as
// the thrown message, with the status attached: the caller has to tell "this prompt was already
// resolved" (404) apart from "the daemon is unreachable", and a generic `request_failed_404` cannot.
export async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* an error response may carry no body at all */ }
  if (res.status === 401) throw Object.assign(new Error('unauthorized'), { status: 401 });
  if (!res.ok) {
    throw Object.assign(new Error(payload?.error ?? `request_failed_${res.status}`), { status: res.status, body: payload });
  }
  return payload;
}

// The one route that takes file bytes rather than JSON: the composer's attach button, where a
// click-based file picker cannot expose a path the way a Finder drag sometimes does. `file` is
// posted as the body verbatim — fetch streams a File/Blob without buffering it into a string first.
export async function uploadFile(file, { projectPath = null } = {}) {
  const params = new URLSearchParams({ name: file.name });
  if (projectPath) params.set('projectPath', projectPath);
  const res = await fetch(`/api/uploads?${params}`, { method: 'POST', body: file });
  let payload = null;
  try { payload = await res.json(); } catch { /* an error response may carry no body at all */ }
  if (res.status === 401) throw Object.assign(new Error('unauthorized'), { status: 401 });
  if (!res.ok) {
    throw Object.assign(new Error(payload?.error ?? `request_failed_${res.status}`), { status: res.status, body: payload });
  }
  return payload;
}

const EVENTS = [
  'run.open', 'run.close', 'run.enrich', 'session.end', 'catalog.changed',
  // Chat rides the same stream. EventSource dispatches only to named listeners, so an event the
  // daemon broadcasts under a name absent from this list is silently dropped — adding a server-side
  // event without adding it here is invisible rather than noisy.
  'chat.delta', 'chat.message', 'chat.tool_use', 'chat.result', 'chat.error', 'chat.status',
  'permission.request', 'permission.resolved',
  // Clearing a finished run is durable now, so a second tab has to hear about it or it keeps
  // showing rows this one has already dismissed.
  'run.dismiss',
];

export function connectStream({ onEvent, onError, onOpen }) {
  const source = new EventSource('/api/stream');
  for (const name of EVENTS) {
    source.addEventListener(name, (e) => onEvent(name, JSON.parse(e.data)));
  }
  // EventSource reconnects on its own after a transient drop (a laptop waking, a dropped TCP
  // connection) without telling the caller anything went wrong beyond the earlier onerror. Without
  // this, a "connection lost" notice set by onerror is only ever cleared by the next delivered event
  // — which on an idle dashboard may be never.
  source.onopen = () => onOpen?.();
  source.onerror = () => onError?.(new Error('stream_disconnected'));
  return () => source.close();
}
