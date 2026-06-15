// Chooses the backend based on CONFIG.backend and re-exports a unified API.
// The app imports from here and never touches the concrete backends directly.

import { CONFIG } from '../config.js';

let impl = null;

export async function initStore() {
  if (impl) return impl;
  impl = CONFIG.backend === 'firebase'
    ? await import('./firebase.js')
    : await import('./local.js');
  await impl.init();
  return impl;
}

// Accessor used after initStore() resolves.
export function S() {
  if (!impl) throw new Error('Store not initialized — call initStore() first.');
  return impl;
}

export const backendKind = () => CONFIG.backend;
