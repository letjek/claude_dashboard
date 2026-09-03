import { describe, it, expect } from 'vitest';
import {
  COOLER_SPOT,
  DESK_SEATS,
  DOOR_SPOT,
  LANE,
  ORCHESTRATOR_ID,
  PANTRY_SPOT,
  createWorld,
  route,
  syncActors,
  tick,
} from '../src/components/officeWorld.js';

// A seeded generator, not Math.random: every branch in the simulation is a coin flip, and a test
// over a real random source can only assert things that are true of every seed — which is almost
// nothing. Two different multipliers give two visibly different offices to run the same assertions
// against.
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const running = (id, agentType = 'programmer') => ({ id, status: 'running', agentType });

// Runs the world forward, collecting a sample of every actor state seen on the way. dt is fixed at
// the same 100ms OfficeScene ticks at, so what the test measures is what the user sees.
function simulate(world, ms, rng, { dt = 100 } = {}) {
  const seen = [];
  let current = world;
  for (let elapsed = 0; elapsed < ms; elapsed += dt) {
    current = tick(current, dt, rng);
    for (const a of current.actors) seen.push({ id: a.id, state: a.state, x: a.x, y: a.y, next: a.next });
  }
  return { world: current, seen };
}

const workers = (world) => world.actors.filter((a) => a.role === 'worker');
const at = (a, [x, y]) => Math.round(a.x) === x && Math.round(a.y) === y;

describe('route', () => {
  it('goes via the aisle rather than straight through the furniture', () => {
    const [backSeat, frontSeat] = [DESK_SEATS[0], DESK_SEATS[5]];
    expect(route(backSeat[0], backSeat[1], frontSeat[0], frontSeat[1]))
      .toEqual([[backSeat[0], LANE], [frontSeat[0], LANE], frontSeat]);
  });

  it('drops legs that would not move it, so standing in the aisle is not a walk to itself', () => {
    expect(route(80, LANE, 140, LANE)).toEqual([[140, LANE]]);
    const [sx, sy] = DESK_SEATS[0];
    expect(route(sx, LANE, sx, sy)).toEqual([[sx, sy]]);
  });
});

