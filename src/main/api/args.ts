import type { HandlerArgs } from './invoke';
import type { Session } from '../../services/session';
import { AppError, validation } from '../../shared/errors';

/** Shared argument helpers for the core handlers and the edition modules. */

export function actor(session: Session): { userId: number; username: string } {
  return { userId: session.userId, username: session.username };
}

export function salesActor(session: Session): { userId: number; username: string; permissions: string[] } {
  return { userId: session.userId, username: session.username, permissions: session.permissions };
}

export function requireSession(args: HandlerArgs): Session {
  if (!args.session) throw new AppError('UNAUTHENTICATED', 'Please sign in to continue.');
  return args.session;
}

export function payloadOf<T>(args: HandlerArgs): T {
  if (!args.payload || typeof args.payload !== 'object') {
    throw validation('Missing request details.');
  }
  return args.payload as T;
}
