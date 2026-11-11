import { beforeEach } from 'vitest';

const offlineFetch: typeof globalThis.fetch = async () => {
  throw new Error('Network access is disabled in offline tests (global fetch).');
};

// Apply at module load and before each test; mocks must be explicit and local.
globalThis.fetch = offlineFetch;
beforeEach(() => {
  globalThis.fetch = offlineFetch;
});
