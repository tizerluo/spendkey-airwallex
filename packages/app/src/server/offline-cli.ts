import { startOfflineConsole } from './offline.js';

try {
  const rawPort = process.env['CONSOLE_PORT'];
  const { server } = await startOfflineConsole({ ...(rawPort === undefined ? {} : { port: Number(rawPort) }) });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { server.close(); });
} catch {
  console.error('Offline console startup failed. Check CONSOLE_PORT and local data directory access.');
  process.exitCode = 1;
}
