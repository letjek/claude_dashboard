import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Layout } from '../src/components/Layout.jsx';

// useRoute reads a module-level store keyed off window.location, so no provider is needed.
const shell = (props) => render(
  <Layout rail={<aside>rail</aside>} sidebar={<div>sidebar</div>} {...props}>page</Layout>,
).container.querySelector('.shell');

// The whole of the expand feature on this side is one class name, and a typo in it fails silently:
// the button would still press, the state would still flip, and nothing on screen would move. This
// pins the name the stylesheet actually keys the collapsed chat column off.
describe('Layout', () => {
  it('lays out three columns normally', () => {
    expect(shell({}).className).toBe('shell');
  });

  it('marks the shell so the chat column can collapse for the expanded office', () => {
    expect(shell({ officeExpanded: true }).className).toBe('shell office-expanded');
  });

  it('keeps rendering the page and the nav while expanded — this is a wider look, not a mode', () => {
    const expanded = shell({ officeExpanded: true });
    expect(expanded.querySelector('nav')).toBeTruthy();
    expect(expanded.querySelector('main').textContent).toBe('page');
  });
});
