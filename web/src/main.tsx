import { createRoot } from 'react-dom/client';
import { App } from './App';
import { BrowserWindowPage } from './components/TaskBrowser';
import './mockup.css';
import './app.css';
import './themes';

// /?browser=<task id>: the window that Pop out opens for a task browser (TaskBrowser.tsx)
createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).get('browser') ? <BrowserWindowPage /> : <App />);
