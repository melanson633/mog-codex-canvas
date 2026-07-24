import { createRoot } from 'react-dom/client';
import '@mog-sdk/spreadsheet-app/styles.css';
import './styles.css';
import { App } from './App';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

// Deliberately not wrapped in StrictMode: its double-invoke would create two
// spreadsheet runtimes (each loading the 41 MB compute-core wasm) per open.
createRoot(container).render(<App />);
