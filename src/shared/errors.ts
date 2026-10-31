export type ErrorCode =
  | 'VALIDATION'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'LICENSE_REQUIRED'
  | 'LICENSE_EXPIRED'
  | 'LICENSE_LOCKED'
  | 'SETUP_REQUIRED'
  | 'EDITION_RESTRICTED'
  | 'INSUFFICIENT_STOCK'
  | 'APPROVAL_REQUIRED'
  | 'SHIFT_REQUIRED'
  | 'PRINT_BLOCKED'
  | 'UNAVAILABLE'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} was not found.`);
export const forbidden = (message = 'You do not have permission to do that.') =>
  new AppError('FORBIDDEN', message);
export const validation = (message: string, details?: unknown) =>
  new AppError('VALIDATION', message, details);
export const conflict = (message: string) => new AppError('CONFLICT', message);
