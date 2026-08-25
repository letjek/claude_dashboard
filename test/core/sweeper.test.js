// test/core/sweeper.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { createRunsRepo } from '../../src/store/runs.js';
import { startSweeper } from '../../src/core/sweeper.js';

const fresh = () => createRunsRepo(openDb(join(mkdtempSync(join(tmpdir(), 'ap-sw-')), 'data.db')));
const baseRun = { id: 'r1', sessionId: 's1', agentType: 'qa', description: 'd', prompt: 'p', startedAt: 0 };

// The run whose Claude process died and never reported: the sweeper is the only thing that ever
// closes it, and the row it broadcasts has to say so rather than leaving the rail to guess.
test('the sweeper stales an abandoned run and reports it as swept', () => {
  const runs = fresh();
  runs.open(baseRun);
  const seen = [];
  const stop = startSweeper({
    runs,
    hub: { broadcast: (event, payload) => seen.push([event, payload]) },
    now: () => 31 * 60 * 1000,
    intervalMs: 60_000,
  });
  stop();

  assert.equal(runs.get('r1').stopReason, 'swept');
  assert.deepEqual(seen.map(([event]) => event), ['run.close']);
  assert.equal(seen[0][1].id, 'r1');
  assert.equal(seen[0][1].status, 'stale');
  assert.equal(seen[0][1].stopReason, 'swept', 'the broadcast carries the reason, not only the status');
});

test('a run inside the stale window is left alone, with no reason recorded', () => {
  const runs = fresh();
  runs.open(baseRun);
  const seen = [];
  const stop = startSweeper({ runs, hub: { broadcast: (e) => seen.push(e) }, now: () => 60_000, intervalMs: 60_000 });
  stop();

  const row = runs.get('r1');
  assert.equal(row.status, 'running');
  assert.equal(row.stopReason, null);
  assert.deepEqual(seen, []);
});

// Whoever staled the run first knew exactly why. The sweeper only knows that nobody reported, so it
// must not paint over a specific reason with its own.
test('the sweeper does not relabel a run whose ending was already explained', () => {
  const runs = fresh();
  runs.open(baseRun);
  runs.endSessionRuns('s1', 1000, 'rate_limit');
  const stop = startSweeper({ runs, hub: { broadcast: () => {} }, now: () => 31 * 60 * 1000, intervalMs: 60_000 });
  stop();
  assert.equal(runs.get('r1').stopReason, 'rate_limit');
});
