import React from 'react';
import { createRoot } from 'react-dom/client';
import { AnalystWorkspace } from './AnalystWorkspace';
import './analyst.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><AnalystWorkspace /></React.StrictMode>);
