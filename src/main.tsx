import { createRoot } from 'react-dom/client';
// Only the app's own stylesheet loads here. The embed's is Mog-specific and is
// loaded by the Mog adapter instead, so a missing or changed
// @mog-sdk/spreadsheet-app cannot take down startup before the shell can fall
// back to the unavailable adapter and say what went wrong.
import './styles.css';
import { App } from './App';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

// Deliberately not wrapped in StrictMode: its double-invoke would create two
// spreadsheet runtimes (each loading the 41 MB compute-core wasm) per open.
createRoot(container).render(<App />);
