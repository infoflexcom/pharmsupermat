/**
 * better-sqlite3 is a native module and must be built for whichever runtime is
 * loading it:
 *   - Electron (the shipped app)  -> `npm run rebuild:electron`
 *   - Node (tests + dev harness)  -> `npm run rebuild:node`
 *
 * This postinstall hook tries the Electron build (what the desktop app needs)
 * and never fails the install: offline machines without Electron headers still
 * get a working repo for tests.
 */
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron-rebuild', '-f', '-w', 'better-sqlite3'],
  { stdio: 'inherit', shell: false }
);

if (result.status !== 0) {
  console.warn(
    [
      '',
      '--------------------------------------------------------------------',
      'Could not rebuild better-sqlite3 for Electron automatically.',
      'This is normal on an offline machine that has no Electron headers.',
      '',
      '  Desktop app : npm run rebuild:electron   (needs network once)',
      '  Tests/harness: npm run rebuild:node',
      '--------------------------------------------------------------------',
      ''
    ].join('\n')
  );
}
