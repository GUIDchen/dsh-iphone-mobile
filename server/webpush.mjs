// 零依赖 Web Push（RFC 8291 aes128gcm + RFC 8292 VAPID）。
// 自己实现而不是引依赖：Node 的 crypto 已能提供 P-256 / HKDF / AES-GCM，
// 且本项目可以完全离线运行；正确性由 scripts/selftest-webpush.mjs 做真实往返验证。
import crypto from 'node:crypto';

const INFO_WEBPUSH = Buffer.from('WebPush: info\u0000', 'utf8');
const INFO_CEK = Buffer.from('Content-Encoding: aes128gcm\u0000', 'utf8');
const INFO_NONCE = Buffer.from('Content-Encoding: nonce\u0000', 'utf8');
const RECORD_SIZE = 4096;

function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

/** 生成一对 VAPID 密钥（公钥为未压缩点，65 字节 base64url）。 */
export function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: b64u(ecdh.getPublicKey()),
    privateKey: b64u(ecdh.getPrivateKey()),
  };
}

function vapidPrivateKey(vapid) {
  const pub = Buffer.from(vapid.publicKey, 'base64url');
  if (pub.length !== 65) throw new Error('VAPID 公钥必须是 65 字节未压缩点');
  return crypto.createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: vapid.privateKey,
      x: b64u(pub.subarray(1, 33)),
      y: b64u(pub.subarray(33, 65)),
    },
    format: 'jwk',
  });
}

/** 构造 VAPID Authorization 头（ES256 JWT，有效期 12 小时）。 */
export function vapidHeader(endpoint, vapid, subject, nowMs) {
  const now = nowMs === undefined ? Date.now() : nowMs;
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const data = head + '.' + body;
  const sig = crypto.sign('sha256', Buffer.from(data, 'utf8'), {
    key: vapidPrivateKey(vapid),
    dsaEncoding: 'ieee-p1363',
  });
  return 'vapid t=' + data + '.' + b64u(sig) + ', k=' + vapid.publicKey;
}

/**
 * 加密一条推送负载。
 * @param subscription 订阅对象，形如 { endpoint, keys: { p256dh, auth } }
 * @param plaintext 明文字符串（通常是 JSON）
 * @returns 可直接作为请求体的 Buffer
 */
export function encryptPayload(subscription, plaintext) {
  const uaPublic = Buffer.from(subscription.keys.p256dh, 'base64url');
  const authSecret = Buffer.from(subscription.keys.auth, 'base64url');
  if (uaPublic.length !== 65) throw new Error('p256dh 必须是 65 字节未压缩点');
  if (authSecret.length !== 16) throw new Error('auth 必须是 16 字节');

  const ephemeral = crypto.createECDH('prime256v1');
  ephemeral.generateKeys();
  const asPublic = ephemeral.getPublicKey();
  const shared = ephemeral.computeSecret(uaPublic);

  const ikm = Buffer.from(
    crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([INFO_WEBPUSH, uaPublic, asPublic]), 32),
  );
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, INFO_CEK, 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, INFO_NONCE, 12));

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(plaintext, 'utf8'), Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

/** 解密（仅测试与调试用：接收端视角，持有 UA 私钥）。 */
export function decryptPayload(body, uaPrivateKey, authSecretB64) {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const shared = uaPrivateKey.computeSecret(asPublic);
  const authSecret = Buffer.from(authSecretB64, 'base64url');
  const ikm = Buffer.from(
    crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([INFO_WEBPUSH, uaPrivateKey.getPublicKey(), asPublic]), 32),
  );
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, INFO_CEK, 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, INFO_NONCE, 12));
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  // 去掉末尾的分隔填充（最后一个记录是 0x02）
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end -= 1;
  if (end < 0 || plain[end] !== 2) throw new Error('负载分隔字节不是 0x02');
  return plain.subarray(0, end).toString('utf8');
}

/** 发送一条推送。返回 { ok, status, gone }，gone 为 true 表示订阅已失效需清理。 */
export async function sendWebPush(subscription, payloadObject, vapid, subject, options) {
  const opts = options || {};
  const body = encryptPayload(subscription, JSON.stringify(payloadObject));
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
      ttl: String(opts.ttl || 3600),
      urgency: opts.urgency || 'normal',
      authorization: vapidHeader(subscription.endpoint, vapid, subject, opts.nowMs),
    },
    body,
  });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
