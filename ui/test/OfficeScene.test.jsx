import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { OfficeScene } from '../src/components/OfficeScene.jsx';

const running = (id, agentType = 'programmer') => ({ id, status: 'running', agentType });
const done = (id, agentType = 'programmer') => ({ id, status: 'done', agentType });

afterEach(() => {
  vi.useRealTimers();
});

describe('OfficeScene', () => {
  it('always draws six desks, occupied or not', () => {
    const { container } = render(<OfficeScene runs={[]} />);
    expect(container.querySelectorAll('.office-desk')).toHaveLength(6);
    expect(container.querySelectorAll('.sprite')).toHaveLength(0);
  });

  it('seats a running run at a desk', () => {
    const { container } = render(<OfficeScene runs={[running('a')]} />);
    const sprites = container.querySelectorAll('.sprite');
    expect(sprites).toHaveLength(1);
    expect(sprites[0].getAttribute('data-run-id')).toBe('a');
  });

  it('ignores a run that is not running', () => {
    const { container } = render(<OfficeScene runs={[done('a')]} />);
    expect(container.querySelectorAll('.sprite')).toHaveLength(0);
  });

  it('keeps a sprite visible and marked leaving for a moment after its run stops, then removes it', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<OfficeScene runs={[running('a')]} />);
    rerender(<OfficeScene runs={[done('a')]} />);

    const leaving = container.querySelector('.sprite.leaving');
    expect(leaving).toBeTruthy();
    expect(leaving.getAttribute('data-run-id')).toBe('a');

    act(() => { vi.advanceTimersByTime(1000); });
    expect(container.querySelectorAll('.sprite')).toHaveLength(0);
  });

  // A regression test for a real bug: the desk position was an SVG `transform` attribute on the
  // very element that also carried a CSS `animation` touching `transform`. In SVG, a CSS transform
  // on an element replaces its presentation-attribute transform outright rather than composing with
  // it — so every sprite snapped to (0,0), the top-left of the scene, no matter which desk it held.
  // The fix keeps positioning (the attribute, static) and animation (CSS, local to (0,0)) on
  // separate elements; this test pins that split so it cannot silently come back together.
  it('positions a sprite via an ancestor\'s transform attribute, never the animated element\'s own', () => {
    const { container } = render(<OfficeScene runs={[running('a')]} />);
    const sprite = container.querySelector('.sprite[data-run-id="a"]');
    expect(sprite.getAttribute('transform')).toBe(null);
    const seat = sprite.closest('[transform]');
    expect(seat).toBeTruthy();
    expect(seat).not.toBe(sprite);
    expect(seat.getAttribute('transform')).toBe('translate(48 40)');
  });

  it('animates toward the door it walked in from, not a fixed direction', () => {
    const { container } = render(<OfficeScene runs={[running('a', 'programmer'), running('b', 'programmer')]} />);
    const first = container.querySelector('.sprite[data-run-id="a"]');
    const second = container.querySelector('.sprite[data-run-id="b"]');
    // Desk 0 and desk 1 sit at different offsets from the door, so walking "home" to the door means
    // a different vector for each — identical vectors would mean the door was never accounted for.
    expect(first.style.getPropertyValue('--dx')).not.toBe(second.style.getPropertyValue('--dx'));
  });

  it('caps seating at six and shows the rest as an overflow badge', () => {
    const runs = Array.from({ length: 8 }, (_, i) => running(`r${i}`));
    const { container } = render(<OfficeScene runs={runs} />);
    expect(container.querySelectorAll('.sprite')).toHaveLength(6);
    expect(container.querySelector('.office-overflow').textContent).toBe('+2');
  });

  describe('the orchestrator', () => {
    it('is always on screen, whether or not anyone else is working', () => {
      const { container } = render(<OfficeScene runs={[]} />);
      expect(container.querySelectorAll('.orchestrator')).toHaveLength(1);
    });

    it('is not one of the seated agents and never counts toward the desk cap', () => {
      const runs = Array.from({ length: 8 }, (_, i) => running(`r${i}`));
      const { container } = render(<OfficeScene runs={runs} />);
      expect(container.querySelectorAll('.orchestrator')).toHaveLength(1);
      expect(container.querySelectorAll('.sprite')).toHaveLength(6);
      expect(container.querySelector('.office-overflow').textContent).toBe('+2');
    });

    it('has no seat position of its own to lose to a CSS transform', () => {
      // Same bug class as the desk sprites: if it ever gained a positional attribute alongside a
      // CSS animation touching `transform`, it would freeze the same way. It never should — it has
      // no desk, so there is no position for a CSS transform to clobber.
      const { container } = render(<OfficeScene runs={[]} />);
      expect(container.querySelector('.orchestrator').getAttribute('transform')).toBe(null);
    });
  });
});
