// React bootstrap for the Kconfig Manager webview.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';

function main() {
  const root = document.getElementById('kconfig-manager-root');
  if (!root) { return; }
  createRoot(root).render(React.createElement(App));
}

// The module may execute after the `load` event has already fired; in that case run
// immediately instead of waiting for an event that will never come.
if (document.readyState === 'complete') {
  main();
} else {
  window.addEventListener('load', main);
}
