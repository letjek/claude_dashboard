import { useEffect, useRef } from 'react';
import { TranscriptItem, StreamingMessage } from '../components/MessageItem.jsx';
import { Composer } from '../components/Composer.jsx';
import { SessionFooter } from '../components/SessionFooter.jsx';
import { formatElapsed } from '../components/RunRow.jsx';
import { rateLimitStop, streamingBuffers } from '../components/chatState.js';

const ACTIVITY_TEXT = {
  task_started: (d) => `dispatching ${d?.subagentType ?? 'a subagent'}${d?.description ? ` — ${d.description}` : ''}`,
  task_progress: (d) => `${d?.subagentType ?? 'subagent'} working${d?.lastToolName ? ` — ${d.lastToolName}` : ''}`,
  task_notification: (d) => `${d?.subagentType ?? 'subagent'} ${d?.status ?? 'reported'}`,
  tool_progress: (d) => `${d?.toolName ?? 'tool'} running${typeof d?.elapsedSeconds === 'number' ? ` ${Math.round(d.elapsedSeconds)}s` : ''}`,
  status: (d) => (typeof d?.status?.message === 'string' ? d.status.message : 'working'),
};

function activityLine(activity) {
  if (!activity) return null;
  const build = ACTIVITY_TEXT[activity.kind];
  return build ? build(activity.data) : null;
}

// The SDK's own names for the window that ran out, spelled the way a person would say them. An
// unknown type is printed as it arrived rather than swallowed: a limit nobody has a phrase for is
// still the limit the user hit.
const LIMIT_LABEL = {
  five_hour: 'the five-hour limit',
  seven_day: 'the seven-day limit',
  seven_day_opus: 'the seven-day Opus limit',
  seven_day_sonnet: 'the seven-day Sonnet limit',
  seven_day_overage_included: 'the seven-day limit, overage included',
  overage: 'the overage allowance',
};

// A manual resume is an ordinary message: `POST /api/chat` is the only way to start a session, and
// the wording matches the one the daemon sends on its own automatic attempt so the transcript reads
// the same whoever it was that continued the conversation.
const RESUME_TEXT = 'Continue where you left off. The previous turn stopped because the rate limit ran out.';

// A reset later today is a time; one that crosses midnight has to carry its date, or "resets at
// 09:00" reads as this morning.
function resetClock(resetsAt, now) {
  const at = new Date(resetsAt);
  return new Date(now).toDateString() === at.toDateString()
    ? at.toLocaleTimeString()
    : at.toLocaleString();
}

/**
 * Above the composer whenever this project's session died on the rate limit, and gone the moment it
 * is alive again. The Resume button sends `RESUME_TEXT` through the ordinary send path, so its busy
 * flag is the session's own — there is no local "resuming" state here that could outlive a failed
 * request and leave the banner stuck.
 */
function RateLimitBanner({ stop, now, busy, onResume }) {
  const waiting = stop.resetsAt !== null && stop.resetsAt > now;
  const armed = stop.resume === 'scheduled' && waiting;
  const limit = stop.rateLimitType === null ? null : LIMIT_LABEL[stop.rateLimitType] ?? stop.rateLimitType;

  return (
    <div className="notice rate-limit" role="status">
      <p>
        This project&apos;s session stopped because the rate limit ran out
        {limit ? ` — ${limit}` : ''}.{' '}
        {stop.resetsAt === null
          ? 'Nothing was reported about when it lifts.'
          : `It ${waiting ? 'lifts' : 'lifted'} at ${resetClock(stop.resetsAt, now)}.`}
      </p>
      {armed
        ? (
          <p>
            One automatic attempt is armed: it will be sent on its own in{' '}
            <span className="mono">{formatElapsed(stop.resetsAt - now)}</span>. Sending anything
            yourself before then calls it off.
          </p>
        )
        : (
          <>
            <p>
              {stop.resume === 'resuming'
                ? 'The one automatic attempt is being sent now.'
                : waiting
                  ? 'Resuming before the limit lifts will most likely fail again.'
                  : 'Nothing more will happen on its own — continuing is your call.'}
            </p>
            {/* Offered even while the automatic attempt is in flight: that attempt can fail, and a
                banner that hides its only control until it does is a banner that hangs. */}
            <button type="button" className="btn primary" onClick={onResume} disabled={busy}>
              {busy ? 'Resuming…' : 'Resume'}
            </button>
          </>
        )}
    </div>
  );
}

