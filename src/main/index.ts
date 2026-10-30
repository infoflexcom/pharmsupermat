import { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, shell } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '../db';
import { createContext, type ApiContext } from '../services/session';
import { invoke } from './api/invoke';
import { getLicenseStatus } from '../license/license';
import { productNameForEdition } from '../shared/editions';
import { printHtml } from './print/printer';
import { createBackup, listBackups } from '../services/backup';
import { audit } from '../services/audit';

// Keep the Windows data folder stable and branded ("%APPDATA%/Infoflex").
app.setName('Infoflex');

const APP_VERSION = app.getVersion();
let mainWindow: BrowserWindow | null = null;
let ctx: ApiContext | null = null;

const dataDir = join(app.getPath('userData'), 'data');
const backupsDir = join(app.getPath('userData'), 'backups');
const dbPath = join(dataDir, 'infoflex.db');
const iconPath = join(__dirname, '../../resources/icon.png');

function currentProductName(): string {
  if (!ctx) return 'Infoflex';
  const license = getLicenseStatus(ctx.db);
  return productNameForEdition(license.edition);
}

function applyTitle(win: BrowserWindow): void {
  const name = currentProductName();
  win.setTitle(`${name} — Point of Sale`);
  Menu.setApplicationMenu(buildMenu(name));
}

function buildMenu(productName: string): Menu {
  const isMac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Backup now',
          accelerator: 'CmdOrCtrl+B',
          click: async () => {
            if (!ctx) return;
            try {
              const info = createBackup(ctx.db, backupsDir, 'manual');
              audit(ctx.db, {
                action: 'backup.create',
                entity: 'backup',
                entityId: info.name,
                username: 'system-menu',
                severity: 'SECURITY'
              });
              await dialog.showMessageBox({
                type: 'info',
                title: 'Backup complete',
                message: 'Your data has been backed up.',
                detail: info.path
              });
            } catch (error) {
              await dialog.showMessageBox({
                type: 'error',
                title: 'Backup failed',
                message: error instanceof Error ? error.message : String(error)
              });
            }
          }
        },
        { type: 'separator' },
        { role: isMac ? 'close' : 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: `About ${productName}`,
          click: async () => {
            if (!ctx) return;
            const licence = getLicenseStatus(ctx.db);
            const backups = listBackups(backupsDir);
            await dialog.showMessageBox({
              type: 'info',
              title: `About ${productName}`,
              message: `${productName} ${APP_VERSION}`,
              detail: [
                'Strategy | Consulting | Innovation',
                '',
                `Edition: ${licence.edition ?? 'Not activated'}`,
                `Licensed to: ${licence.customerName ?? '—'}`,
                `Licence expires: ${licence.expiresAt ? new Date(licence.expiresAt).toLocaleDateString() : '—'}`,
                `Data folder: ${dataDir}`,
                `Backups: ${backups.length}`
              ].join('\n')
            });
          }
        },
        {
          label: 'Open data folder',
          click: () => {
            void shell.openPath(dataDir);
          }
        }
      ]
    }
  ]);
}

async function createWindow(): Promise<void> {
  const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    backgroundColor: '#F7F5EF',
    icon,
    title: `${currentProductName()} — Point of Sale`,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  applyTitle(mainWindow);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    await mainWindow.loadURL(devUrl);
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  // Keep the window title in sync when the edition changes after activation.
  setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !ctx) return;
    const title = `${currentProductName()} — Point of Sale`;
    if (mainWindow.getTitle() !== title) {
      mainWindow.setTitle(title);
      Menu.setApplicationMenu(buildMenu(currentProductName()));
    }
  }, 5000).unref();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function ensureDailyBackup(context: ApiContext): void {
  try {
    mkdirSync(backupsDir, { recursive: true });
    const backups = listBackups(backupsDir);
    const latest = backups[0];
    const fresh = latest && Date.now() - Date.parse(latest.createdAt) < 24 * 60 * 60 * 1000;
    if (!fresh && getLicenseStatus(context.db).state !== 'NONE') {
      const info = createBackup(context.db, backupsDir, 'auto');
      audit(context.db, {
        action: 'backup.create',
        entity: 'backup',
        entityId: info.name,
        username: 'system',
        details: { automatic: true }
      });
    }
  } catch (error) {
    console.error('[backup] automatic backup failed', error);
  }
}

app.whenReady().then(async () => {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(dbPath);
  db.open();
  ctx = createContext({
    db,
    dataDir,
    backupsDir,
    version: APP_VERSION,
    print: printHtml
  });
  ensureDailyBackup(ctx);

  ipcMain.handle('infoflex:invoke', async (_event, channel: string, payload: unknown) => {
    if (!ctx) return { ok: false, error: { code: 'INTERNAL', message: 'App is starting.' } };
    return invoke(channel, payload, ctx);
  });

  ipcMain.handle('infoflex:appInfo', () => ({
    version: APP_VERSION,
    dataDir,
    backupsDir,
    platform: process.platform
  }));

  // Basic hardening: block navigation away from the packaged app.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      const devUrl = process.env.ELECTRON_RENDERER_URL;
      if (devUrl && url.startsWith(devUrl)) return;
      if (url.startsWith('file://')) return;
      event.preventDefault();
    });
  });

  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  try {
    if (ctx) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const license = getLicenseStatus(ctx.db);
        if (license.state === 'VALID' || license.state === 'EXPIRING') {
          createBackup(ctx.db, backupsDir, 'shutdown');
        }
      }
      ctx.db.close();
    }
  } catch (error) {
    console.error('[shutdown] cleanup failed', error);
  }
});

// Prevent a second instance from fighting over the SQLite file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