describe('syncActors', () => {
  it('brings a summoned agent in through the door rather than materialising it at a desk', () => {
    const world = syncActors(createWorld(), [running('a')], { rng: seeded(1) });
    const [a] = workers(world);
    expect(at(a, DOOR_SPOT)).toBe(true);
    expect(a.state).toBe('walking');
  });

  it('walks a summoned agent from the door to its own desk and sits it down', () => {
    const rng = seeded(7);
    const world = syncActors(createWorld(), [running('a')], { rng });
    const { world: after } = simulate(world, 20000, rng);
    const [a] = workers(after);
    // Desk 0 is the only desk on offer, so this is the seat it must have reached — nothing else in
    // the room is a legal resting place for a worker.
    expect(a.deskIndex).toBe(0);
    expect(at(a, DESK_SEATS[0])).toBe(true);
  });

  it('sends an agent whose run stopped out through the door, then removes it', () => {
    const rng = seeded(3);
    let world = syncActors(createWorld(), [running('a')], { rng });
    ({ world } = simulate(world, 8000, rng));
    world = syncActors(world, [], { rng });

    const [leaving] = workers(world);
    expect(leaving.state).toBe('leaving');

    const { world: after, seen } = simulate(world, 20000, rng);
    expect(workers(after)).toHaveLength(0);
    // Removed at the doorway, not wherever it happened to be standing: a sprite that vanishes from
    // its chair never reads as having left.
    // The removal happens on the tick it reaches the door, so the last frame anyone could have seen
    // is the one just short of it — within a single tick's travel, not back at the desk.
    const lastSighting = seen.filter((s) => s.id === 'a').pop();
    expect(Math.hypot(lastSighting.x - DOOR_SPOT[0], lastSighting.y - DOOR_SPOT[1])).toBeLessThan(4);
  });

  // The "it vanished and then walked back in" bug. A leaving actor was pushed through unchanged when
  // its run turned out to be wanted again, so it carried on to the door and was removed — while
  // `wanted.delete` had already stopped a fresh one being spawned in its place. The run was then
  // running with no sprite at all, until some unrelated change re-ran the sync and spawned it at the
  // door, which is the walking back in.
  it('turns an agent around when its run comes back before it reached the door', () => {
    const rng = seeded(101);
    let world = syncActors(createWorld(), [running('a')], { rng });
    ({ world } = simulate(world, 15000, rng));
    const desk = workers(world)[0].deskIndex;

    world = syncActors(world, [], { rng });
    expect(workers(world)[0].state).toBe('leaving');

    world = syncActors(world, [running('a')], { rng });
    const [back] = workers(world);
    expect(back.state).not.toBe('leaving');
    expect(back.deskIndex).toBe(desk);

    // And it actually arrives, rather than walking out anyway or being removed at the door. Checked
    // over the whole window rather than at the end: once seated it is free to go for coffee again,
    // so the final frame is not required to be at the desk — reaching it at all is the point.
    const { world: after, seen } = simulate(world, 20000, rng);
    expect(workers(after)).toHaveLength(1);
    expect(workers(after)[0].state).not.toBe('leaving');
    expect(seen.some((s) => s.id === 'a' && at(s, DESK_SEATS[desk]))).toBe(true);
  });

  it('turns it around without a walk when motion is not wanted', () => {
    const rng = seeded(102);
    let world = syncActors(createWorld(), [running('a')], { rng, instant: true });
    // A leaving actor cannot exist under instant sync, so this is the mixed case: the tab was
    // animating, the user turned reduced motion on, and the run came back mid-exit.
    world = syncActors(world, [], { rng });
    world = syncActors(world, [running('a')], { rng, instant: true });
    const [back] = workers(world);
    expect(back.state).toBe('working');
    expect(at(back, DESK_SEATS[back.deskIndex])).toBe(true);
  });

  it('keeps an occupied desk with its occupant when someone else is summoned', () => {
    const rng = seeded(11);
    let world = syncActors(createWorld(), [running('a')], { rng });
    ({ world } = simulate(world, 15000, rng));
    const deskBefore = workers(world).find((w) => w.id === 'a').deskIndex;

    world = syncActors(world, [running('a'), running('b')], { rng });
    expect(workers(world).find((w) => w.id === 'a').deskIndex).toBe(deskBefore);
    expect(workers(world).find((w) => w.id === 'b').deskIndex).not.toBe(deskBefore);
  });

  it('caps the room at six regardless of how many are running', () => {
    const runs = Array.from({ length: 9 }, (_, i) => running(`r${i}`));
    const world = syncActors(createWorld(), runs, { rng: seeded(5) });
    expect(workers(world)).toHaveLength(6);
  });

  it('seats everyone at once and removes them at once when motion is not wanted', () => {
    const rng = seeded(2);
    let world = syncActors(createWorld(), [running('a')], { rng, instant: true });
    const [a] = workers(world);
    expect(a.state).toBe('working');
    expect(at(a, DESK_SEATS[a.deskIndex])).toBe(true);

    // No tick will ever run under reduced motion, so a walk-out would leave the sprite parked at the
    // door forever. It has to be gone the moment its run is.
    world = syncActors(world, [], { rng, instant: true });
    expect(workers(world)).toHaveLength(0);
  });
});

