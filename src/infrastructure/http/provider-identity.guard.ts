import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { ProviderIdentityPort } from '../../application/ports/provider-identity';
import { OPEN_ENDPOINT } from './open-endpoint';

/** The `ProviderIdentityPort` as a Nest token: an interface cannot be one, and it is bound once. */
export const PROVIDER_IDENTITY = Symbol('providerIdentity');

/** The parts of a request this guard reads, named structurally so it imports no HTTP framework. */
interface IdentifiedRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body?: unknown;
  readonly params?: Record<string, string>;
}

/**
 * `auth.extension-point`: the one place an HTTP caller's identity is resolved and enforced.
 *
 * With the implementation of this version it admits every request, because no identity is
 * established (`auth.deferred`): the guard is on the path all the same, so enabling authentication
 * is binding another `ProviderIdentityPort` at the composition root and changes no controller, no
 * use case and no route (AUTH-001). The routes marked `@OpenEndpoint()` never reach the port at
 * all, so the operator's surface stays open whatever is bound (`auth.open-endpoints`, AUTH-002).
 *
 * What it enforces, once an identity is established, is `auth.intended-design`: a request may only
 * name the provider its caller was authenticated as. The check is here and not in a use case
 * because it is decided by the request alone, before anything is read or written, and it is the
 * same check for every operation; the provider a request names is its payload's `providerId` for a
 * submission and the path's for a provider read, and a request that names none — opening a wallet,
 * reading a ledger — has nothing to contradict.
 *
 * The refusal is a `403` with the framework's own body rather than problem details, because while
 * authentication is deferred the contract has no authentication failure: `ErrorCode` is the closed
 * set of refusals a provider can receive (`failure.request-errors`), and no code in it describes a
 * caller who is not who they claim. The status, its code and its place in `docs/openapi.yaml`
 * arrive with the identity provider that can produce it (#29); until then nothing reaches this
 * branch, which is what the test guard of AUTH-001 exercises in its place.
 */
@Injectable()
export class ProviderIdentityGuard implements CanActivate {
  constructor(
    @Inject(PROVIDER_IDENTITY) private readonly identities: ProviderIdentityPort,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const open = this.reflector.getAllAndOverride<boolean | undefined>(OPEN_ENDPOINT, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (open ?? false) {
      return true;
    }

    const request = context.switchToHttp().getRequest<IdentifiedRequest>();
    const authorization = request.headers['authorization'];
    const identity = await this.identities.identify(
      typeof authorization === 'string' ? { authorization } : {},
    );

    if (identity === null) {
      return true;
    }

    const named = providerNamedBy(request);

    if (named !== undefined && named !== identity.providerId) {
      throw new ForbiddenException(
        `The request names provider ${named} and the caller is ${identity.providerId}.`,
      );
    }

    return true;
  }
}

/**
 * The provider the request names, if it names one. It is read before any pipe has run, so the value
 * is whatever the caller sent: a type other than a string names no provider the identity could
 * equal, and the schema of the operation refuses it afterwards as the violation it is.
 */
function providerNamedBy(request: IdentifiedRequest): string | undefined {
  const inPath = request.params?.['providerId'];

  if (typeof inPath === 'string') {
    return inPath;
  }

  const body = request.body;

  if (body === null || typeof body !== 'object') {
    return undefined;
  }

  const inBody = (body as { providerId?: unknown }).providerId;

  return typeof inBody === 'string' ? inBody : undefined;
}