export function Chat({ session, runs, now, catalog = null }) {
  const { chat, selected, busy, historyError, permissionNotice, dismissPermissionNotice } = session;
  const scrollerRef = useRef(null);
  const pinnedRef = useRef(true);
  const buffers = streamingBuffers(chat);

  // Follow the conversation only while the user is already at the bottom. Yanking the view down
  // while they are reading something further up is the single most irritating thing a chat log can
  // do, and a streaming answer would do it several times a second.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [chat.items, buffers.length, chat.streams]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  const activity = busy ? activityLine(chat.activity) : null;
  const disabledReason = selected === null
    ? 'Choose a project in the sidebar before sending a message.'
    : null;
  const stop = rateLimitStop(chat);

  // `send` reports its own failure into the transcript and clears the busy flag in a `finally`, so
  // there is nothing to recover from here — only the returned promise to keep from escaping as an
  // unhandled rejection if it ever throws before it gets that far.
  const onResume = () => { Promise.resolve(session.send(RESUME_TEXT)).catch(() => {}); };

  return (
    <div className="chat">
      {permissionNotice && (
        <p className="notice" role="status">
          {permissionNotice}
          <button type="button" className="btn subtle" onClick={dismissPermissionNotice}>Dismiss</button>
        </p>
      )}
      {historyError && (
        <p className="notice" role="status">
          Could not load this project&apos;s history ({historyError}). Anything below is only what has
          arrived since this page opened.
        </p>
      )}

      {/* role="log" announces each completed message once. The streaming buffer below is hidden from
          assistive technology on purpose: announcing a partial answer several times a second is
          noise, and the finished message that replaces it is announced in full. */}
      <div className="transcript" ref={scrollerRef} onScroll={onScroll} role="log" aria-label="Conversation" aria-busy={busy}>
        {chat.items.length === 0 && buffers.length === 0
          ? (
            selected === null
              ? <p className="empty">Pick a project in the sidebar, or add one, and the conversation for it appears here.</p>
              : (
                <p className="empty">
                  Nothing in this conversation yet. Send a message to start one — Claude runs in{' '}
                  <span className="mono">{selected}</span> with your own agents, skills and CLAUDE.md loaded,
                  and any tool call that needs approval pauses here for you to answer.
                </p>
              )
          )
          : chat.items.map((item) => (
            <TranscriptItem key={item.key} item={item} state={chat} runs={runs} now={now} />
          ))}

        {buffers.map((buffer) => (
          <div key={buffer.branch} aria-hidden="true"><StreamingMessage buffer={buffer} /></div>
        ))}

        {busy && (
          <p className="activity-line" aria-hidden="true">
            <span className="dot running" />
            {activity ?? 'working'}
          </p>
        )}
      </div>

      {/* Between the transcript and the composer: this is about what the next message will do, and
          it belongs where the user is about to type rather than scrolled away up the log. */}
      {stop && <RateLimitBanner stop={stop} now={now} busy={busy} onResume={onResume} />}

      <Composer
        busy={busy}
        disabledReason={disabledReason}
        projectPath={selected}
        // The same catalog the Agents and Skills pages render, reused as the composer's @ list: the
        // orchestrator can only dispatch what is actually installed.
        catalog={catalog}
        onSend={session.send}
        onInterrupt={session.interrupt}
        onReset={session.reset}
      />
      <SessionFooter state={chat} />
    </div>
  );
}
