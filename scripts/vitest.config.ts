import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolve from this file so every workspace uses the same offline setup.
export function createVitestConfig(name: string, include: string[]) {
  return defineConfig({
    test: {
      name,
      environment: 'node',
      include,
      setupFiles: [fileURLToPath(new URL('./vitest.setup.ts', import.meta.url))],
      clearMocks: true,
      restoreMocks: true,
    },
  });
}
