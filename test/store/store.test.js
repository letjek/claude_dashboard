// test/store/store.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { createRunsRepo } from '../../src/store/runs.js';
import { createSessionsRepo } from '../../src/store/sessions.js';

const fresh = () => openDb(join(mkdtempSync(join(tmpdir(), 'ap-db-')), 'nested', 'data.db'));
const baseRun = { id: 's1:t1', sessionId: 's1', agentType: 'programmer', description: 'do a thing', prompt: 'p', startedAt: 1000 };

test('database file is created 0600', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ap-db-')), 'data.db');
  openDb(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('open then close produces a completed run with a duration', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  runs.close({ id: 's1:t1', status: 'done', endedAt: 3500, resultPreview: 'ok' });
  const row = runs.get('s1:t1');
  assert.equal(row.status, 'done');
  assert.equal(row.durationMs, 2500);
  assert.equal(row.resultPreview, 'ok');
});

test('close honours an explicitly supplied durationMs', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  runs.close({ id: 's1:t1', status: 'done', endedAt: 3500, durationMs: 99, resultPreview: 'ok' });
  assert.equal(runs.get('s1:t1').durationMs, 99);
});

test('open is idempotent — a replayed hook does not duplicate or reset the row', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  runs.open({ ...baseRun, startedAt: 9999, description: 'changed' });
  assert.equal(runs.listActive().length, 1);
  assert.equal(runs.get('s1:t1').startedAt, 1000);
});

test('closing an unknown id is a silent no-op', () => {
  const runs = createRunsRepo(fresh());
  assert.equal(runs.close({ id: 'ghost', status: 'done', endedAt: 1 }), false);
  assert.equal(runs.get('ghost'), null);
});

test('a replayed close reports no transition and does not alter the row', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  assert.equal(runs.close({ id: 's1:t1', status: 'done', endedAt: 3000, resultPreview: 'ok' }), true);
  assert.equal(runs.close({ id: 's1:t1', status: 'error', endedAt: 9999, resultPreview: 'CHANGED' }), false);
  const row = runs.get('s1:t1');
  assert.equal(row.status, 'done');
  assert.equal(row.endedAt, 3000);
  assert.equal(row.resultPreview, 'ok');
});

test('a backwards clock cannot store a negative duration', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'back', startedAt: 5000 });
  runs.close({ id: 'back', status: 'done', endedAt: 1000 });
  assert.equal(runs.get('back').durationMs, 0);
});

test('listActive returns only running rows, newest first', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'a', startedAt: 1 });
  runs.open({ ...baseRun, id: 'b', startedAt: 2 });
  runs.close({ id: 'a', status: 'done', endedAt: 5 });
  assert.deepEqual(runs.listActive().map((r) => r.id), ['b']);
});

test('markStaleBefore only touches running rows older than the cutoff', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'old', startedAt: 1 });
  runs.open({ ...baseRun, id: 'new', startedAt: 10_000 });
  runs.markStaleBefore(5000, 20_000);
  assert.equal(runs.get('old').status, 'stale');
  assert.equal(runs.get('new').status, 'running');
});

test('endSessionRuns marks that session\'s open runs stale and leaves others alone', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'mine', sessionId: 's1' });
  runs.open({ ...baseRun, id: 'other', sessionId: 's2' });
  runs.endSessionRuns('s1', 7000);
  assert.equal(runs.get('mine').status, 'stale');
  assert.equal(runs.get('other').status, 'running');
});

test('enrich attaches transcript data to the oldest matching open run', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'first', startedAt: 1 });
  runs.open({ ...baseRun, id: 'second', startedAt: 2 });
  const hit = runs.enrich({ sessionId: 's1', agentType: 'programmer' }, { transcriptPath: '/t.jsonl' });
  assert.equal(hit, 'first');
  assert.equal(runs.get('first').transcriptPath, '/t.jsonl');
  assert.equal(runs.get('second').transcriptPath, null);
});

