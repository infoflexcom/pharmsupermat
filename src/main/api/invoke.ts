import type { ApiResult, FeatureFlags, LicenseStatus } from '../../shared/types';
import { featuresForEdition } from '../../shared/editions';
import { AppError } from '../../shared/errors';
import { getLicenseStatus } from '../../license/license';
import { audit } from '../../services/audit';
import { resolveSession, type ApiContext, type Session } from '../../services/session';
import { HANDLER_MAP, PASSWORD_CHANGE_ALLOWLIST, handlerMapFor } from './registry';

export interface HandlerArgs {
  ctx: ApiContext;
  payload: Record<string, unknown>;
  session: Session | null;
  license: LicenseStatus;
  features: FeatureFlags;
  channel: string;
}

const LOCKED_FEATURES: FeatureFlags = {
  ...featuresForEdition('PHARMACY'),
  edition: 'PHARMACY',
  pharmacy: false,
  supermarket: false,
  prescriptions: false,
  wholesale: false
};

function fail(code: string, message: string, details?: unknown): ApiResult<never> {
  return { ok: false, error: { code, message, details } };
}

/**
 * Transport-agnostic entry point. The Electron IPC layer and the browser dev
 * harness both call exactly this function, so guards cannot be bypassed by a
 * different transport.
 */
export async function invoke(
  channel: string,
  rawPayload: unknown,
  ctx: ApiContext
): Promise<ApiResult<unknown>> {
  const payload = (rawPayload && typeof rawPayload === 'object' ? rawPayload : {}) as Record<
    string,
    unknown
  >;
  let session: Session | null = null;

  try {
    const known = HANDLER_MAP.get(channel);
    if (!known) return fail('NOT_FOUND', `Unknown request: ${channel}`);

    const license = getLicenseStatus(ctx.db, ctx.now());
    const features = license.features ?? LOCKED_FEATURES;

    // Edition modules are mounted at runtime: a channel from a module that the
    // licence does not include is rejected before any handler code is reached.
    const entry = handlerMapFor(features).get(channel);
    if (!entry) {
      return fail('EDITION_RESTRICTED', 'This module is not included in your Infoflex edition.');
    }

    session = resolveSession(ctx, payload.token);

    if (entry.license !== false) {
      if (license.state === 'NONE' || license.state === 'INVALID') {
        return fail('LICENSE_REQUIRED', license.message ?? 'Activate your licence to continue.');
      }
      if (license.state === 'EXPIRED') {
        return fail('LICENSE_EXPIRED', license.message ?? 'Your licence has expired.');
      }
    }

    if (entry.feature && !features[entry.feature]) {
      return fail(
        'EDITION_RESTRICTED',
        'This module is not included in your Infoflex edition.'
      );
    }

    if (entry.auth !== false && !session) {
      return fail('UNAUTHENTICATED', 'Your session has ended. Please sign in again.');
    }

    if (session?.mustChangePassword && !PASSWORD_CHANGE_ALLOWLIST.has(channel)) {
      return fail('FORBIDDEN', 'Change your temporary password before continuing.');
    }

    if (entry.permission && session && !session.permissions.includes(entry.permission)) {
      audit(ctx.db, {
        action: 'security.permission.denied',
        entity: 'channel',
        entityId: channel,
        userId: session.userId,
        username: session.username,
        severity: 'SECURITY',
        details: { required: entry.permission, role: session.role }
      });
      return fail('FORBIDDEN', 'You do not have permission to do that.');
    }

    const data = await entry.handler({ ctx, payload, session, license, features, channel });
    return { ok: true, data };
  } catch (error) {
    if (error instanceof AppError) {
      if (error.code === 'FORBIDDEN' && session) {
        audit(ctx.db, {
          action: 'security.denied',
          entity: 'channel',
          entityId: channel,
          userId: session.userId,
          username: session.username,
          severity: 'SECURITY',
          details: { message: error.message }
        });
      }
      return fail(error.code, error.message, error.details);
    }
    console.error(`[api] unhandled error in ${channel}`, error);
    return fail(
      'INTERNAL',
      error instanceof Error ? error.message : 'Something went wrong. Please try again.'
    );
  }
}
