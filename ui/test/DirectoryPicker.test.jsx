import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { DirectoryPicker } from '../src/components/DirectoryPicker.jsx';
import { ProjectSwitcher } from '../src/components/ProjectSwitcher.jsx';

const HOME = '/Users/me';

const res = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
const ok = (view) => res(200, view);

const entry = (name, over = {}) => ({ name, path: `${HOME}/${name}`, hasGit: false, added: false, ...over });

// Keyed by the `path` query the picker sends; `null` is the first request, which must carry none.
const serve = (responses) => {
  const fetchMock = vi.fn(async (url) => {
    const q = url.includes('?') ? new URL(url, 'http://x').searchParams.get('path') : null;
    const found = responses[q ?? '@no-path'];
    if (!found) throw Object.assign(new Error(`unexpected fetch: ${url}`), { status: 599 });
    return typeof found === 'function' ? found() : found;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const paths = (fetchMock) => fetchMock.mock.calls.map(([url]) => url);
const useBtn = () => screen.getByRole('button', { name: /use this folder/i });
const upBtn = () => screen.queryByRole('button', { name: /up one folder/i });

afterEach(() => { vi.unstubAllGlobals(); });

describe('DirectoryPicker — where it opens', () => {
  it('asks for no path at all on the first read, leaving home to the daemon', async () => {
    const fetchMock = serve({
      '@no-path': ok({ root: HOME, path: HOME, parent: null, entries: [entry('code')] }),
    });
    render(<DirectoryPicker onPick={vi.fn()} onClose={vi.fn()} />);

    await screen.findByRole('button', { name: /use this folder/i });
    expect(paths(fetchMock)).toEqual(['/api/fs/list']);
    expect(paths(fetchMock)[0]).not.toContain('?');
    expect(screen.getByTitle(HOME).textContent).toBe(HOME);
  });

  it('says it is reading before the first listing arrives', async () => {
    serve({ '@no-path': () => new Promise(() => {}) });
    render(<DirectoryPicker onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/reading the folder/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /use this folder/i })).toBe(null);
  });
});

describe('DirectoryPicker — moving around', () => {
  it('opens the entry that was clicked, asking for that entry own path', async () => {
    const fetchMock = serve({
      '@no-path': ok({ root: HOME, path: HOME, parent: null, entries: [entry('code'), entry('Documents')] }),
      [`${HOME}/code`]: ok({ root: HOME, path: `${HOME}/code`, parent: HOME, entries: [] }),
    });
    render(<DirectoryPicker onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^code$/ });

    fireEvent.click(screen.getByRole('button', { name: /^code$/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(paths(fetchMock)[1]).toBe(`/api/fs/list?path=${encodeURIComponent(`${HOME}/code`)}`);
    await waitFor(() => expect(screen.getByTitle(`${HOME}/code`).textContent).toBe(`${HOME}/code`));
  });

  it('hides the Up affordance at the ceiling', async () => {
    serve({ '@no-path': ok({ root: HOME, path: HOME, parent: null, entries: [entry('code')] }) });
    render(<DirectoryPicker onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^code$/ });
    expect(upBtn()).toBe(null);
  });

  it('offers Up below the ceiling and follows the parent the daemon reported', async () => {
    const fetchMock = serve({
      '@no-path': ok({ root: HOME, path: HOME, parent: null, entries: [entry('code')] }),
      [`${HOME}/code`]: ok({ root: HOME, path: `${HOME}/code`, parent: HOME, entries: [] }),
    });
    render(<DirectoryPicker onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^code$/ });
    fireEvent.click(screen.getByRole('button', { name: /^code$/ }));
    await waitFor(() => expect(upBtn()).not.toBe(null));

    fireEvent.click(upBtn());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(paths(fetchMock)[2]).toBe(`/api/fs/list?path=${encodeURIComponent(HOME)}`);
  });

  it('draws the trail as segments and jumps to the one that is clicked', async () => {
    const deep = `${HOME}/code/thing`;
    const fetchMock = serve({
      '@no-path': ok({ root: HOME, path: deep, parent: `${HOME}/code`, entries: [entry('src')] }),
      [`${HOME}/code`]: ok({ root: HOME, path: `${HOME}/code`, parent: HOME, entries: [] }),
      [HOME]: ok({ root: HOME, path: HOME, parent: null, entries: [] }),
    });
    render(<DirectoryPicker onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: 'Home' });

    // Home is labelled for what it is; the rest are the segments below it, in order.
    const crumbs = [...document.querySelectorAll('.picker-crumb')].map((b) => b.textContent);
    expect(crumbs).toEqual(['Home', 'code', 'thing']);

    fireEvent.click(screen.getByRole('button', { name: 'code' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(paths(fetchMock)[1]).toBe(`/api/fs/list?path=${encodeURIComponent(`${HOME}/code`)}`);

    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(paths(fetchMock)[2]).toBe(`/api/fs/list?path=${encodeURIComponent(HOME)}`);
  });

  // Two navigations in flight at once: the second answer is the one on screen, and the first must not
  // overwrite it when it finally lands.
  it('ignores a slow answer for a folder the user has already navigated away from', async () => {
    let releaseSlow;
    const slow = new Promise((r) => { releaseSlow = r; });
    serve({
      '@no-path': ok({ root: HOME, path: `${HOME}/code`, parent: HOME, entries: [entry('slow')] }),
      [`${HOME}/slow`]: () => slow.then(() => ok({ root: HOME, path: `${HOME}/slow`, parent: HOME, entries: [entry('stale-marker')] })),
      [HOME]: ok({ root: HOME, path: HOME, parent: null, entries: [entry('fresh-marker')] }),
    });
    render(<DirectoryPicker onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^slow$/ });

    fireEvent.click(screen.getByRole('button', { name: /^slow$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    await screen.findByRole('button', { name: /^fresh-marker$/ });

    await act(async () => { releaseSlow(); await slow; });
    expect(screen.getByTitle(HOME).textContent).toBe(HOME);
    expect(screen.queryByRole('button', { name: /^stale-marker$/ })).toBe(null);
    expect(screen.getByRole('button', { name: /^fresh-marker$/ })).toBeTruthy();
    expect(screen.queryByText(/reading the folder/i)).toBe(null);
  });
});

describe('DirectoryPicker — what the rows say', () => {
  it('badges only the entries that carry the marker', async () => {
    serve({
      '@no-path': ok({
        root: HOME,
        path: HOME,
        parent: null,
        entries: [
          entry('repo', { hasGit: true }),
          entry('plain'),
          entry('tracked', { added: true }),
          entry('both', { hasGit: true, added: true }),
        ],
      }),
    });
    render(<DirectoryPicker onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByText('repo');

    const rows = Object.fromEntries(
      screen.getAllByRole('listitem').map((li) => [li.querySelector('.picker-name').textContent, li]),
    );
    expect(within(rows.repo).getByText('git')).toBeTruthy();
    expect(within(rows.repo).queryByText('added')).toBe(null);
    expect(within(rows.plain).queryByText('git')).toBe(null);
    expect(within(rows.plain).queryByText('added')).toBe(null);
    expect(within(rows.tracked).getByText('added')).toBeTruthy();
    expect(within(rows.tracked).queryByText('git')).toBe(null);
    expect(within(rows.both).getByText('git')).toBeTruthy();
    expect(within(rows.both).getByText('added')).toBeTruthy();
    // Four rows, and only the marked ones carry badges.
    expect(document.querySelectorAll('.badge').length).toBe(4);
  });

  it('explains a folder with no sub-folders instead of showing a blank panel', async () => {
    serve({ '@no-path': ok({ root: HOME, path: HOME, parent: null, entries: [] }) });
    render(<DirectoryPicker onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /use this folder/i });

    expect(screen.getByText(/no folders to open/i)).toBeTruthy();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    // The way out of an empty folder has to stay on screen.
    expect(useBtn()).toBeTruthy();
  });
});

describe('DirectoryPicker — picking', () => {
  it('picks the folder being viewed, never an entry inside it', async () => {
    const onPick = vi.fn();
    serve({ '@no-path': ok({ root: HOME, path: HOME, parent: null, entries: [entry('code'), entry('Documents')] }) });
    render(<DirectoryPicker onPick={onPick} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^code$/ });

    fireEvent.click(useBtn());
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(HOME);
  });

  it('picks the folder it was navigated into', async () => {
    const onPick = vi.fn();
    serve({
      '@no-path': ok({ root: HOME, path: HOME, parent: null, entries: [entry('code')] }),
      [`${HOME}/code`]: ok({ root: HOME, path: `${HOME}/code`, parent: HOME, entries: [] }),
    });
    render(<DirectoryPicker onPick={onPick} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^code$/ });
    fireEvent.click(screen.getByRole('button', { name: /^code$/ }));
    await screen.findByText(/no folders to open/i);

    fireEvent.click(useBtn());
    expect(onPick).toHaveBeenCalledWith(`${HOME}/code`);
  });

  it('closes without picking anything', async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    serve({ '@no-path': ok({ root: HOME, path: HOME, parent: null, entries: [] }) });
    render(<DirectoryPicker onPick={onPick} onClose={onClose} />);
    await screen.findByRole('button', { name: /use this folder/i });

    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe('DirectoryPicker — rejected reads', () => {
  // The daemon answers 403 with `{ error: 'outside_home', root }`, and fetchJson now throws that code
  // with the body attached. The picker has to turn it into a sentence, not echo the code.
  it('explains a 403 as a folder above the ceiling', async () => {
    serve({
      '@no-path': ok({ root: HOME, path: HOME, parent: null, entries: [entry('escape')] }),
      [`${HOME}/escape`]: res(403, { error: 'outside_home', root: HOME }),
    });
    render(<DirectoryPicker onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^escape$/ });
    fireEvent.click(screen.getByRole('button', { name: /^escape$/ }));

    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toMatch(/outside your home folder/i);
    expect(notice.textContent).toContain(`${HOME}/escape`);
    expect(notice.textContent).not.toMatch(/outside_home/);
  });

  it('explains a 404 as a folder that is no longer there', async () => {
    serve({
      '@no-path': ok({ root: HOME, path: HOME, parent: null, entries: [entry('gone')] }),
      [`${HOME}/gone`]: res(404, { error: 'not_found', path: `${HOME}/gone` }),
    });
    render(<DirectoryPicker onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^gone$/ });
    fireEvent.click(screen.getByRole('button', { name: /^gone$/ }));

    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toMatch(/not there any more|no longer/i);
    expect(notice.textContent).toContain(`${HOME}/gone`);
    expect(notice.textContent).not.toMatch(/not_found/);
  });

  it('explains a 400 as a path that cannot be opened', async () => {
    serve({
      '@no-path': ok({ root: HOME, path: HOME, parent: null, entries: [entry('notes.txt')] }),
      [`${HOME}/notes.txt`]: res(400, { error: 'not_a_directory', path: `${HOME}/notes.txt` }),
    });
    render(<DirectoryPicker onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^notes\.txt$/ });
    fireEvent.click(screen.getByRole('button', { name: /^notes\.txt$/ }));

    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toMatch(/file rather than a folder|cannot be opened/i);
    expect(notice.textContent).not.toMatch(/not_a_directory/);
  });

  it('keeps the listing it already had, so there is still a way back', async () => {
    serve({
      '@no-path': ok({ root: HOME, path: HOME, parent: null, entries: [entry('gone'), entry('code')] }),
      [`${HOME}/gone`]: res(404, { error: 'not_found', path: `${HOME}/gone` }),
    });
    render(<DirectoryPicker onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^gone$/ });
    fireEvent.click(screen.getByRole('button', { name: /^gone$/ }));
    await screen.findByRole('alert');

    expect(screen.getByRole('button', { name: /^code$/ })).toBeTruthy();
    expect(screen.getByTitle(HOME).textContent).toBe(HOME);
    expect(useBtn()).toBeTruthy();
  });

  // A folder that failed once has to be reachable again: the failure may have been transient, and the
  // only other way back to it is closing the picker and starting over from Home.
  it('re-reads a folder when the entry that failed is clicked again', async () => {
    let broken = true;
    const fetchMock = serve({
      '@no-path': ok({ root: HOME, path: HOME, parent: null, entries: [entry('flaky')] }),
      [`${HOME}/flaky`]: () => (broken
        ? res(404, { error: 'not_found', path: `${HOME}/flaky` })
        : ok({ root: HOME, path: `${HOME}/flaky`, parent: HOME, entries: [] })),
    });
    render(<DirectoryPicker onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^flaky$/ });

    fireEvent.click(screen.getByRole('button', { name: /^flaky$/ }));
    await screen.findByRole('alert');

    broken = false;
    fireEvent.click(screen.getByRole('button', { name: /^flaky$/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByRole('alert')).toBe(null));
  });

  it('explains a 401 instead of showing "unauthorized"', async () => {
    serve({ '@no-path': { ok: false, status: 401, json: async () => ({}) } });
    render(<DirectoryPicker onPick={vi.fn()} onClose={vi.fn()} />);
    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toMatch(/agentpanel open/);
  });
});

describe('ProjectSwitcher + DirectoryPicker', () => {
  const openBrowser = async (onAdd) => {
    const fetchMock = serve({
      '@no-path': ok({ root: HOME, path: HOME, parent: null, entries: [entry('code')] }),
      [`${HOME}/code`]: ok({ root: HOME, path: `${HOME}/code`, parent: HOME, entries: [] }),
    });
    render(<ProjectSwitcher projects={[]} selected={null} onSelect={vi.fn()} onAdd={onAdd} error={null} />);
    fireEvent.click(screen.getByRole('button', { name: /add project/i }));
    fireEvent.click(screen.getByRole('button', { name: /browse/i }));
    await screen.findByRole('button', { name: /^code$/ });
    return fetchMock;
  };

  it('fills the path field and adds nothing until Add is pressed', async () => {
    const onAdd = vi.fn(async () => {});
    await openBrowser(onAdd);

    fireEvent.click(screen.getByRole('button', { name: /^code$/ }));
    await screen.findByText(/no folders to open/i);
    fireEvent.click(useBtn());

    const input = screen.getByLabelText(/absolute path/i);
    expect(input.value).toBe(`${HOME}/code`);
    // The whole point of filling the field rather than submitting: nothing has been added yet.
    expect(onAdd).not.toHaveBeenCalled();
    // And the picker gets out of the way once it has answered.
    expect(screen.queryByRole('button', { name: /use this folder/i })).toBe(null);
    expect(screen.getByRole('button', { name: /browse/i })).toBeTruthy();

    const add = screen.getByRole('button', { name: 'Add' });
    expect(add.disabled).toBe(false);
    await act(async () => { fireEvent.click(add); });
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith(`${HOME}/code`, { create: false });
  });

  it('closing the picker leaves the field alone and adds nothing', async () => {
    const onAdd = vi.fn(async () => {});
    await openBrowser(onAdd);

    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.getByLabelText(/absolute path/i).value).toBe('');
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Add' }).disabled).toBe(true);
  });

  it('sends a picked folder through the one path that explains a rejection', async () => {
    const onAdd = vi.fn(async () => {
      throw Object.assign(new Error('not_a_directory'), { status: 400, body: { path: `${HOME}/code` } });
    });
    await openBrowser(onAdd);

    fireEvent.click(useBtn());
    expect(screen.getByLabelText(/absolute path/i).value).toBe(HOME);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Add' })); });

    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toMatch(/it is a file, or a file is in the way/i);
    expect(notice.textContent).not.toMatch(/not_a_directory/);
    // Still on the form, still holding what the picker filled in.
    expect(screen.getByLabelText(/absolute path/i).value).toBe(HOME);
  });
});
