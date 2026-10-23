import { createPublicKey, verify, type KeyObject } from 'node:crypto'
import { checkpointBody, ORIGIN, type SignedCheckpoint } from '@carwash/audit'

export function witnessKey(publicKey: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' })
}

export function isSignedBy(checkpoint: SignedCheckpoint, key: KeyObject, origin = ORIGIN): boolean {
  return verify(null, Buffer.from(checkpointBody(checkpoint, origin)), key, Buffer.from(checkpoint.signature, 'base64'))
}
