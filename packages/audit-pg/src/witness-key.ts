import { createPublicKey, verify, type KeyObject } from 'node:crypto'
import { checkpointBody, type SignedCheckpoint } from '@carwash/audit'

export function ed25519PublicKey(publicKey: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' })
}

export function isSignedBy(checkpoint: SignedCheckpoint, key: KeyObject, origin: string): boolean {
  return verify(null, Buffer.from(checkpointBody(checkpoint, origin)), key, Buffer.from(checkpoint.signature, 'base64'))
}
