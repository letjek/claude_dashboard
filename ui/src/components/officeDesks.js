// Pure, framework-free desk assignment for the office scene — kept dependency-free from React so
// the "who gets which desk, who just left" logic is testable on its own, the same reasoning as
// runList.js. A run keeps its desk for as long as it keeps running, so its sprite never jumps around
// mid-animation; a desk is only handed to someone new once its previous occupant is gone.
export function assignDesks(previous, runningRuns, maxDesks = 6) {
  const stillRunning = new Set(runningRuns.map((r) => r.id));
  const kept = previous.filter((a) => stillRunning.has(a.runId));
  const usedDesks = new Set(kept.map((a) => a.deskIndex));
  const keptIds = new Set(kept.map((a) => a.runId));
  const incoming = runningRuns.filter((r) => !keptIds.has(r.id));

  const assignments = [...kept];
  for (const run of incoming) {
    if (assignments.length >= maxDesks) break;
    let desk = 0;
    while (usedDesks.has(desk)) desk++;
    usedDesks.add(desk);
    assignments.push({ runId: run.id, agentType: run.agentType ?? 'unknown', deskIndex: desk });
  }

  const left = previous.filter((a) => !stillRunning.has(a.runId));
  const overflow = Math.max(0, runningRuns.length - assignments.length);
  return { assignments, left, overflow };
}
