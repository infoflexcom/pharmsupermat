import type { ApiResult, FeatureFlags, LicenseStatus } from '../../shared/types';
import { featuresForEdition } from '../../shared/editions';
import { AppError } from '../../shared/errors';
import { getLicenseStatus } from '../../license/license';
import { audit } from '../../services/audit';
import { resolveSession, type ApiContext, type Session } from '../../services/session';
import { redactCostsDeep } from '../../services/products';
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
  // A renderer cannot push an unbounded blob through the bridge: every real
  // payload (a logo, a CSV import, a report) is well under this.
  try {
    if (JSON.stringify(rawPayload ?? {}).length > 4 * 1024 * 1024) {
      return fail('VALIDATION', 'That request is too large. Split the data and try again.');
    }
  } catch {
    return fail('VALIDATION', 'That request could not be read.');
  }
  let session: Session | null = null;

  try {
    const known = HANDLER_MAP.get(channel);
    if (!known) return fail('NOT_FOUND', `Unknown request: ${channel}`);

    const license = getLicenseStatus(ctx.db, ctx.now());
    const features = license.features ?? LOCKED_FEATURES;

    // A licence that is not usable locks everything except the handful of
    // channels that can fix it. This check lives in main, so a renderer that
    // ignores the lock screen still cannot reach a single business handler.
    if (known.license !== false && !license.usable) {
      const code =
        license.state === 'EXPIRED' || license.state === 'NOT_STARTED'
          ? 'LICENSE_EXPIRED'
          : license.state === 'NONE'
            ? 'LICENSE_REQUIRED'
            : 'LICENSE_LOCKED';
      return fail(code, license.message ?? 'A valid licence is required to continue.', {
        state: license.state,
        lockReason: license.lockReason
      });
    }

    // Edition modules are mounted at runtime: a channel from a module that the
    // licence does not include is rejected before any handler code is reached.
    const entry = handlerMapFor(features).get(channel);
    if (!entry) {
      return fail('EDITION_RESTRICTED', 'This module is not included in your Infoflex edition.');
    }

    session = resolveSession(ctx, payload.token);

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
    // Cost prices are commercially sensitive. Only a role that may manage
    // products (i.e. the administrator) sees them; every other response is
    // stripped here in main so a curious renderer gains nothing.
    const seesCost = !!session?.permissions.includes('products.manage');
    return { ok: true, data: seesCost ? data : redactCostsDeep(data, false) };
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
