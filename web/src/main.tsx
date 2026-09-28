import { createRoot } from 'react-dom/client';
import { App } from './App';
import './mockup.css';
import './app.css';
import './themes';

createRoot(document.getElementById('root')!).render(<App />);
