import { useRoute } from '../router.jsx';

const NAV = [
  { path: '/', label: 'Chat' },
  { path: '/agents', label: 'Agents' },
  { path: '/skills', label: 'Skills' },
  { path: '/activity', label: 'Activity' },
];

export function Layout({ rail, sidebar, children, officeExpanded = false }) {
  const { path, navigate } = useRoute();

  return (
    // The chat column collapses to zero width when the office is expanded — the page still has its
    // nav, so this is a wider look at the rail rather than a mode you have to escape from.
    <div className={`shell${officeExpanded ? ' office-expanded' : ''}`}>
      <nav aria-label="Sections">
        <h1>agentpanel</h1>
        <ul>
          {NAV.map((item) => (
            <li key={item.path}>
              <a href={item.path}
                 aria-current={path === item.path ? 'page' : undefined}
                 onClick={(e) => { e.preventDefault(); navigate(item.path); }}>
                {item.label}
              </a>
            </li>
          ))}
        </ul>
        {sidebar}
      </nav>
      <main>{children}</main>
      {rail}
    </div>
  );
}