test('enrich returns null when nothing matches, rather than guessing', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  assert.equal(runs.enrich({ sessionId: 's1', agentType: 'qa' }, { transcriptPath: '/t' }), null);
});

// A background dispatch reports its agent id at launch and keeps running. Recording the id without
// closing the row is the whole fix for a subagent that rendered as done in 0s.
test('launch records the agent id and leaves the run running', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  assert.equal(runs.launch({ id: 's1:t1', agentId: 'ag_7' }), true);
  const row = runs.get('s1:t1');
  assert.equal(row.status, 'running');
  assert.equal(row.agentId, 'ag_7');
});

// The bug this pins cost two of five subagents their completion. PreToolUse and PostToolUse reach
// the daemon as two separate hook processes racing, and for an async dispatch they fire a
// millisecond apart — so PostToolUse can win. `launch` used to be a bare UPDATE, so losing that race
// discarded the agent id with no retry and no log, and the only exact join between a launch and the
// SubagentStop that ends it was gone. The run then sat `running` until the 30-minute sweeper, and its
// result landed on whichever other row the fallback heuristic picked.
test('launch arriving before open keeps the agent id instead of discarding it', () => {
  const runs = createRunsRepo(fresh());
  assert.equal(runs.launch({ id: 's1:t1', agentId: 'ag_7', sessionId: 's1', startedAt: 1200 }), true);
  assert.equal(runs.get('s1:t1').agentId, 'ag_7');
  assert.equal(runs.get('s1:t1').status, 'running');
});

test('the open that lost the race still fills in the details, and does not move the start time later', () => {
  const runs = createRunsRepo(fresh());
  runs.launch({ id: 's1:t1', agentId: 'ag_7', sessionId: 's1', startedAt: 1200 });
  runs.open(baseRun);                                  // startedAt 1000: the real, earlier one
  const row = runs.get('s1:t1');
  assert.equal(row.agentType, 'programmer');
  assert.equal(row.description, 'do a thing');
  assert.equal(row.prompt, 'p');
  assert.equal(row.agentId, 'ag_7');                   // not lost to the later insert
  assert.equal(row.startedAt, 1000);                   // PreToolUse is when it really started
});

test('a run whose launch overtook its open still closes on its own subagent stop', () => {
  const runs = createRunsRepo(fresh());
  runs.launch({ id: 's1:t1', agentId: 'ag_7', sessionId: 's1', startedAt: 1200 });
  runs.open(baseRun);
  const outcome = runs.finish(
    { agentId: 'ag_7', sessionId: 's1', agentType: 'programmer' },
    { endedAt: 61_000, transcriptPath: '/a.jsonl', resultPreview: 'done here' },
  );
  assert.deepEqual(outcome, { id: 's1:t1', closed: true });
  const row = runs.get('s1:t1');
  assert.equal(row.status, 'done');
  assert.equal(row.durationMs, 60_000);
  assert.equal(row.resultPreview, 'done here');
});

// Without a real agent id there is nothing to record, and inserting anyway would leave a row with no
// type, no description and no prompt that nothing will ever close — a worse artefact than the
// dropped write it replaced.
test('a launch with no agent id creates nothing when the run is not there yet', () => {
  const runs = createRunsRepo(fresh());
  assert.equal(runs.launch({ id: 's1:t1', agentId: null, sessionId: 's1', startedAt: 1200 }), false);
  assert.equal(runs.get('s1:t1'), null);
});

test('launch refuses a run that is already finished', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  runs.close({ id: 's1:t1', status: 'done', endedAt: 2000 });
  assert.equal(runs.launch({ id: 's1:t1', agentId: 'ag_7' }), false);
  assert.equal(runs.get('s1:t1').agentId, null);
});

