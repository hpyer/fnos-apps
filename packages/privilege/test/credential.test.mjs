import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { createCredentialKey, decryptCredential } from '../src/credential.mjs';

test('credential key round trip decrypts the encrypted password', () => {
  const key = createCredentialKey();
  const publicKey = JSON.parse(key.publicKey);
  const client = crypto.createECDH('prime256v1');
  client.generateKeys();
  const shared = client.computeSecret(Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(publicKey.x, 'base64url'),
    Buffer.from(publicKey.y, 'base64url'),
  ]));
  const aesKey = crypto.hkdfSync('sha256', shared, Buffer.alloc(32), Buffer.alloc(0), 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(aesKey), iv);
  const encrypted = Buffer.concat([cipher.update('secret-pass', 'utf8'), cipher.final()]);
  const result = decryptCredential({ encryptedCredential: {
    ephemeralPublicKey: client.getPublicKey().toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  } }, key.privateKey);
  assert.equal(result.password, 'secret-pass');
});

test('missing credential session is rejected', () => {
  assert.throws(() => decryptCredential({ encryptedCredential: {} }, ''), /凭据通道未就绪/);
});
