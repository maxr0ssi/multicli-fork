import { render } from 'preact';

import { App } from './App.js';

const root = document.querySelector<HTMLElement>('#studio-root, [data-studio-root]');
if (root) render(<App />, root);