test('finish closes the launched run its agent id names, with a real duration', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  runs.launch({ id: 's1:t1', agentId: 'ag_7' });
  const outcome = runs.finish(
    { agentId: 'ag_7', sessionId: 's1', agentType: 'programmer' },
    { endedAt: 61_000, transcriptPath: '/a.jsonl', resultPreview: 'done here' },
  );
  assert.deepEqual(outcome, { id: 's1:t1', closed: true });
  const row = runs.get('s1:t1');
  assert.equal(row.status, 'done');
  assert.equal(row.durationMs, 60_000);
  assert.equal(row.transcriptPath, '/a.jsonl');
  assert.equal(row.resultPreview, 'done here');
});

// The foreground path still closes through PostToolUse, which reports the tool's own duration and
// its full response. SubagentStop arrives first and must only fill in the transcript.
test('finish only enriches when no launched run matches the agent id', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  const outcome = runs.finish(
    { agentId: 'ag_unknown', sessionId: 's1', agentType: 'programmer' },
    { endedAt: 61_000, transcriptPath: '/a.jsonl', resultPreview: 'partial' },
  );
  assert.deepEqual(outcome, { id: 's1:t1', closed: false });
  assert.equal(runs.get('s1:t1').status, 'running');
  assert.equal(runs.get('s1:t1').transcriptPath, '/a.jsonl');
});

// Otherwise one foreground agent's transcript would land on a background run of the same type that
// is still working, and the exact id it was launched with would be contradicted by a guess.
test('the heuristic never touches a run that was launched with an agent id', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  runs.launch({ id: 's1:t1', agentId: 'ag_7' });
  const outcome = runs.finish(
    { agentId: 'ag_other', sessionId: 's1', agentType: 'programmer' },
    { endedAt: 61_000, transcriptPath: '/other.jsonl', resultPreview: 'not mine' },
  );
  assert.equal(outcome, null);
  assert.equal(runs.get('s1:t1').transcriptPath, null);
});

test('finish reports nothing when neither the id nor the type matches', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  assert.equal(runs.finish({ agentId: null, sessionId: 's1', agentType: 'qa' }, { endedAt: 2000 }), null);
});

test('close records the agent id a foreground response reports', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  runs.close({ id: 's1:t1', status: 'done', endedAt: 3000, agentId: 'ag_7' });
  assert.equal(runs.get('s1:t1').agentId, 'ag_7');
});

// The rail scopes itself to the selected project, and the run row is the only thing it has to scope
// by. The cwd lives on the session, so every read joins it rather than copying it onto the run.
test('a run reports the project path of the session that dispatched it', () => {
  const db = fresh();
  const runs = createRunsRepo(db);
  const sessions = createSessionsRepo(db);
  sessions.touch({ id: 's1', projectPath: '/proj', source: 'terminal', at: 1000 });
  runs.open(baseRun);
  assert.equal(runs.get('s1:t1').projectPath, '/proj');
  assert.equal(runs.listActive()[0].projectPath, '/proj');
  assert.equal(runs.listRecent()[0].projectPath, '/proj');
});

test('a run whose session was never recorded reports no project rather than failing', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  assert.equal(runs.get('s1:t1').projectPath, null);
});

test('pruneBefore deletes finished rows older than the cutoff and keeps running ones', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'old' });
  runs.close({ id: 'old', status: 'done', endedAt: 100 });
  runs.open({ ...baseRun, id: 'live', startedAt: 100 });
  runs.pruneBefore(1000);
  assert.equal(runs.get('old'), null);
  assert.ok(runs.get('live'));
});

test('sessions touch upserts and preserves the original startedAt', () => {
  const s = createSessionsRepo(fresh());
  s.touch({ id: 'x', projectPath: '/p', source: 'terminal', at: 10 });
  s.touch({ id: 'x', projectPath: '/p', source: 'terminal', at: 20 });
  assert.equal(s.get('x').startedAt, 10);
  assert.equal(s.get('x').lastEventAt, 20);
  s.end('x', 30);
  assert.equal(s.get('x').status, 'ended');
});

