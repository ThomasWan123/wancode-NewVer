/** Fail-closed WanCodeNewVer remote-control protocol and outbound-only WebSocket client. */

export {
  RELAY_ERROR_CODES,
  RelayAuthorizationError,
  isRelayErrorCode,
  type RelayErrorCode,
} from './errors.ts'
export {
  RELAY_PROTOCOL_VERSION,
  assertNoPlaintextRelayFields,
  createMemoryRelayStore,
  dispatchRelayEnvelope,
  parseRelayEnvelope,
  type RelayAccessToken,
  type RelayActor,
  type RelayDevice,
  type RelayDispatchInput,
  type RelayDispatchResult,
  type RelayEnvelope,
  type RelayFrameKind,
  type RelayRoute,
  type RelayStore,
} from './envelope.ts'
export {
  assertDeviceEncryptionPublicKey,
  assertDevicePublicKey,
  createStoredDeviceIdentity,
  createWebCryptoDeviceIdentity,
  generateDeviceKeyPair,
  parseStoredDeviceIdentity,
  publicDeviceIdentity,
  serializeStoredDeviceIdentity,
  signDevicePayload,
  verifyDevicePayload,
  type DeviceKeyPair,
  type PublicDeviceIdentity,
  type StoredDeviceIdentity,
} from './device-keys.ts'
export {
  RELAY_DEVICE_ID_BYTES,
  createWebCryptoDeviceId,
  generateWebCryptoDeviceKeyPair,
  signWebCryptoDevicePayload,
} from './webcrypto-keys.ts'
export {
  createStaticOidcIdentityProvider,
  parseOidcIdentityAssertion,
  type OidcIdentityProviderConfig,
  type RelayIdentityClaims,
  type RelayIdentityProvider,
} from './identity.ts'
export {
  assertOidcJwksUrl,
  createJwksOidcIdentityProvider,
  fetchOidcJwks,
  parseRelayJsonWebKeySet,
  type JwksOidcIdentityProviderConfig,
  type RelayJsonWebKeySet,
  type RelayJwksFetch,
} from './oidc-jwks.ts'
export {
  listRelayAccountDevices,
  LOOPBACK_RELAY_USER_ID,
  registerRelayAccountDevice,
  registerRelayDevice,
  revokeRelayDevice,
  type RegisterRelayDeviceInput,
  type RelayDeviceStore,
  type RevokeRelayDeviceInput,
} from './devices.ts'
export {
  RELAY_CAPABILITIES,
  RELAY_HANDSHAKE_NONCE_BYTES,
  createRelayHandshakeNonce,
  createSignedHandshakeEnvelope,
  createWebCryptoSignedHandshakeEnvelope,
  openOutboundSession,
  parseHandshakeAck,
  type HandshakeAck,
  type OutboundHandshakeClaims,
  type OutboundSession,
  type RelayCapability,
  type RelayHandshakeDirection,
  type SignedHandshakeEnvelopeInput,
} from './handshake.ts'
export {
  parseRelayWireCommand,
  parseRelayWireDelivery,
  parseRelayWireHandshake,
  type RelayWireCommand,
  type RelayWireDelivery,
  type RelayWireHandshake,
} from './wire.ts'
export {
  assertOutboundRelayUrl,
} from './url.ts'
export {
  connectOutboundRelay,
  type AcknowledgeOutboundRelayFrameInput,
  type ConnectOutboundRelayInput,
  type OutboundRelayConnection,
  type SendOutboundRelayFrameInput,
} from './outbound.ts'
export {
  assertOutboundRelayHttpUrl,
  httpUrlFromOutboundRelayUrl,
  outboundRelayUrlFromHttpUrl,
  issueOutboundRelayToken,
  listOutboundRelayDevices,
  mintOutboundRelayPairingGrant,
  redeemOutboundRelayPairingGrant,
  registerOutboundRelayDevice,
  enrollOutboundRelayLoopbackDevice,
  revokeOutboundRelayDevice,
  type MintOutboundRelayPairingGrantInput,
  type OutboundRelayAccessToken,
  type OutboundRelayControlInput,
  type OutboundRelayDevice,
  type OutboundRelayPairingGrant,
  type OutboundRelayPairingRedemption,
  type OutboundRelayRevocation,
  type RedeemOutboundRelayPairingGrantInput,
  type RegisterOutboundRelayDeviceInput,
  type EnrollOutboundRelayLoopbackDeviceInput,
  type OutboundRelayLoopbackEnrollment,
  type ListOutboundRelayDevicesInput,
  type RevokeOutboundRelayDeviceInput,
  type RelayControlFetch,
} from './control-client.ts'
export {
  RELAY_PAIRING_CODE_LENGTH,
  RELAY_PAIRING_GRANT_TTL_MS,
  assertRelayPairingCode,
  createMemoryRelayPairingGrantStore,
  createRelayPairingCode,
  mintRelayPairingGrant,
  redeemRelayPairingGrant,
  type MintRelayPairingGrantInput,
  type MintedRelayPairingGrant,
  type RedeemRelayPairingGrantInput,
  type RedeemedRelayPairingGrant,
  type RelayPairingGrant,
  type RelayPairingGrantStore,
} from './pairing-grant.ts'
export {
  RELAY_ACCESS_TOKEN_TTL_MS,
  createMemoryRelayTokenIssuer,
  issueRelayAccessToken,
  type IssueRelayAccessTokenInput,
  type IssuedRelayAccessToken,
  type RelayTokenIssuer,
} from './tokens.ts'
export {
  routeRelayEnvelope,
  type RelayRouteStore,
  type RouteRelayEnvelopeInput,
} from './route.ts'
export {
  RELAY_RATE_LIMIT_MAX_EVENTS,
  RELAY_RATE_LIMIT_WINDOW_MS,
  createMemoryRelayRateLimiter,
  type MemoryRelayRateLimiterConfig,
  type RelayRateLimiter,
} from './rate-limit.ts'
export {
  createMemoryRelayAuditLog,
  parseRelayAuditEvent,
  recordRelayAuditEvent,
  type RelayAuditAction,
  type RelayAuditEvent,
  type RelayAuditLog,
  type RelayAuditOutcome,
} from './audit.ts'
export {
  acknowledgeRelayMailbox,
  createMemoryRelayMailbox,
  createMemoryRelayPresence,
  deliverRelayEnvelope,
  reclaimRelayMailbox,
  type AcknowledgeRelayMailboxInput,
  type DeliverRelayEnvelopeInput,
  type ReclaimRelayMailboxInput,
  type RelayDelivery,
  type RelayDeliveryOutcome,
  type RelayLiveSink,
  type RelayMailbox,
  type RelayPresence,
} from './delivery.ts'
export {
  assertSealedApplicationEnvelope,
  createSealedRelayEnvelope,
  createWebCryptoSealedRelayEnvelope,
  openSealedRelayPayload,
  openWebCryptoSealedRelayPayload,
  type RelayApplicationKind,
  type RelayApplicationPayload,
  type SealedRelayEnvelopeInput,
} from './payload.ts'
