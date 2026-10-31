import { contextBridge, ipcRenderer } from 'electron';

/**
 * The renderer never touches Node or SQLite directly: this narrow bridge is
 * the only way in, and every call is re-checked in the main process.
 */
const api = {
  isDesktop: true as const,
  invoke: (channel: string, payload?: unknown): Promise<unknown> =>
    ipcRenderer.invoke('infoflex:invoke', channel, payload ?? {}),
  appInfo: (): Promise<{ version: string; dataDir: string; backupsDir: string; platform: string }> =>
    ipcRenderer.invoke('infoflex:appInfo'),
  /** Fired by the main-process licence watch when the app must lock. */
  onLicenseLocked: (callback: (status: unknown) => void): (() => void) => {
    const listener = (_event: unknown, status: unknown) => callback(status);
    ipcRenderer.on('infoflex:licenseLocked', listener);
    return () => ipcRenderer.removeListener('infoflex:licenseLocked', listener);
  }
};

contextBridge.exposeInMainWorld('infoflex', api);

export type InfoflexBridge = typeof api;
