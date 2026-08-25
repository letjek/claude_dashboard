import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, cleanup } from '@testing-library/react';
import { AddSkillForm } from '../src/components/AddSkillForm.jsx';

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
  const { container } = render(<AddSkillForm {...props} />);
  return { ...props, form: container.querySelector('form') };
};

const set = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submitBtn = () => screen.getByRole('button', { name: /create skill|creating/i });
const nameBox = () => screen.getByLabelText(/^name$/i);
const sent = (fetchMock, i = 0) => JSON.parse(fetchMock.mock.calls[i][1].body);

const fillValid = () => {
  set(/^name$/i, 'release-checklist');
  set(/^description$/i, 'Runs the release checklist before a tag is cut.');
  set(/^instructions$/i, '## Steps\n\n1. Run the tests.');
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('AddSkillForm — the name rule', () => {
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

  for (const bad of ['My Skill', 'Foo_Bar', '../x', '-leading', 'release checklist', 'UPPER']) {
    it(`keeps submit disabled and names the rule for ${JSON.stringify(bad)}`, () => {
      draw();
      set(/^name$/i, bad);
      expect(submitBtn().disabled).toBe(true);
      const complaint = screen.getByText(/is not lowercase kebab-case/);
      expect(complaint.textContent).toContain(bad);
      expect(nameBox().getAttribute('aria-invalid')).toBe('true');
      expect(screen.getByText(/letters and digits joined by single hyphens/i)).toBeTruthy();
    });
  }

  it('accepts lowercase kebab-case and enables submit', () => {
    draw();
    set(/^name$/i, 'release-checklist');
    expect(screen.queryByText(/is not lowercase kebab-case/)).toBe(null);
    expect(submitBtn().disabled).toBe(false);
  });

  it('judges the trimmed name, not the whitespace around it', () => {
    draw();
    set(/^name$/i, '  release-checklist  ');
    expect(submitBtn().disabled).toBe(false);
    expect(screen.queryByText(/is not lowercase kebab-case/)).toBe(null);
  });
});

describe('AddSkillForm — scope', () => {
  it('disables the project scope and says why when there is no project', () => {
    draw({ projectPath: null });
    expect(screen.getByRole('radio', { name: /project/i }).disabled).toBe(true);
    expect(screen.getByRole('radio', { name: /user/i }).checked).toBe(true);
    expect(screen.getByText(/Choose a project first/)).toBeTruthy();
  });

  it('enables the project scope and shows the folder it would write into', () => {
    draw({ projectPath: PROJECT });
    expect(screen.getByRole('radio', { name: /project/i }).disabled).toBe(false);
    expect(screen.queryByText(/Choose a project first/)).toBe(null);
    expect(screen.getByText(`${PROJECT}/.claude/skills`)).toBeTruthy();
  });
});

describe('AddSkillForm — a successful create', () => {
  it('posts exactly the documented body for user scope', async () => {
    const fetchMock = stub(async () => res(201, { skill: { name: 'release-checklist' } }));
    const { form } = draw();
    fillValid();
    await act(async () => { fireEvent.submit(form); });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/catalog/skills');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(sent(fetchMock)).toEqual({
      scope: 'user',
      name: 'release-checklist',
      description: 'Runs the release checklist before a tag is cut.',
      body: '## Steps\n\n1. Run the tests.',
    });
    // No project scope chosen means no projectPath key at all — not null, not ''.
    expect('projectPath' in sent(fetchMock)).toBe(false);
  });

  it('carries projectPath when project scope is chosen', async () => {
    const fetchMock = stub(async () => res(201, { skill: { name: 'release-checklist' } }));
    const { form } = draw({ projectPath: PROJECT });
    fireEvent.click(screen.getByRole('radio', { name: /project/i }));
    fillValid();
    await act(async () => { fireEvent.submit(form); });

    expect(sent(fetchMock)).toEqual({
      scope: 'project',
      projectPath: PROJECT,
      name: 'release-checklist',
      description: 'Runs the release checklist before a tag is cut.',
      body: '## Steps\n\n1. Run the tests.',
    });
  });

  it('sends an empty instructions body as an empty string rather than dropping the key', async () => {
    const fetchMock = stub(async () => res(400, { error: 'empty_body' }));
    const { form } = draw();
    set(/^name$/i, 'release-checklist');
    set(/^description$/i, 'Runs the release checklist.');
    await act(async () => { fireEvent.submit(form); });
    const payload = sent(fetchMock);
    expect('body' in payload).toBe(true);
    expect(payload.body).toBe('');
  });

  it('hands onCreated the record the daemon returned, and clears the form', async () => {
    const skill = { name: 'release-checklist', scope: 'user', path: '/Users/me/.claude/skills/release-checklist/SKILL.md' };
    stub(async () => res(201, { skill }));
    const { form, onCreated } = draw();
    fillValid();
    await act(async () => { fireEvent.submit(form); });

    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith(skill);
    expect(nameBox().value).toBe('');
    expect(screen.getByLabelText(/^description$/i).value).toBe('');
    expect(screen.getByLabelText(/^instructions$/i).value).toBe('');
    expect(screen.queryByRole('alert')).toBe(null);
  });
});

