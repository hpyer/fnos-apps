import crypto from 'node:crypto';

export class CredentialError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'CredentialError';
    this.status = status;
  }
}

export function createCredentialKey() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const pub = ecdh.getPublicKey();
  const publicKey = { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') };
  return {
    privateKey: JSON.stringify({ ...publicKey, d: ecdh.getPrivateKey().toString('base64url') }),
    publicKey: JSON.stringify(publicKey),
  };
}

export function decryptCredential(body, keyJson) {
  const encrypted = body?.encryptedCredential;
  if (!encrypted || typeof encrypted !== 'object') return { ...body, password: '' };
  if (!keyJson) throw new CredentialError('凭据通道未就绪，请刷新页面后重试', 409);
  const { ephemeralPublicKey, iv, tag, data } = encrypted;
  if (typeof ephemeralPublicKey !== 'string' || typeof iv !== 'string' || typeof tag !== 'string' || typeof data !== 'string') {
    throw new CredentialError('凭据格式无效');
  }
  try {
    let rawPoint = Buffer.from(ephemeralPublicKey, 'base64');
    if (rawPoint.length === 33 && (rawPoint[0] === 0x02 || rawPoint[0] === 0x03)) {
      rawPoint = crypto.ECDH.convertKey(rawPoint, 'prime256v1', undefined, undefined, 'uncompressed');
    }
    if (rawPoint.length !== 65 || rawPoint[0] !== 0x04) throw new CredentialError('凭据公钥格式无效');
    const server = crypto.createECDH('prime256v1');
    server.setPrivateKey(Buffer.from(JSON.parse(keyJson).d, 'base64url'));
    const shared = server.computeSecret(rawPoint);
    const aesKey = crypto.hkdfSync('sha256', shared, Buffer.alloc(32), Buffer.alloc(0), 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(aesKey), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    return { ...body, password: plain.slice(0, 512) };
  } catch (error) {
    if (error instanceof CredentialError) throw error;
    throw new CredentialError('凭据解密失败，请刷新页面后重试');
  }
}
