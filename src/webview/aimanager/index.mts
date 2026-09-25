// React bootstrap for the AI Manager webview.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';

function main() {
  const root = document.getElementById('root');
  if (!root) { return; }
  createRoot(root).render(React.createElement(App));
}

// The module may execute after `load` has already fired, in which case waiting
// for that event would hang forever.
if (document.readyState === 'complete') {
  main();
} else {
  window.addEventListener('load', main);
}
