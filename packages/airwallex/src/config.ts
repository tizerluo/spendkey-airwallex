import { AirwallexConfigError } from './errors.js';

export const AIRWALLEX_SANDBOX_URL = 'https://api-demo.airwallex.com';

export interface AirwallexConfig {
  readonly clientId: string;
  readonly baseUrl: string;
}

const apiKeys = new WeakMap<AirwallexConfig, string>();

export function isSandboxUrl(baseUrl: string): boolean {
  return baseUrl === AIRWALLEX_SANDBOX_URL;
}

export function loadAirwallexConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: { allowNonSandbox?: boolean } = {},
): AirwallexConfig {
  const clientId = env['AIRWALLEX_CLIENT_ID'];
  const apiKey = env['AIRWALLEX_API_KEY'];
  if (!clientId?.trim()) throw new AirwallexConfigError('AIRWALLEX_CLIENT_ID');
  if (!apiKey?.trim()) throw new AirwallexConfigError('AIRWALLEX_API_KEY');
  let url: URL;
  try { url = new URL(env['AIRWALLEX_BASE_URL'] ?? AIRWALLEX_SANDBOX_URL); }
  catch { throw new AirwallexConfigError('AIRWALLEX_BASE_URL', 'Invalid AIRWALLEX_BASE_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new AirwallexConfigError('AIRWALLEX_BASE_URL', 'Invalid AIRWALLEX_BASE_URL');
  }
  const baseUrl = url.origin;
  if (!isSandboxUrl(baseUrl) && options.allowNonSandbox !== true) {
    throw new AirwallexConfigError('AIRWALLEX_BASE_URL', 'AIRWALLEX_BASE_URL must use the sandbox host');
  }
  const config = Object.freeze({ clientId, baseUrl });
  apiKeys.set(config, apiKey);
  return config;
}

// Internal accessor: intentionally absent from the public package exports.
export function configApiKey(config: AirwallexConfig): string {
  const key = apiKeys.get(config);
  if (!key) throw new AirwallexConfigError('AIRWALLEX_API_KEY', 'Use loadAirwallexConfig to create config');
  return key;
}
