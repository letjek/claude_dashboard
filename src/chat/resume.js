// src/chat/resume.js
//
// One automatic attempt to continue a conversation that stopped because the rate limit ran out.
//
// Exactly one, and never a second: an automatic retry loop against a limit that has not really
// lifted would burn the quota the moment it came back, unattended, with nobody watching the
// transcript. After that one attempt the project is spent and the dashboard offers a button
// instead — the decision goes back to the person whose quota it is.

export const RESUME_MESSAGE = 'Continue where you left off. The previous turn stopped because the rate limit ran out.';

// The reset timestamp is when the limit lifts, not when it is safe to lean on it. A few seconds of
// margin costs nothing and avoids spending the single automatic attempt on a request that arrives
// one clock-skew ahead of the window.
const MARGIN_MS = 5000;

export function createResumeScheduler({
  sessions, hub, now = Date.now,
  intervalMs = 30 * 1000,
  message = RESUME_MESSAGE,
  marginMs = MARGIN_MS,
}) {
  const pending = new Map();   // projectPath -> resetsAt
  const spent = new Set();     // projectPath whose one automatic attempt is gone

  const emit = (projectPath, data) => hub.broadcast('chat.status', { projectPath, ts: now(), ...data });

  /**
   * A session died with its limit exhausted. Arms the one automatic attempt, if it is still
   * available and if the SDK told us when the limit lifts.
   *
   * Returns whether anything was armed, so the caller can tell "waiting for the reset" apart from
   * "there is nothing to wait for" — the latter is what puts a manual Resume button on screen.
   */
  function arm({ projectPath, resetsAt }) {
    if (typeof projectPath !== 'string' || projectPath === '') return false;
    // No reset time means no moment to wake up at. Guessing one would either fire too early and
    // spend the attempt for nothing, or park forever.
    if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return false;
    if (spent.has(projectPath)) return false;
    pending.set(projectPath, resetsAt);
    emit(projectPath, { state: 'resume_scheduled', resetsAt });
    return true;
  }

  // The user got there first, or the conversation was reset. Either way the automatic attempt is
  // no longer wanted, and firing it afterwards would append a stray "continue" to a live session.
  function cancel(projectPath) {
    const had = pending.delete(projectPath);
    if (had) emit(projectPath, { state: 'resume_cancelled', resetsAt: null });
    return had;
  }

  // A new rate-limit episode deserves its own automatic attempt; this is what un-spends a project
  // once its session has genuinely run again.
  function clear(projectPath) {
    pending.delete(projectPath);
    spent.delete(projectPath);
  }

  function status(projectPath) {
    return {
      armed: pending.has(projectPath),
      resetsAt: pending.get(projectPath) ?? null,
      spent: spent.has(projectPath),
    };
  }

  async function fire(projectPath) {
    // Marked spent before the send, not after. A send that throws still used the attempt, and
    // retrying on failure is the loop this whole module exists to avoid.
    pending.delete(projectPath);
    spent.add(projectPath);
    emit(projectPath, { state: 'resuming', resetsAt: null });
    try {
      await sessions.send(projectPath, message);
    } catch (err) {
      hub.broadcast('chat.error', {
        projectPath, ts: now(),
        message: 'The automatic resume did not go through. Send a message when you are ready.',
        detail: String(err?.message ?? err),
        fatal: false,
      });
    }
  }

  function tick() {
    const t = now();
    for (const [projectPath, resetsAt] of [...pending]) {
      // Something else already brought the session back — a message typed by hand, most likely.
      // That also ends the episode, so the next one gets its own automatic attempt.
      if (sessions.get(projectPath)?.running) { clear(projectPath); continue; }
      if (t < resetsAt + marginMs) continue;
      fire(projectPath);
    }
  }

  // unref'd like the sweeper's: a scheduled resume must never be the reason the daemon refuses to
  // exit, and `agentpanel stop` should not have to wait out an interval.
  const handle = setInterval(tick, intervalMs);
  handle.unref?.();

  return { arm, cancel, clear, status, tick, stop() { clearInterval(handle); } };
}
