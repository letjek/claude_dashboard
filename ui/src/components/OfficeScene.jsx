import { useEffect, useRef, useState } from 'react';
import { assignDesks } from './officeDesks.js';

const MAX_DESKS = 6;
// Matches the CSS `office-leave` keyframe duration — a sprite has to stay mounted for exactly as
// long as its walk-out animation runs, or the removal cuts the animation off mid-frame.
const EXIT_MS = 650;

// Six fixed centres in a 240x120 room, three across and two deep. Fixed rather than computed from
// the count so a desk never moves under whoever is already sitting at it.
const DESK_POS = [
  [48, 40], [120, 40], [192, 40],
  [48, 92], [120, 92], [192, 92],
];

// Centre of the door rect drawn at x=0 y=44 width=6 height=28 — where a sprite's walk animation
// starts from and returns to, whichever desk it was actually given.
const DOOR_POS = [3, 58];

const PALETTE = ['#5b8cff', '#4ade80', '#f87171', '#fbbf24', '#c084fc', '#38bdf8'];

// Deterministic, not random: the same agent type always gets the same colour, so a reload does not
// reshuffle who is who. It is purely decorative — never load-bearing the way a status colour is.
function colorFor(agentType) {
  let hash = 0;
  for (const ch of agentType) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

// Two nested groups, deliberately: the outer one carries the desk position as a plain SVG
// `transform` attribute and is never touched by CSS, because a CSS `transform` (including one set
// by an animation) on an SVG element replaces its attribute transform rather than composing with
// it — put both on the same node and the position is simply gone. The inner group owns the walk
// animation, moving locally between "at the door" (`--dx`/`--dy`, relative to this desk) and (0, 0).
function Sprite({ runId, agentType, deskIndex, leaving }) {
  const [deskX, deskY] = DESK_POS[deskIndex];
  const [doorX, doorY] = DOOR_POS;
  const style = { '--dx': `${doorX - deskX}px`, '--dy': `${doorY - deskY}px` };
  return (
    <g transform={`translate(${deskX} ${deskY})`}>
      <g className={`sprite${leaving ? ' leaving' : ''}`} data-run-id={runId} style={style}>
        <g className="sprite-body">
          <rect x={-6} y={-6} width={12} height={8} fill={colorFor(agentType)} />
          <rect x={-4} y={2} width={8} height={6} fill={colorFor(agentType)} opacity={0.7} />
        </g>
      </g>
    </g>
  );
}

// Pure aesthetic: a little office that agents visibly walk into while their run is live, and walk
// back out of the moment it stops — nothing here reflects state the list below does not already
// show. `officeDesks.assignDesks` does the actual seating logic; this component only owns the timer
// that keeps a just-finished sprite on screen long enough to finish its exit animation.
export function OfficeScene({ runs }) {
  const runningRuns = runs.filter((r) => r.status === 'running');
  const [assignments, setAssignments] = useState([]);
  const [leaving, setLeaving] = useState([]);
  const [overflow, setOverflow] = useState(0);
  const timers = useRef(new Map());

  // Keyed by the sorted set of running ids so the effect only reruns when who is running actually
  // changes, not on every unrelated re-render of the rail (a tick of `now`, a different run's
  // activity line updating).
  const key = runningRuns.map((r) => r.id).sort().join(',');

  useEffect(() => {
    setAssignments((prev) => {
      const result = assignDesks(prev, runningRuns, MAX_DESKS);
      setOverflow(result.overflow);
      if (result.left.length > 0) {
        setLeaving((prevLeaving) => [...prevLeaving, ...result.left]);
        for (const entry of result.left) {
          const timer = setTimeout(() => {
            setLeaving((prevLeaving) => prevLeaving.filter((e) => e.runId !== entry.runId));
            timers.current.delete(entry.runId);
          }, EXIT_MS);
          timers.current.set(entry.runId, timer);
        }
      }
      return result.assignments;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const inFlight = timers.current;
    return () => { for (const timer of inFlight.values()) clearTimeout(timer); };
  }, []);

  return (
    <div className="office" aria-hidden="true">
      <svg viewBox="0 0 240 120" className="office-scene">
        <rect x={0} y={0} width={240} height={120} rx={6} className="office-room" />
        <rect x={0} y={44} width={6} height={28} className="office-door" />
        {DESK_POS.map(([x, y], i) => (
          <rect key={i} x={x - 10} y={y + 6} width={20} height={10} rx={2} className="office-desk" />
        ))}
        {assignments.map((a) => <Sprite key={a.runId} {...a} />)}
        {leaving.map((a) => <Sprite key={a.runId} {...a} leaving />)}
        {/* The main session, not a subagent — never seated, never leaves. Its patrol is a fixed
            CSS loop (no per-instance position), so it can never suffer the attribute-vs-animation
            transform conflict a desk sprite could: there is no attribute transform to lose. */}
        <g className="orchestrator">
          <rect x={-7} y={-7} width={14} height={9} fill="var(--accent)" />
          <rect x={-5} y={2} width={10} height={7} fill="var(--accent)" opacity={0.75} />
        </g>
      </svg>
      {overflow > 0 && <span className="office-overflow">+{overflow}</span>}
    </div>
  );
}
