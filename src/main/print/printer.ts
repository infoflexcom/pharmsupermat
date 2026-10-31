import { BrowserWindow } from 'electron';

/**
 * Renders a document in an offscreen window and sends it to the system print
 * dialog. Everything is local: no network, no cloud printing.
 */
export async function printHtml(payload: {
  html: string;
  title: string;
  /** Chosen in Settings; empty means the system dialog decides. */
  deviceName?: string;
  /** Print straight to `deviceName` without showing the dialog. */
  silent?: boolean;
}): Promise<{ printed: boolean; message: string }> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 900,
      height: 1200,
      show: false,
      title: payload.title,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        javascript: false
      }
    });

    const cleanup = () => {
      if (!win.isDestroyed()) win.destroy();
    };

    win.webContents
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(payload.html)}`)
      .then(() => {
        const silent = Boolean(payload.silent && payload.deviceName);
        win.webContents.print(
          {
            silent,
            printBackground: true,
            margins: { marginType: 'default' },
            ...(payload.deviceName ? { deviceName: payload.deviceName } : {})
          },
          (success, failureReason) => {
            cleanup();
            resolve({
              printed: success,
              message: success ? 'Sent to printer.' : failureReason || 'Printing was cancelled.'
            });
          }
        );
      })
      .catch((error: unknown) => {
        cleanup();
        resolve({
          printed: false,
          message: error instanceof Error ? error.message : 'Could not prepare the document.'
        });
      });
  });
}

/** The printers Windows reports, so Settings can offer a list instead of typing. */
export async function listPrinters(): Promise<{ name: string; displayName: string; isDefault: boolean }[]> {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    const printers = await win.webContents.getPrintersAsync();
    return printers.map((printer) => ({
      name: printer.name,
      displayName: printer.displayName || printer.name,
      // Chromium's PrinterInfo does not tell us which printer is the system
      // default, so the flag stays false and the list is alphabetical.
      isDefault: false
    }));
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * Renders the same HTML to a PDF buffer (A4) with Chromium's own engine, so a
 * report exported as PDF looks exactly like the printed page — store header,
 * period, tables and chart. Nothing leaves the machine.
 */
export async function pdfHtml(payload: { html: string; title: string }): Promise<Buffer> {
  const win = new BrowserWindow({
    width: 1200,
    height: 1600,
    show: false,
    title: payload.title,
    webPreferences: { sandbox: true, contextIsolation: true, javascript: false }
  });
  try {
    await win.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(payload.html)}`);
    return await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
