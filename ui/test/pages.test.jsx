import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { Agents } from '../src/pages/Agents.jsx';
import { Skills } from '../src/pages/Skills.jsx';
import { Activity } from '../src/pages/Activity.jsx';

const agents = [
  { kind: 'agent', name: 'reviewer', description: 'Reviews code.', tools: 'Read, Grep', model: 'opus', scope: 'user', source: null },
  { kind: 'agent', name: 'plugin-agent', description: 'From a plugin.', tools: null, model: null, scope: 'plugin', source: 'superpowers' },
];

const skills = [
  { kind: 'skill', name: 'brainstorming', description: 'Turns ideas into designs.', scope: 'plugin', source: 'superpowers', version: '6.3.0' },
];

describe('Agents page', () => {
  it('lists each agent with its scope badge', () => {
    render(<Agents agents={agents} />);
    expect(screen.getByText('reviewer')).toBeTruthy();
    expect(screen.getByText('user')).toBeTruthy();
    expect(screen.getByText('plugin')).toBeTruthy();
  });

  it('shows the plugin source when there is one', () => {
    render(<Agents agents={agents} />);
    expect(screen.getByText(/superpowers/)).toBeTruthy();
  });

  it('names the empty state', () => {
    render(<Agents agents={[]} />);
    expect(screen.getByText(/no agents found/i)).toBeTruthy();
  });

  it('does not render a blank tools row for an empty tools array', () => {
    render(<Agents agents={[{ kind: 'agent', name: 'no-tools', description: 'd', tools: [], model: null, scope: 'user', source: null }]} />);
    expect(screen.queryByText('tools')).toBeNull();
  });

  // The button was `btn subtle` — muted text, no border, no fill — which on the dark panel reads as
  // a caption rather than as the page's one action. The class and the icon are what say otherwise,
  // so both are asserted rather than only the label.
  it('offers a filled, icon-bearing button for writing an agent', () => {
    render(<Agents agents={agents} />);
    const button = screen.getByRole('button', { name: 'Add agent' });
    expect(button.className).toMatch(/accent/);
    expect(button.querySelector('svg')).toBeTruthy();
  });

  it('reports a load failure instead of implying the catalog is empty', () => {
    render(<Agents agents={[]} catalogError="request_failed_500" />);
    expect(screen.getByText(/could not load/i)).toBeTruthy();
    expect(screen.queryByText(/no agents found/i)).toBeNull();
  });

  it('keeps showing a previously loaded list when a later refresh fails', () => {
    render(<Agents agents={agents} catalogError="request_failed_500" />);
    expect(screen.getByText('reviewer')).toBeTruthy();
    expect(screen.queryByText(/could not load/i)).toBeNull();
    expect(screen.getByText(/could not refresh/i)).toBeTruthy();
  });

  describe('editing a writable agent', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('turns a user- or project-scoped card into an edit form when clicked', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ prompt: 'x' }) })));
      render(<Agents agents={agents} />);
      fireEvent.click(screen.getByRole('button', { name: /edit reviewer/i }));
      expect(await screen.findByRole('heading', { name: /edit agent/i })).toBeTruthy();
      // The other card is untouched.
      expect(screen.getByText('plugin-agent')).toBeTruthy();
    });

    it('offers no edit affordance for a plugin-scoped agent', () => {
      render(<Agents agents={agents} />);
      expect(screen.queryByRole('button', { name: /edit plugin-agent/i })).toBeNull();
    });

    it('cancelling the edit form restores the card', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ prompt: 'x' }) })));
      render(<Agents agents={agents} />);
      fireEvent.click(screen.getByRole('button', { name: /edit reviewer/i }));
      await screen.findByRole('heading', { name: /edit agent/i });
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
      expect(screen.queryByRole('heading', { name: /edit agent/i })).toBeNull();
      expect(screen.getByRole('button', { name: /edit reviewer/i })).toBeTruthy();
    });
  });
});

describe('Skills page', () => {
  it('offers a filled, icon-bearing button for writing a skill', () => {
    render(<Skills skills={skills} />);
    const button = screen.getByRole('button', { name: 'Add skill' });
    expect(button.className).toMatch(/accent/);
    expect(button.querySelector('svg')).toBeTruthy();
  });

  it('shows the plugin version', () => {
    render(<Skills skills={skills} />);
    expect(screen.getByText(/6\.3\.0/)).toBeTruthy();
  });

  it('filters by the search term', async () => {
    render(<Skills skills={[...skills, { kind: 'skill', name: 'zzz-other', description: '', scope: 'user', source: null, version: null }]} initialQuery="brain" />);
    expect(screen.queryByText('zzz-other')).toBeNull();
    expect(screen.getByText('brainstorming')).toBeTruthy();
  });

  it('names a genuinely empty catalog rather than implying a search happened', () => {
    render(<Skills skills={[]} />);
    expect(screen.getByText(/no skills found/i)).toBeTruthy();
  });

  it('distinguishes no search matches from a genuinely empty catalog', () => {
    render(<Skills skills={skills} initialQuery="zzz-nonexistent" />);
    expect(screen.getByText(/no skills match/i)).toBeTruthy();
    expect(screen.queryByText(/no skills found/i)).toBeNull();
  });

  it('reports a load failure instead of implying no skills exist', () => {
    render(<Skills skills={[]} catalogError="request_failed_500" />);
    expect(screen.getByText(/could not load/i)).toBeTruthy();
    expect(screen.queryByText(/no skills found/i)).toBeNull();
  });

  it('keeps showing a previously loaded list when a later refresh fails', () => {
    render(<Skills skills={skills} catalogError="request_failed_500" />);
    expect(screen.getByText('brainstorming')).toBeTruthy();
    expect(screen.queryByText(/could not load/i)).toBeNull();
    expect(screen.getByText(/could not refresh/i)).toBeTruthy();
  });
});

describe('Activity page', () => {
  it('renders finished runs with their duration', () => {
    render(<Activity runs={[{ id: 'a', agentType: 'qa', description: 'tests', status: 'done', startedAt: 0, durationMs: 5000 }]} />);
    expect(screen.getByText('qa')).toBeTruthy();
    expect(screen.getByText('5s')).toBeTruthy();
  });

  it('tells the user when hooks are not installed rather than showing an empty list', () => {
    render(<Activity runs={[]} hooksInstalled={false} />);
    expect(screen.getByText(/agentpanel init/)).toBeTruthy();
  });

  it('recovers once the health check reports hooks are installed after mount', () => {
    const { rerender } = render(<Activity runs={[]} hooksInstalled={false} />);
    expect(screen.getByText(/agentpanel init/)).toBeTruthy();

    rerender(<Activity runs={[]} hooksInstalled={true} />);
    expect(screen.queryByText(/agentpanel init/)).toBeNull();
    expect(screen.getByText(/no agent runs recorded yet/i)).toBeTruthy();
  });
});
