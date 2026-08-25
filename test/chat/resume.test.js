// test/chat/resume.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResumeScheduler, RESUME_MESSAGE } from '../../src/chat/resume.js';

function harness({ start = 1000, running = false } = {}) {
  let clock = start;
  const events = [];
  const sent = [];
  const hub = {
    broadcast(event, data) { events.push({ event, data }); },
    of(name) { return events.filter((e) => e.event === name).map((e) => e.data); },
  };
  const state = { running };
  const sessions = {
    get() { return { running: state.running }; },
    async send(projectPath, text) {
      if (state.sendThrows) throw new Error(state.sendThrows);
      sent.push({ projectPath, text });
      return { queued: true };
    },
  };
  const resumes = createResumeScheduler({
    sessions, hub, now: () => clock, intervalMs: 1e9, marginMs: 5000,
  });
  return {
    hub, sent, state, resumes,
    advance(ms) { clock += ms; },
    at() { return clock; },
  };
}

const settled = () => new Promise((r) => setTimeout(r, 5));

test('arming waits for the reset and then sends exactly one continuation', async () => {
  const h = harness();
  assert.equal(h.resumes.arm({ projectPath: '/p', resetsAt: 5000 }), true);
  assert.deepEqual(h.resumes.status('/p'), { armed: true, resetsAt: 5000, spent: false });

  h.resumes.tick();
  assert.deepEqual(h.sent, [], 'nothing before the reset');

  // The margin is deliberate: the reset moment itself is not yet safe to lean on.
  h.advance(4200);
  h.resumes.tick();
  assert.deepEqual(h.sent, [], 'nothing at the reset moment without the margin');

  h.advance(5000);
  h.resumes.tick();
  await settled();
  assert.deepEqual(h.sent, [{ projectPath: '/p', text: RESUME_MESSAGE }]);
});

test('the automatic attempt is spent after one try and never fires twice', async () => {
  const h = harness();
  h.resumes.arm({ projectPath: '/p', resetsAt: 2000 });
  h.advance(10_000);
  h.resumes.tick();
  await settled();
  assert.equal(h.sent.length, 1);

  // Further ticks, and a second arm from a second death, must both stay silent: the point of the
  // whole module is that an unattended retry loop can never burn the quota as it comes back.
  h.resumes.tick();
  h.resumes.tick();
  assert.equal(h.resumes.arm({ projectPath: '/p', resetsAt: 20_000 }), false);
  h.advance(60_000);
  h.resumes.tick();
  await settled();
  assert.equal(h.sent.length, 1);
  assert.equal(h.resumes.status('/p').spent, true);
});

test('a failed send still spends the attempt rather than retrying into the same wall', async () => {
  const h = harness();
  h.state.sendThrows = 'still rate limited';
  h.resumes.arm({ projectPath: '/p', resetsAt: 2000 });
  h.advance(10_000);
  h.resumes.tick();
  await settled();

  const [error] = h.hub.of('chat.error');
  assert.equal(error.fatal, false);
  assert.match(error.message, /automatic resume did not go through/i);
  assert.equal(h.resumes.status('/p').spent, true);
});

test('no reset time means nothing is armed, so the dashboard offers the manual button instead', () => {
  const h = harness();
  assert.equal(h.resumes.arm({ projectPath: '/p', resetsAt: null }), false);
  assert.equal(h.resumes.arm({ projectPath: '/p', resetsAt: undefined }), false);
  assert.equal(h.resumes.arm({ projectPath: '/p' }), false);
  assert.equal(h.resumes.status('/p').armed, false);
  // Not spent either: no attempt was made, so a later death that does report a reset still gets one.
  assert.equal(h.resumes.status('/p').spent, false);
});

test('a session the user brought back by hand cancels the pending resume and re-arms the next episode', async () => {
  const h = harness();
  h.resumes.arm({ projectPath: '/p', resetsAt: 2000 });
  h.state.running = true;
  h.advance(10_000);
  h.resumes.tick();
  await settled();

  assert.deepEqual(h.sent, [], 'a live session is never sent a stray continuation');
  assert.deepEqual(h.resumes.status('/p'), { armed: false, resetsAt: null, spent: false });

  // And because the episode ended, the next rate limit gets its own automatic attempt.
  h.state.running = false;
  assert.equal(h.resumes.arm({ projectPath: '/p', resetsAt: 20_000 }), true);
});

test('cancel is explicit and reported, so a reset conversation is not resumed behind the user', () => {
  const h = harness();
  h.resumes.arm({ projectPath: '/p', resetsAt: 2000 });
  assert.equal(h.resumes.cancel('/p'), true);
  assert.equal(h.resumes.cancel('/p'), false, 'cancelling nothing announces nothing');

  const states = h.hub.of('chat.status').map((e) => e.state);
  assert.deepEqual(states, ['resume_scheduled', 'resume_cancelled']);
});

test('arming broadcasts the reset time so a reloaded page can render the countdown', () => {
  const h = harness();
  h.resumes.arm({ projectPath: '/p', resetsAt: 9000 });
  const [scheduled] = h.hub.of('chat.status');
  assert.equal(scheduled.state, 'resume_scheduled');
  assert.equal(scheduled.resetsAt, 9000);
  assert.equal(scheduled.projectPath, '/p');
});

test('an empty project path is refused rather than parked forever', () => {
  const h = harness();
  assert.equal(h.resumes.arm({ projectPath: '', resetsAt: 2000 }), false);
  assert.equal(h.resumes.arm({ resetsAt: 2000 }), false);
});
