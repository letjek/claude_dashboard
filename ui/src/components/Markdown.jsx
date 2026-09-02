// A deliberately small markdown renderer that emits React elements and never HTML.
//
// The alternative was `dangerouslySetInnerHTML` plus a sanitiser, or a dependency. Neither is worth
// it here: this text is model output rendered inside a dashboard that can approve shell commands, so
// the one property worth guaranteeing is that no string in a message can ever become markup. React
// escapes every text node it renders, so that property holds by construction rather than by the
// correctness of a sanitiser's allowlist.
//
// Supported, because it is what assistant answers actually contain: fenced code, headings, ordered
// and unordered lists, blockquotes, horizontal rules, paragraphs, and inline code, bold, italic and
// links. Anything else renders as its own literal text, which is the honest failure mode.

import { revealPath } from '../api.js';

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

// A backticked path is the one thing this codebase already writes unambiguously — the composer's
// own drop and attach handlers wrap every path in backticks for exactly this reason (dropPaths.js).
// Detecting one only inside a code span, never in bare prose, is what keeps "24/7" or "and/or" from
// being mistaken for a filesystem path.
const ABS_PATH = /^(?:\/|~\/)\S+$/;

// Trailing sentence punctuation is excluded from the match itself (`(?<![.,;:!?)])`) rather than
// trimmed off afterwards, so a URL at the end of a sentence does not swallow the full stop into its
// href.
const INLINE_SOURCE = '(`+)([\\s\\S]*?)\\1|\\*\\*([\\s\\S]+?)\\*\\*|__([\\s\\S]+?)__|\\*([^*\\n]+?)\\*|_([^_\\n]+?)_|\\[([^\\]\\n]*)\\]\\(([^)\\s]+)\\)|(https?:\\/\\/[^\\s<>"\']+(?<![.,;:!?)]))';

// A click on the reveal button, not a navigation — the daemon already runs Read and Bash as this
// user, so pointing its own file manager at one of their files is nothing new. Fire-and-forget:
// nothing in the transcript needs to reflect the outcome, and a rejected reveal must not become an
// unhandled promise rejection.
function PathChip({ path }) {
  return (
    <button type="button" className="path-chip" onClick={() => { revealPath(path).catch(() => {}); }}>
      {path}
    </button>
  );
}

function inline(text, keyPrefix = '') {
  const nodes = [];
  let last = 0;
  let match;
  // A fresh regex per call, not one shared module-level `/g`. `inline` recurses to render the body of
  // a bold or italic span, and a shared regex carries one `lastIndex` for every level: the nested call
  // rewinds it, the outer loop then re-matches the span it just consumed, and the loop never ends.
  // `**bold** and *thin*` was enough to hang the tab and exhaust memory.
  const pattern = new RegExp(INLINE_SOURCE, 'g');
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const key = `${keyPrefix}${match.index}`;
    const [, , code, strongStar, strongUnder, emStar, emUnder, linkText, href, bareUrl] = match;
    if (code !== undefined) {
      nodes.push(ABS_PATH.test(code) ? <PathChip key={key} path={code} /> : <code key={key}>{code}</code>);
    } else if (strongStar !== undefined || strongUnder !== undefined) {
      nodes.push(<strong key={key}>{inline(strongStar ?? strongUnder, `${key}s`)}</strong>);
    } else if (emStar !== undefined || emUnder !== undefined) {
      nodes.push(<em key={key}>{inline(emStar ?? emUnder, `${key}e`)}</em>);
    } else if (bareUrl !== undefined) {
      nodes.push(<a key={key} href={bareUrl} target="_blank" rel="noreferrer noopener">{bareUrl}</a>);
    } else if (href !== undefined) {
      // A `javascript:` or `data:` href is rendered as plain text rather than a link. Nothing in a
      // model's answer justifies handing the user a clickable scheme that executes.
      nodes.push(SAFE_HREF.test(href)
        ? <a key={key} href={href} target="_blank" rel="noreferrer noopener">{linkText || href}</a>
        : `[${linkText}](${href})`);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function parse(source) {
  const lines = String(source ?? '').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = /^\s*(```|~~~)(.*)$/.exec(line);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2].trim();
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) { body.push(lines[i]); i += 1; }
      i += 1;                                   // the closing fence, or the end of an unclosed one
      blocks.push({ type: 'code', lang, text: body.join('\n') });
      continue;
    }

    if (line.trim() === '') { i += 1; continue; }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { blocks.push({ type: 'hr' }); i += 1; continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      i += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
      blocks.push({ type: 'quote', text: body.join('\n') });
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = numbered !== null && bullet === null;
      const pattern = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
      const items = [];
      while (i < lines.length) {
        const item = pattern.exec(lines[i]);
        if (!item) break;
        items.push(item[1]);
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const body = [];
    while (i < lines.length && lines[i].trim() !== ''
           && !/^\s*(```|~~~)/.test(lines[i]) && !/^(#{1,6})\s+/.test(lines[i])
           && !/^\s*>\s?/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i])) {
      body.push(lines[i]);
      i += 1;
    }
    if (body.length === 0) { i += 1; continue; }
    blocks.push({ type: 'paragraph', text: body.join('\n') });
  }

  return blocks;
}

export function Markdown({ source }) {
  const blocks = parse(source);
  return (
    <div className="md">
      {blocks.map((block, index) => {
        const key = `b${index}`;
        switch (block.type) {
          case 'code':
            // Code scrolls inside its own box. A long line here must never widen the transcript and
            // push the page into a horizontal scroll of its own.
            return (
              <pre key={key} className="md-code" tabIndex={0}>
                {block.lang && <span className="md-lang">{block.lang}</span>}
                <code>{block.text}</code>
              </pre>
            );
          case 'hr':
            return <hr key={key} />;
          case 'heading': {
            const Tag = `h${Math.min(block.level + 2, 6)}`;   // the page already owns h1/h2
            return <Tag key={key}>{inline(block.text, key)}</Tag>;
          }
          case 'quote':
            return <blockquote key={key}>{inline(block.text, key)}</blockquote>;
          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul';
            return (
              <Tag key={key}>
                {block.items.map((item, n) => <li key={`${key}i${n}`}>{inline(item, `${key}i${n}`)}</li>)}
              </Tag>
            );
          }
          default:
            return <p key={key}>{inline(block.text, key)}</p>;
        }
      })}
    </div>
  );
}