test('staling records a duration so the row does not render as 0s', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'swept', startedAt: 1000 });
  runs.markStaleBefore(5000, 20_000);
  assert.equal(runs.get('swept').durationMs, 19_000);

  runs.open({ ...baseRun, id: 'ended', sessionId: 's9', startedAt: 2000 });
  runs.endSessionRuns('s9', 8000);
  assert.equal(runs.get('ended').durationMs, 6000);
});

test('endSessionRuns returns the ids it staled so the caller can broadcast each one', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'a', sessionId: 's1' });
  runs.open({ ...baseRun, id: 'b', sessionId: 's1' });
  runs.open({ ...baseRun, id: 'c', sessionId: 's2' });
  assert.deepEqual(runs.endSessionRuns('s1', 7000).sort(), ['a', 'b']);
  assert.deepEqual(runs.endSessionRuns('s1', 8000), [], 'nothing left open to report a second time');
});

test('a genuine completion recovers a staled run rather than being discarded', () => {
  // A run longer than the 30-minute sweeper window is marked stale while still alive. Its real
  // PostToolUse must be allowed to overwrite that guess, or the run is recorded as abandoned
  // forever with no duration and no result.
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'long', startedAt: 0 });
  runs.markStaleBefore(1000, 1_860_000);
  assert.equal(runs.get('long').status, 'stale');

  assert.equal(runs.close({ id: 'long', status: 'done', endedAt: 1_861_000, resultPreview: 'shipped' }), true);
  const row = runs.get('long');
  assert.equal(row.status, 'done');
  assert.equal(row.durationMs, 1_861_000);
  assert.equal(row.resultPreview, 'shipped');
});

test('a finished run is still immune to a later close', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'done-once' });
  runs.close({ id: 'done-once', status: 'done', endedAt: 2000, resultPreview: 'ok' });
  assert.equal(runs.close({ id: 'done-once', status: 'error', endedAt: 9000, resultPreview: 'no' }), false);
  assert.equal(runs.get('done-once').resultPreview, 'ok');
});

// A run that stops without ever reporting for itself — the Claude process died with its rate limit
// exhausted — used to be indistinguishable from one still working, right up until the sweeper staled
// it half an hour later. The reason is recorded beside the status, never as a fourth status value.
test('a swept run records why it was staled', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'abandoned', startedAt: 1000 });
  runs.markStaleBefore(5000, 20_000);
  const row = runs.get('abandoned');
  assert.equal(row.status, 'stale');
  assert.equal(row.stopReason, 'swept');
});

test('endSessionRuns stores the reason the caller knows for the ending', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'clean', sessionId: 's1' });
  runs.open({ ...baseRun, id: 'starved', sessionId: 's2' });
  runs.endSessionRuns('s1', 7000);
  runs.endSessionRuns('s2', 7000, 'rate_limit');
  assert.equal(runs.get('clean').stopReason, 'session_ended');
  assert.equal(runs.get('starved').stopReason, 'rate_limit');
});

// The sweeper knows only that nobody reported. Whoever staled the run first knew exactly why, and
// that is the reason the rail should keep showing.
test('a later sweep does not overwrite a reason already recorded', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'starved', sessionId: 's2', startedAt: 1000 });
  runs.endSessionRuns('s2', 3000, 'rate_limit');
  runs.markStaleBefore(5000, 20_000);
  assert.equal(runs.get('starved').stopReason, 'rate_limit');
});

test('a run that finishes for real has no stop reason left on it', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'long', startedAt: 0 });
  runs.markStaleBefore(1000, 1_860_000);
  assert.equal(runs.get('long').stopReason, 'swept');
  assert.equal(runs.close({ id: 'long', status: 'done', endedAt: 1_861_000, resultPreview: 'shipped' }), true);
  assert.equal(runs.get('long').stopReason, null, 'a completed run was never abandoned');
});

