// Inline SVG rather than an icon package: one shape costs no dependency and no request, and drawing
// it in `currentColor` means the button's own hover, focus and disabled rules keep applying without a
// second set of icon styles. Every icon is `aria-hidden` — the button's text is the accessible name,
// and announcing "plus" alongside "Add agent" only repeats it.

export function PlusIcon({ className = 'icon' }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 3.25v9.5M3.25 8h9.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

export function AttachIcon({ className = 'icon' }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M11.25 5.5 6 10.75a1.77 1.77 0 0 1-2.5-2.5l5.25-5.25a2.83 2.83 0 0 1 4 4L7.5 12.25a1.06 1.06 0 0 1-1.5-1.5L10.25 6.5"
        fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}