describe('worker behaviour', () => {
  for (const seed of [13, 99]) {
    it(`visits the pantry and comes back to its own desk (seed ${seed})`, () => {
      const rng = seeded(seed);
      const runs = Array.from({ length: 4 }, (_, i) => running(`r${i}`));
      const world = syncActors(createWorld(), runs, { rng });
      const { world: after, seen } = simulate(world, 400000, rng);

      const coffee = seen.filter((s) => s.id !== ORCHESTRATOR_ID && s.state === 'coffee');
      expect(coffee.length).toBeGreaterThan(0);
      // Standing where the counter is drawn, not merely in a state called "coffee".
      expect(coffee.every((s) => at(s, PANTRY_SPOT))).toBe(true);

      // Everyone is back at a desk of their own by the end, and no two share one.
      const seats = workers(after).map((w) => w.deskIndex);
      expect(new Set(seats).size).toBe(seats.length);
      for (const w of workers(after)) {
        if (w.state === 'working') expect(at(w, DESK_SEATS[w.deskIndex])).toBe(true);
      }
    });
  }

  it('uses the water cooler and takes breaks at its desk too', () => {
    const rng = seeded(21);
    const runs = Array.from({ length: 5 }, (_, i) => running(`r${i}`));
    const { seen } = simulate(syncActors(createWorld(), runs, { rng }), 600000, rng);

    const cooler = seen.filter((s) => s.state === 'cooler');
    expect(cooler.length).toBeGreaterThan(0);
    expect(cooler.every((s) => at(s, COOLER_SPOT))).toBe(true);
    expect(seen.some((s) => s.state === 'stretching')).toBe(true);
  });

  it('pairs two agents up when one goes over to chat', () => {
    const rng = seeded(37);
    const runs = Array.from({ length: 6 }, (_, i) => running(`r${i}`));
    let world = syncActors(createWorld(), runs, { rng });

    let paired = false;
    for (let elapsed = 0; elapsed < 600000 && !paired; elapsed += 100) {
      world = tick(world, 100, rng);
      const chatting = world.actors.filter((a) => a.state === 'chatting');
      // A chat is two people. One sprite in a `chatting` state on its own is a sprite talking to
      // itself, which is the bug this pins.
      if (chatting.length >= 2) {
        paired = chatting.some((a) => chatting.some((b) => b.id !== a.id && b.partner === a.id && a.partner === b.id));
      }
    }
    expect(paired).toBe(true);
  });

  it('spends most of its time at the desk, not in the pantry', () => {
    const rng = seeded(64);
    const runs = Array.from({ length: 6 }, (_, i) => running(`r${i}`));
    const { seen } = simulate(syncActors(createWorld(), runs, { rng }), 600000, rng);

    const workerFrames = seen.filter((s) => s.id !== ORCHESTRATOR_ID);
    const atDesk = workerFrames.filter((s) => s.state === 'working').length;
    // The whole point of the weighting: this is an office with a coffee machine, not a coffee shop
    // with some desks. Anything at or below half and the room stops reading as work.
    expect(atDesk / workerFrames.length).toBeGreaterThan(0.55);
  });
});

describe('the orchestrator', () => {
  it('is always present and never takes a desk', () => {
    const runs = Array.from({ length: 9 }, (_, i) => running(`r${i}`));
    const world = syncActors(createWorld(), runs, { rng: seeded(4) });
    expect(world.actors.filter((a) => a.id === ORCHESTRATOR_ID)).toHaveLength(1);
    expect(workers(world)).toHaveLength(6);
  });

  it('stands still sometimes instead of looping forever', () => {
    const rng = seeded(8);
    const { seen } = simulate(createWorld(), 120000, rng);
    const frames = seen.filter((s) => s.id === ORCHESTRATOR_ID);
    const still = frames.filter((s) => s.state === 'idle').length;
    expect(still).toBeGreaterThan(0);
    expect(still).toBeLessThan(frames.length);
  });

  it('does not walk the same fixed circuit every time', () => {
    // Two seeds, two different sets of places it stopped. A fixed patrol would give identical sets
    // however the dice fell, which is exactly the monotony this replaced.
    const stops = (seed) => {
      const rng = seeded(seed);
      const { seen } = simulate(createWorld(), 200000, rng);
      return new Set(seen
        .filter((s) => s.id === ORCHESTRATOR_ID && s.state === 'idle')
        .map((s) => `${Math.round(s.x)},${Math.round(s.y)}`));
    };
    const a = stops(8);
    const b = stops(500);
    expect(a.size).toBeGreaterThan(1);
    expect([...a].join('|')).not.toBe([...b].join('|'));
  });
});
