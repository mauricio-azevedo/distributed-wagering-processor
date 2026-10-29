/**
 * `auth.extension-point`: who the caller of a request is, as the application layer asks for it.
 *
 * This version authenticates nobody (`auth.deferred`): providers reach the service inside the
 * platform's network boundary, and the implementation bound at the composition root establishes no
 * identity, so every request is admitted. The port exists anyway, and exists here rather than in
 * the adapter, because the question it asks is the application's: which provider is this operation
 * being submitted on behalf of. Enabling authentication is implementing this interface and binding
 * it, and the intended implementation is recorded in ARCHITECTURE.md (`auth.intended-design`).
 *
 * No use case takes a `ProviderIdentity`, and that is deliberate. The rule the identity decides —
 * a payload may only name the provider the caller was authenticated as — is about the request and
 * not about the money: it holds before any wallet is read, it is the same for every operation, and
 * a use case that took the identity as an argument would make every financial signature carry a
 * transport concern and every call site able to pass the wrong one. The boundary that resolves the
 * identity is therefore the boundary that enforces it (AUTH-001).
 */

/** What a transport presents as proof of identity. Empty in this version. */
export interface ProviderCredentials {
  /** The `Authorization` header, when the request carried one. */
  readonly authorization?: string;
}

/** The provider a caller was established to be. */
export interface ProviderIdentity {
  /** The `providerId` every operation of that provider must name (`tx.identity`). */
  readonly providerId: string;
}

export interface ProviderIdentityPort {
  /**
   * The provider the credentials establish, or `null` when the deployment establishes none — which
   * is this one. An implementation that requires credentials and cannot accept the ones it was
   * given refuses, in the terms of its own transport, rather than answering `null`: a caller whose
   * token is invalid is not a caller nobody asked to identify.
   */
  identify(credentials: ProviderCredentials): Promise<ProviderIdentity | null>;
}

/**
 * The implementation of this version: no credentials are asked for, so no identity is established
 * and the guard admits every request (`auth.deferred`, AUTH-001).
 *
 * It is a value and not a class because it holds nothing and decides nothing — the whole of it is
 * the answer `null` — and naming it is what makes the deferral a binding at the composition root
 * that a deployment replaces, rather than an absence spread over the adapters.
 */
export const unauthenticatedProviderIdentity: ProviderIdentityPort = {
  identify: () => Promise.resolve(null),
};
