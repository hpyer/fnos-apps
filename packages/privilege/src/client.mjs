import { p256 } from '@noble/curves/nist.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { gcm } from '@noble/ciphers/aes.js';

function base64ToBytes(value) {
  const text = String(value);
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  return Uint8Array.from(atob(normalized), character => character.charCodeAt(0));
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function encryptCredential(password, publicKeyValue) {
  const key = typeof publicKeyValue === 'string' ? JSON.parse(publicKeyValue) : publicKeyValue;
  const serverPoint = new Uint8Array(65);
  serverPoint[0] = 0x04;
  serverPoint.set(base64ToBytes(key.x), 1);
  serverPoint.set(base64ToBytes(key.y), 33);
  const priv = p256.utils.randomPrivateKey();
  const pub = p256.getPublicKey(priv, false);
  const shared = p256.getSharedSecret(priv, serverPoint).slice(1);
  const aesKey = hkdf(sha256, shared, new Uint8Array(32), new Uint8Array(0), 32);
  const iv = randomBytes(12);
  const sealed = gcm(aesKey, iv).encrypt(new TextEncoder().encode(password));
  return {
    ephemeralPublicKey: bytesToBase64(pub),
    iv: bytesToBase64(iv),
    tag: bytesToBase64(sealed.slice(-16)),
    data: bytesToBase64(sealed.slice(0, -16)),
  };
}
