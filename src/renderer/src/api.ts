import type { ApiResult } from '../../shared/types';

/**
 * The renderer talks to the main process through one narrow channel.
 *  - Desktop: window.infoflex.invoke() -> Electron IPC -> main-process guards.
 *  - Browser dev harness: POST /api/invoke -> the very same invoke() function.
 * No business logic or permission checks live in the renderer.
 */

export interface InfoflexBridge {
  isDesktop: true;
  invoke: (channel: string, payload?: unknown) => Promise<unknown>;
  appInfo: () => Promise<{ version: string; dataDir: string; backupsDir: string; platform: string }>;
}

declare global {
  interface Window {
    infoflex?: InfoflexBridge;
  }
}

export class ApiClientError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.details = details;
  }
}

const TOKEN_KEY = 'infoflex.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage may be unavailable */
  }
}

export const isDesktop = (): boolean => Boolean(window.infoflex?.isDesktop);

export async function call<T>(channel: string, payload: Record<string, unknown> = {}): Promise<T> {
  const body = { ...payload, token: getToken() };
  let result: ApiResult<T>;

  if (window.infoflex) {
    result = (await window.infoflex.invoke(channel, body)) as ApiResult<T>;
  } else {
    const response = await fetch('/api/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, payload: body })
    });
    if (!response.ok) {
      throw new ApiClientError('NETWORK', `The service answered with HTTP ${response.status}.`);
    }
    result = (await response.json()) as ApiResult<T>;
  }

  if (!result.ok) {
    throw new ApiClientError(result.error.code, result.error.message, result.error.details);
  }
  return result.data;
}
