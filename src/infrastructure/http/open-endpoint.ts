import { SetMetadata } from '@nestjs/common';

/** The metadata key the guard reads; exported so the guard and the decorator cannot disagree. */
export const OPEN_ENDPOINT = Symbol('openEndpoint');

/**
 * `auth.open-endpoints`: this route stays open whatever the authentication setting. It marks the
 * operator's surface — liveness, readiness, metrics — and the two documentation routes, which carry
 * no caller data and have to answer a probe that has no credentials to present (API-009, AUTH-002).
 *
 * The exemption is declared on the route rather than listed as paths inside the guard, so a route
 * that is added is authenticated unless it says otherwise, and a route that moves keeps the
 * exemption it was given.
 */
export const OpenEndpoint = (): MethodDecorator & ClassDecorator =>
  SetMetadata(OPEN_ENDPOINT, true);