describe('AddSkillForm — rejections', () => {
  it('names the folder a 409 collided with, and leaves the form usable', async () => {
    const path = '/Users/me/.claude/skills/release-checklist';
    const fetchMock = stub(async () => res(409, { error: 'exists', path }));
    const { form, onCreated } = draw();
    fillValid();
    await act(async () => { fireEvent.submit(form); });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(path);
    expect(alert.textContent).toContain('release-checklist');
    expect(alert.textContent).toMatch(/nothing was written/i);
    expect(onCreated).not.toHaveBeenCalled();

    expect(submitBtn().disabled).toBe(false);
    expect(submitBtn().textContent).toMatch(/create skill/i);
    expect(nameBox().value).toBe('release-checklist');

    fetchMock.mockResolvedValue(res(201, { skill: { name: 'release-checklist-2' } }));
    set(/^name$/i, 'release-checklist-2');
    await act(async () => { fireEvent.submit(form); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBe(null);
  });

  it('repeats the detail of a write_failed rather than the bare code', async () => {
    stub(async () => res(500, { error: 'write_failed', detail: 'EROFS: read-only file system' }));
    const { form } = draw();
    fillValid();
    await act(async () => { fireEvent.submit(form); });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('EROFS: read-only file system');
    expect(alert.textContent).not.toMatch(/write_failed/);
    expect(submitBtn().disabled).toBe(false);
  });

  it('turns each 400 code into a sentence that names the field at fault', async () => {
    const cases = [
      [{ error: 'bad_name' }, /lowercase kebab-case/i],
      [{ error: 'bad_scope' }, /Choose user or project/i],
      [{ error: 'bad_project' }, /no longer a folder/i],
      [{ error: 'empty_description' }, /description is empty/i],
      [{ error: 'empty_body' }, /instructions are empty/i],
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

describe('AddSkillForm — a request in flight', () => {
  it('disables submit while pending and cannot be sent twice', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const fetchMock = stub(async () => { await gate; return res(201, { skill: { name: 'release-checklist' } }); });
    const { form, onCreated } = draw();
    fillValid();

    await act(async () => { fireEvent.submit(form); });
    expect(submitBtn().disabled).toBe(true);
    expect(submitBtn().textContent).toMatch(/creating/i);

    await act(async () => { fireEvent.submit(form); });
    await act(async () => { fireEvent.click(submitBtn()); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => { release(); await gate; });
    await waitFor(() => expect(submitBtn().textContent).toMatch(/create skill/i));
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
    expect(screen.getByRole('alert').textContent).toMatch(/could not create the skill/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
