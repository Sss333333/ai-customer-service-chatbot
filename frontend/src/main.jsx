import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AgentConsole from './pages/AgentConsole';

const isAgentRoute =
  typeof window !== 'undefined' &&
  (window.location.pathname.startsWith('/agent') ||
    window.location.hash.startsWith('#/agent'));

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {isAgentRoute ? <AgentConsole /> : <App />}
  </StrictMode>
);
