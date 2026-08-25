import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react';
import { AddAgentForm } from '../src/components/AddAgentForm.jsx';

const PROJECT = '/Users/me/proj';

// postJson reads the body before it looks at the status, so an error response has to carry one too.
const res = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });

const stub = (impl) => {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const draw = (over = {}) => {
  const props = { projectPath: null, onCreated: vi.fn(), onCancel: vi.fn(), ...over };
  const { container } = render(<AddAgentForm {...props} />);
  return { ...props, form: container.querySelector('form') };
};

const set = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submitBtn = () => screen.getByRole('button', { name: /create agent|creating/i });
const nameBox = () => screen.getByLabelText(/^name$/i);
const sent = (fetchMock, i = 0) => JSON.parse(fetchMock.mock.calls[i][1].body);

const fillValid = () => {
  set(/^name$/i, 'code-reviewer');
  set(/^description$/i, 'Reviews a diff and reports defects.');
  set(/^system prompt$/i, 'You review code. You do not write it.');
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('AddAgentForm — the name rule', () => {
  it('says nothing about a form nobody has touched, and refuses to submit it', () => {
    draw();
    expect(screen.queryByText(/is not lowercase kebab-case/)).toBe(null);
    expect(screen.queryByText('A name is required.')).toBe(null);
    expect(nameBox().getAttribute('aria-invalid')).toBe(null);
    expect(submitBtn().disabled).toBe(true);
  });

  it('asks for a name once the field has been visited and left empty', () => {
    draw();
    fireEvent.blur(nameBox());
    expect(screen.getByText('A name is required.')).toBeTruthy();
    expect(submitBtn().disabled).toBe(true);
  });

  for (const bad of ['My Agent', 'Foo_Bar', '../x', 'trailing-', 'double--hyphen', 'UPPER']) {
    it(`keeps submit disabled and names the rule for ${JSON.stringify(bad)}`, () => {
      draw();
      set(/^name$/i, bad);
      expect(submitBtn().disabled).toBe(true);
      const complaint = screen.getByText(/is not lowercase kebab-case/);
      // The complaint has to quote what was typed: with five inputs on screen, "invalid" names nothing.
      expect(complaint.textContent).toContain(bad);
      expect(nameBox().getAttribute('aria-invalid')).toBe('true');
      // And the rule itself stays on screen, not just the verdict.
      expect(screen.getByText(/letters and digits joined by single hyphens/i)).toBeTruthy();
    });
  }

  it('accepts lowercase kebab-case and enables submit', () => {
    draw();
    set(/^name$/i, 'code-reviewer-2');
    expect(screen.queryByText(/is not lowercase kebab-case/)).toBe(null);
    expect(submitBtn().disabled).toBe(false);
  });

  it('judges the trimmed name, not the whitespace around it', () => {
    draw();
    set(/^name$/i, '  code-reviewer  ');
    expect(submitBtn().disabled).toBe(false);
    expect(screen.queryByText(/is not lowercase kebab-case/)).toBe(null);
  });
});

describe('AddAgentForm — scope', () => {
  it('disables the project scope and says why when there is no project', () => {
    draw({ projectPath: null });
    const project = screen.getByRole('radio', { name: /project/i });
    expect(project.disabled).toBe(true);
    expect(screen.getByRole('radio', { name: /user/i }).checked).toBe(true);
    expect(screen.getByText(/Choose a project first/)).toBeTruthy();
  });

  it('enables the project scope and shows the folder it would write into', () => {
    draw({ projectPath: PROJECT });
    const project = screen.getByRole('radio', { name: /project/i });
    expect(project.disabled).toBe(false);
    expect(screen.queryByText(/Choose a project first/)).toBe(null);
    expect(screen.getByText(`${PROJECT}/.claude/agents`)).toBeTruthy();
  });
});

describe('AddAgentForm — a successful create', () => {
  it('posts exactly the documented body for user scope, omitting a blank tools list', async () => {
    const fetchMock = stub(async () => res(201, { agent: { name: 'code-reviewer', scope: 'user' } }));
    const { form } = draw();
    fillValid();
    await act(async () => { fireEvent.submit(form); });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/catalog/agents');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(sent(fetchMock)).toEqual({
      scope: 'user',
      name: 'code-reviewer',
      description: 'Reviews a diff and reports defects.',
      prompt: 'You review code. You do not write it.',
    });
    // Blank means "every tool". An empty array would mean an agent that can do nothing, so the key
    // must be absent rather than present-and-empty.
    expect('tools' in sent(fetchMock)).toBe(false);
    expect('model' in sent(fetchMock)).toBe(false);
    expect('projectPath' in sent(fetchMock)).toBe(false);
  });

  it('carries projectPath and the optional fields when project scope is chosen', async () => {
    const fetchMock = stub(async () => res(201, { agent: { name: 'code-reviewer' } }));
    const { form } = draw({ projectPath: PROJECT });
    fireEvent.click(screen.getByRole('radio', { name: /project/i }));
    fillValid();
    set(/^model$/i, ' opus ');
    set(/^tools$/i, 'Read, Grep , ,Glob');
    await act(async () => { fireEvent.submit(form); });

    expect(sent(fetchMock)).toEqual({
      scope: 'project',
      projectPath: PROJECT,
      name: 'code-reviewer',
      description: 'Reviews a diff and reports defects.',
      prompt: 'You review code. You do not write it.',
      model: 'opus',
      tools: ['Read', 'Grep', 'Glob'],
    });
  });

  it('hands onCreated the record the daemon returned, and clears the form', async () => {
    const agent = { name: 'code-reviewer', scope: 'user', path: '/Users/me/.claude/agents/code-reviewer.md' };
    stub(async () => res(201, { agent }));
    const { form, onCreated } = draw();
    fillValid();
    await act(async () => { fireEvent.submit(form); });

    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith(agent);
    expect(nameBox().value).toBe('');
    expect(screen.getByLabelText(/^description$/i).value).toBe('');
    expect(screen.getByLabelText(/^system prompt$/i).value).toBe('');
    expect(screen.queryByRole('alert')).toBe(null);
  });
});

