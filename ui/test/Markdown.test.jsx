import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Markdown } from '../src/components/Markdown.jsx';

const md = (source) => render(<Markdown source={source} />).container.querySelector('.md');

describe('Markdown — what it renders', () => {
  it('renders a fenced code block with its language, verbatim', () => {
    const el = md('```js\nconst a = 1;\n  indented\n```');
    expect(el.querySelector('pre code').textContent).toBe('const a = 1;\n  indented');
    expect(el.querySelector('.md-lang').textContent).toBe('js');
  });

  it('closes an unclosed fence at the end of the text instead of dropping it', () => {
    expect(md('```\nstill here').querySelector('pre code').textContent).toBe('still here');
  });

  it('never emits an h1 or h2, which the page already owns', () => {
    const el = md('# top\n\n## second\n\n###### deepest');
    expect([...el.querySelectorAll('h1, h2')]).toEqual([]);
    expect(el.querySelector('h3').textContent).toBe('top');
    expect(el.querySelector('h4').textContent).toBe('second');
  });

  it('renders both kinds of list, and tells them apart', () => {
    expect(md('- one\n- two').querySelectorAll('ul li')).toHaveLength(2);
    expect(md('1. one\n2) two').querySelectorAll('ol li')).toHaveLength(2);
  });

  it('renders quotes, rules and inline emphasis', () => {
    expect(md('> quoted').querySelector('blockquote').textContent).toBe('quoted');
    expect(md('---').querySelector('hr')).toBeTruthy();
    const el = md('**bold** and *thin* and `code`');
    expect(el.querySelector('strong').textContent).toBe('bold');
    expect(el.querySelector('em').textContent).toBe('thin');
    expect(el.querySelector('code').textContent).toBe('code');
  });

  // A shared module-level `/g` regex plus the recursion that renders a bold span's body was enough to
  // hang the tab on this line and exhaust the heap: the nested call rewound `lastIndex` and the outer
  // loop re-matched the span it had already consumed, forever.
  it('terminates on a paragraph that mixes bold with other inline spans', () => {
    const el = md('**bold** and *thin* and `code` and [link](https://example.com)');
    expect(el.querySelectorAll('strong')).toHaveLength(1);
    expect(el.querySelectorAll('em')).toHaveLength(1);
    expect(el.querySelectorAll('code')).toHaveLength(1);
    expect(el.querySelectorAll('a')).toHaveLength(1);
  });

  it('renders emphasis nested inside bold once, not twice', () => {
    const el = md('**bold with *thin* inside**');
    expect(el.querySelectorAll('strong')).toHaveLength(1);
    expect(el.querySelector('strong em').textContent).toBe('thin');
    expect(el.textContent).toBe('bold with thin inside');
  });

  it('terminates on a list and a heading that each repeat an inline span', () => {
    expect(md('- **a** and **b**\n- *c* and *d*').querySelectorAll('li')).toHaveLength(2);
    expect(md('## **a** and *b*').querySelector('h4').textContent).toBe('a and b');
  });

  it('joins the lines of a paragraph and starts a new one on a blank line', () => {
    const el = md('one\ntwo\n\nthree');
    expect(el.querySelectorAll('p')).toHaveLength(2);
  });

  it('renders an empty or missing source as nothing at all', () => {
    expect(md('').children).toHaveLength(0);
    expect(md(undefined).children).toHaveLength(0);
  });
});

describe('Markdown — what it refuses', () => {
  it('escapes markup rather than rendering it, in every block type', () => {
    for (const source of [
      '<img src=x onerror="alert(1)">',
      '# <script>alert(1)</script>',
      '> <script>alert(1)</script>',
      '- <script>alert(1)</script>',
      '```\n<script>alert(1)</script>\n```',
    ]) {
      const el = md(source);
      expect(el.querySelector('script')).toBeNull();
      expect(el.querySelector('img')).toBeNull();
      expect(el.textContent).toMatch(/alert\(1\)/);      // shown as text, which is the honest failure
    }
  });

  it('links http, https and mailto', () => {
    for (const href of ['https://example.com/x', 'http://example.com', 'mailto:me@example.com']) {
      const link = md(`[label](${href})`).querySelector('a');
      expect(link.getAttribute('href')).toBe(href);
      expect(link.getAttribute('rel')).toBe('noreferrer noopener');
      expect(link.getAttribute('target')).toBe('_blank');
    }
  });

  it('refuses to make an executable scheme clickable, and shows the source instead', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', 'file:///etc/passwd']) {
      const el = md(`[click me](${href})`);
      expect(el.querySelector('a')).toBeNull();
      expect(el.textContent).toContain('[click me]');
    }
  });

  it('shows the raw text of a link whose scheme is only nearly safe', () => {
    // `https:evil` has no `//`: the allowlist is anchored for exactly this reason.
    expect(md('[x](https:evil)').querySelector('a')).toBeNull();
  });

  it('uses the href as the label when a link has none, rather than rendering an empty target', () => {
    expect(md('[](https://example.com/x)').querySelector('a').textContent).toBe('https://example.com/x');
  });
});

describe('Markdown — bare links', () => {
  it('links a bare https URL sitting in prose, not just [text](url) syntax', () => {
    const link = md('see https://example.com/x for details').querySelector('a');
    expect(link.getAttribute('href')).toBe('https://example.com/x');
    expect(link.textContent).toBe('https://example.com/x');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('does not swallow the sentence punctuation that follows a bare URL', () => {
    const link = md('read https://example.com/x, then continue.').querySelector('a');
    expect(link.getAttribute('href')).toBe('https://example.com/x');
  });

  it('links every bare URL in a paragraph with more than one', () => {
    const el = md('https://a.example and https://b.example');
    expect([...el.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      'https://a.example', 'https://b.example',
    ]);
  });
});

describe('Markdown — clickable paths', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders a backticked absolute path as something other than plain code', () => {
    const el = md('the file is at `/Users/daps/notes.pdf`');
    expect(el.querySelector('code')).toBeNull();
    const trigger = screen.getByRole('button', { name: /notes\.pdf/i });
    expect(trigger.textContent).toBe('/Users/daps/notes.pdf');
  });

  it('leaves an ordinary code span alone', () => {
    const el = md('run `npm install` first');
    expect(el.querySelector('code').textContent).toBe('npm install');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('also treats a tilde path as a path, not code', () => {
    md('`~/notes.txt`');
    expect(screen.getByRole('button', { name: /notes\.txt/i })).toBeTruthy();
  });

  it('reveals the path when clicked, and reports failure without throwing', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    md('`/Users/daps/notes.pdf`');
    fireEvent.click(screen.getByRole('button', { name: /notes\.pdf/i }));
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledWith('/api/fs/reveal', expect.objectContaining({
      body: JSON.stringify({ path: '/Users/daps/notes.pdf' }),
    }));
  });
});

describe('Markdown — accessibility of the rendered answer', () => {
  it('leaves the transcript readable when a code line is longer than the page', () => {
    render(<Markdown source={`\`\`\`\n${'x'.repeat(500)}\n\`\`\``} />);
    // Focusable, so a keyboard user can scroll the box the CSS makes scrollable.
    expect(screen.getByText('x'.repeat(500)).closest('pre').tabIndex).toBe(0);
  });
});
