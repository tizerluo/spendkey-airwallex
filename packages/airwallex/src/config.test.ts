import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AirwallexConfigError, loadAirwallexConfig } from './index.js';

const credentials = { AIRWALLEX_CLIENT_ID: 'test-client-id', AIRWALLEX_API_KEY: 'test-api-key' };
afterEach(() => { vi.unstubAllEnvs(); });

describe('config', () => {
  it('defaults to sandbox and hides the API key from serialization and inspection', () => {
    const config = loadAirwallexConfig(credentials);
    expect(config.baseUrl).toBe('https://api-demo.airwallex.com');
    expect(config.clientId).toBe('test-client-id');
    expect(JSON.stringify(config)).not.toContain(credentials.AIRWALLEX_API_KEY);
    expect(String(config)).not.toContain(credentials.AIRWALLEX_API_KEY);
    expect(inspect(config, { showHidden: true })).not.toContain(credentials.AIRWALLEX_API_KEY);
    expect(Object.getOwnPropertyNames(config)).toEqual(['clientId', 'baseUrl']);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('reads only runtime environment credentials when called without arguments', () => {
    vi.stubEnv('AIRWALLEX_CLIENT_ID', 'test-client-id');
    vi.stubEnv('AIRWALLEX_API_KEY', 'test-api-key');
    vi.stubEnv('AIRWALLEX_BASE_URL', 'https://api-demo.airwallex.com');
    expect(loadAirwallexConfig().baseUrl).toBe('https://api-demo.airwallex.com');
  });

  it.each(['AIRWALLEX_CLIENT_ID', 'AIRWALLEX_API_KEY'] as const)('reports missing %s without leaking other values', variable => {
    for (const value of [undefined, '', '  ']) {
      try {
        loadAirwallexConfig({ ...credentials, [variable]: value });
        expect.fail('Expected missing variable error');
      } catch (error) {
        expect(error).toBeInstanceOf(AirwallexConfigError);
        expect(error).toMatchObject({ variable, message: `Missing required variable: ${variable}` });
        expect(String(error)).not.toContain('test-client-id');
        expect(String(error)).not.toContain('test-api-key');
        expect(JSON.stringify(error)).not.toContain('test-api-key');
      }
    }
  });

  it.each([
    'https://api.airwallex.com', 'https://api-demo.airwallex.com.example.com',
    'https://api-demo.airwallex.com:444', 'http://api-demo.airwallex.com',
    'https://test-user:test-password@api-demo.airwallex.com',
    'https://api-demo.airwallex.com/path', 'https://api-demo.airwallex.com?key=test-api-key',
    'https://api-demo.airwallex.com#test-api-key', 'not-a-url-test-api-key', '',
  ])('rejects unsafe base URL without echoing it: %s', url => {
    try {
      loadAirwallexConfig({ ...credentials, AIRWALLEX_BASE_URL: url });
      expect.fail('Expected unsafe base URL error');
    } catch (error) {
      expect(error).toBeInstanceOf(AirwallexConfigError);
      expect(String(error)).toContain('AIRWALLEX_BASE_URL');
      expect(String(error)).not.toContain('test-api-key');
      expect(String(error)).not.toContain(url || 'not-present');
    }
  });

  it('normalizes a trailing slash on the sandbox origin', () => {
    expect(loadAirwallexConfig({ ...credentials, AIRWALLEX_BASE_URL: 'https://api-demo.airwallex.com/' }).baseUrl).toBe('https://api-demo.airwallex.com');
  });
});