describe('AddAgentForm — rejections', () => {
  it('names the file a 409 collided with, and leaves the form usable', async () => {
    const path = '/Users/me/.claude/agents/code-reviewer.md';
    const fetchMock = stub(async () => res(409, { error: 'exists', path }));
    const { form, onCreated } = draw();
    fillValid();
    await act(async () => { fireEvent.submit(form); });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(path);
    expect(alert.textContent).toContain('code-reviewer');
    // The obvious guess about a form that comes back with an error is that it half-saved something.
    expect(alert.textContent).toMatch(/nothing was written/i);
    expect(alert.textContent).not.toMatch(/\bexists\b\)/);
    expect(onCreated).not.toHaveBeenCalled();

    // Not wedged: still enabled, still labelled Create, still holding what was typed.
    expect(submitBtn().disabled).toBe(false);
    expect(submitBtn().textContent).toMatch(/create agent/i);
    expect(nameBox().value).toBe('code-reviewer');

    fetchMock.mockResolvedValue(res(201, { agent: { name: 'code-reviewer-2' } }));
    set(/^name$/i, 'code-reviewer-2');
    await act(async () => { fireEvent.submit(form); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBe(null);
  });

  it('repeats the detail of a write_failed rather than the bare code', async () => {
    stub(async () => res(500, { error: 'write_failed', detail: 'EACCES: permission denied, open ...' }));
    const { form } = draw();
    fillValid();
    await act(async () => { fireEvent.submit(form); });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('EACCES: permission denied');
    expect(alert.textContent).not.toMatch(/write_failed/);
    expect(submitBtn().disabled).toBe(false);
  });

  it('turns each 400 code into a sentence that names the field at fault', async () => {
    const cases = [
      [{ error: 'bad_name' }, /lowercase kebab-case/i],
      [{ error: 'bad_scope' }, /Choose user or project/i],
      [{ error: 'bad_project' }, /no longer a folder/i],
      [{ error: 'empty_description' }, /description is empty/i],
      [{ error: 'empty_body' }, /system prompt is empty/i],
    ];
    for (const [payload, sentence] of cases) {
      stub(async () => res(400, payload));
      const { form } = draw();
      fillValid();
      await act(async () => { fireEvent.submit(form); });
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toMatch(sentence);
      expect(alert.textContent).not.toContain(payload.error);
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it('explains a 401 instead of showing "unauthorized"', async () => {
    stub(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    const { form } = draw();
    fillValid();
    await act(async () => { fireEvent.submit(form); });
    expect(screen.getByRole('alert').textContent).toMatch(/agentpanel open/);
  });
});

describe('AddAgentForm — a request in flight', () => {
  it('disables submit while pending and cannot be sent twice', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const fetchMock = stub(async () => { await gate; return res(201, { agent: { name: 'code-reviewer' } }); });
    const { form, onCreated } = draw();
    fillValid();

    await act(async () => { fireEvent.submit(form); });
    expect(submitBtn().disabled).toBe(true);
    expect(submitBtn().textContent).toMatch(/creating/i);

    // The disabled button is one guard; submitting the form directly (Enter in a text field, a second
    // synthetic submit) has to hit the pending guard inside the handler too.
    await act(async () => { fireEvent.submit(form); });
    await act(async () => { fireEvent.click(submitBtn()); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => { release(); await gate; });
    await waitFor(() => expect(submitBtn().textContent).toMatch(/create agent/i));
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-enables after a failure so the same name can be retried', async () => {
    let reject;
    const gate = new Promise((_, r) => { reject = r; });
    const fetchMock = stub(async () => { await gate; });
    const { form } = draw();
    fillValid();
    await act(async () => { fireEvent.submit(form); });
    expect(submitBtn().disabled).toBe(true);

    await act(async () => { reject(new Error('network down')); await gate.catch(() => {}); });
    await waitFor(() => expect(submitBtn().disabled).toBe(false));
    expect(screen.getByRole('alert').textContent).toMatch(/could not create the agent/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
