import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import './demo.css';
import { App } from '../App';
import { CodeBrowser, Deploy } from './Screens';

// Read-only preview of the real UI over embedded FIXTURE / DEMO audits, plus the source browser.
if (!window.location.hash) window.location.hash = '#/';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App extra={[{ path: 'code', label: 'Source code', render: () => <CodeBrowser /> }, { path: 'deploy', label: 'Deploy', render: () => <Deploy /> }]} />
  </StrictMode>,
);
