/**
 * Browser dev harness.
 *
 * The packaged product is an Electron desktop app. This harness exists so the
 * exact same renderer and the exact same main-process API layer can be opened
 * in a browser (and in the Arena live preview) for review and automated tests.
 * It is NOT shipped in the installer.
 *
 *   npm run dev:web   ->  http://localhost:4173
 */
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { Database } from '../src/db';
import { createContext } from '../src/services/session';
import { invoke } from '../src/main/api/invoke';
import { getLicenseStatus } from '../src/license/license';
import { runDailyBackup } from '../src/services/backup';

const ROOT = join(__dirname, '..');
const DATA_DIR = process.env.INFOFLEX_DATA_DIR
  ? process.env.INFOFLEX_DATA_DIR
  : join(ROOT, 'data');
const BACKUPS_DIR = join(DATA_DIR, 'backups');
const PORT = Number(process.env.PORT || 4173);

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(join(DATA_DIR, 'infoflex.db'));
  db.open();
  const ctx = createContext({
    db,
    dataDir: DATA_DIR,
    backupsDir: BACKUPS_DIR,
    version: '1.0.0-dev (browser harness)'
  });

  try {
    // Same daily safety net as the desktop app, so the preview behaves alike.
    runDailyBackup(db, BACKUPS_DIR);
  } catch (error) {
    console.error('[backup] automatic backup failed', error);
  }

  const vite = await createViteServer({
    root: join(ROOT, 'src/renderer'),
    configFile: false,
    appType: 'spa',
    server: { middlewareMode: true, hmr: false, allowedHosts: true },   // the Arena preview host must be accepted
    resolve: {
      alias: {
        '@shared': join(ROOT, 'src/shared'),
        '@renderer': join(ROOT, 'src/renderer/src')
      }
    },
    plugins: [react()]
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/api/health') {
      const license = getLicenseStatus(db);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, license: license.state, edition: license.edition }));
      return;
    }

    if (url.pathname === '/api/invoke' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
          channel?: string;
          payload?: unknown;
        };
        if (!body.channel) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: { code: 'VALIDATION', message: 'channel is required' } }));
          return;
        }
        const result = await invoke(body.channel, body.payload, ctx);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      } catch (error) {
        res.statusCode = 500;
        res.end(
          JSON.stringify({
            ok: false,
            error: { code: 'INTERNAL', message: error instanceof Error ? error.message : 'Bad request' }
          })
        );
      }
      return;
    }

    // Everything else is the React app.
    vite.middlewares(req, res, () => {
      res.statusCode = 404;
      res.end('Not found');
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Infoflex dev harness running on http://0.0.0.0:${PORT}`);
    console.log(`Data directory: ${DATA_DIR}`);
  });

  const shutdown = () => {
    server.close();
    vite.close().finally(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('[harness] failed to start', error);
  process.exit(1);
});
