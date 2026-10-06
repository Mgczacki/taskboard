import { createRoot } from 'react-dom/client';
import { App } from './App';
import { BrowserWindowPage } from './components/TaskBrowser';
import { DocumentWindowPage } from './components/DocumentWindow';
import './mockup.css';
import './app.css';
import './themes';

// /?browser=<task id> and /?document=<file URL> show pop-out windows with the shared drag header.
const page = new URLSearchParams(location.search);
createRoot(document.getElementById('root')!).render(page.has('browser') ? <BrowserWindowPage /> : page.has('document') ? <DocumentWindowPage /> : <App />);