test('a dismissed run is gone from listRecent, which is what a reload reads', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'cleared' });
  runs.open({ ...baseRun, id: 'kept', startedAt: 2000 });
  runs.close({ id: 'cleared', status: 'done', endedAt: 2000 });
  runs.close({ id: 'kept', status: 'done', endedAt: 3000 });
  assert.deepEqual(runs.dismiss(['cleared'], 9000), ['cleared']);
  assert.deepEqual(runs.listRecent().map((r) => r.id), ['kept']);
  assert.equal(runs.get('cleared').dismissedAt, 9000, 'the row is still there, only hidden');
});

// The whole point of the status guard: no request, however it is shaped, may hide an agent that is
// genuinely still working. A rail that can be made to drop a live run is worse than one row too many.
test('dismissing a running run is refused', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'working' });
  assert.deepEqual(runs.dismiss(['working'], 9000), []);
  assert.equal(runs.get('working').dismissedAt, null);
  assert.deepEqual(runs.listRecent().map((r) => r.id), ['working']);
});

test('a stale run can be dismissed — it is not running, it was abandoned', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'abandoned', startedAt: 1000 });
  runs.markStaleBefore(5000, 20_000);
  assert.deepEqual(runs.dismiss(['abandoned'], 9000), ['abandoned']);
  assert.deepEqual(runs.listRecent(), []);
});

test('dismiss reports only the ids it actually dismissed', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'done-one' });
  runs.close({ id: 'done-one', status: 'done', endedAt: 2000 });
  assert.deepEqual(runs.dismiss(['ghost'], 9000), [], 'an unknown id is reported, not thrown');
  assert.deepEqual(runs.dismiss(['done-one', 'ghost'], 9000), ['done-one']);
  assert.deepEqual(runs.dismiss(['done-one'], 9500), [], 'a repeat changes nothing to broadcast');
  assert.equal(runs.get('done-one').dismissedAt, 9000, 'the first dismissal time stands');
});

test('dismiss survives a caller that passes something other than a list of ids', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'done-one' });
  runs.close({ id: 'done-one', status: 'done', endedAt: 2000 });
  assert.deepEqual(runs.dismiss(undefined, 9000), []);
  assert.deepEqual(runs.dismiss([{}, 7, null, 'done-one'], 9000), ['done-one']);
});

// listActive carries no dismissal filter because nothing can put a dismissed row back into
// `running`: open() is INSERT OR IGNORE, so a replayed dispatch of the same id leaves the finished,
// dismissed row exactly as it is rather than reviving it into the rail.
test('a dismissed run cannot come back through listActive', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'cleared' });
  runs.close({ id: 'cleared', status: 'done', endedAt: 2000 });
  runs.dismiss(['cleared'], 9000);
  runs.open({ ...baseRun, id: 'cleared', startedAt: 12_000 });
  assert.deepEqual(runs.listActive(), []);
  assert.equal(runs.get('cleared').status, 'done');
  assert.deepEqual(runs.listRecent(), []);
});

// The columns arrived after the first release, and `CREATE TABLE IF NOT EXISTS` does nothing to a
// table that already exists. A database written by the old schema has to gain them on open, with its
// rows intact — the alternative is a daemon that throws on every read the moment it is upgraded.
test('opening a database written by the old schema adds the new columns', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ap-mig-')), 'data.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE runs (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_type TEXT, description TEXT, prompt TEXT,
    status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, duration_ms INTEGER,
    result_preview TEXT, transcript_path TEXT)`);
  old.exec("INSERT INTO runs (id, session_id, agent_type, status, started_at) VALUES ('legacy', 's1', 'qa', 'done', 100)");
  old.close();

  const db = openDb(path);
  const columns = db.prepare('PRAGMA table_info(runs)').all().map((c) => c.name);
  assert.ok(columns.includes('stop_reason'));
  assert.ok(columns.includes('dismissed_at'));

  const runs = createRunsRepo(db);
  const row = runs.get('legacy');
  assert.equal(row.stopReason, null);
  assert.equal(row.dismissedAt, null);
  assert.deepEqual(runs.listRecent().map((r) => r.id), ['legacy'], 'a pre-existing row is visible, not hidden');
});
