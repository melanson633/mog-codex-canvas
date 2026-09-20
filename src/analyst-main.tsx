import React from 'react';
import { createRoot } from 'react-dom/client';
import { ParallelWorkbench } from './ParallelWorkbench';
import './analyst.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><ParallelWorkbench /></React.StrictMode>);
