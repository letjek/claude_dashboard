import { describe, it, expect } from 'vitest';
import { assignDesks } from '../src/components/officeDesks.js';

const run = (id, agentType = 'programmer') => ({ id, agentType });

describe('assignDesks', () => {
  it('seats every running run at its own desk, starting from desk 0', () => {
    const { assignments, overflow, left } = assignDesks([], [run('a'), run('b')]);
    expect(assignments).toEqual([
      { runId: 'a', agentType: 'programmer', deskIndex: 0 },
      { runId: 'b', agentType: 'programmer', deskIndex: 1 },
    ]);
    expect(overflow).toBe(0);
    expect(left).toEqual([]);
  });

  it('keeps a still-running run at the same desk across calls', () => {
    const first = assignDesks([], [run('a'), run('b')]);
    const second = assignDesks(first.assignments, [run('a'), run('b')]);
    expect(second.assignments).toEqual(first.assignments);
  });

  it('reports a run that stopped running as left, and frees its desk for a newcomer', () => {
    const first = assignDesks([], [run('a'), run('b')]);
    const second = assignDesks(first.assignments, [run('a'), run('c')]);
    expect(second.left).toEqual([{ runId: 'b', agentType: 'programmer', deskIndex: 1 }]);
    // b's desk (1) is free again, since only a's desk (0) is still occupied.
    expect(second.assignments).toContainEqual({ runId: 'c', agentType: 'programmer', deskIndex: 1 });
  });

  it('caps seating at maxDesks and reports the rest as overflow', () => {
    const { assignments, overflow } = assignDesks([], [run('a'), run('b'), run('c')], 2);
    expect(assignments).toHaveLength(2);
    expect(overflow).toBe(1);
  });

  it('an empty running list leaves nobody seated and reports everyone previously seated as left', () => {
    const first = assignDesks([], [run('a')]);
    const second = assignDesks(first.assignments, []);
    expect(second.assignments).toEqual([]);
    expect(second.left).toEqual([{ runId: 'a', agentType: 'programmer', deskIndex: 0 }]);
  });
});
