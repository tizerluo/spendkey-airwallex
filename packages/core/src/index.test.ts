import { expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

it('exports the workspace package identity', () => {
  expect(PACKAGE_NAME).toBe('@sr/core');
});
