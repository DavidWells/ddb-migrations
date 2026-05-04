import pc from 'picocolors';
import type { Logger } from './types.js';

export function makeLogger(prefix = ''): Logger {
  const p = prefix ? `${prefix} ` : '';
  return {
    info: (msg: string) => console.log(`${p}${msg}`),
    warn: (msg: string) => console.warn(`${p}${pc.yellow(msg)}`),
    error: (msg: string) => console.error(`${p}${pc.red(msg)}`),
    debug: (msg: string) => {
      if (process.env.DEBUG) console.log(`${p}${pc.gray(msg)}`);
    },
  };
}
