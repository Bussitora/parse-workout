import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const FDS_AES_IV = Buffer.from("1234567887654321");

export function rc4Crypt(key, payload) {
  const state = Array.from({ length: 256 }, (_, index) => index);
  let stateIndex = 0;
  const keyLength = key.length;
  for (let index = 0; index < 256; index += 1) {
    stateIndex = (stateIndex + state[index] + key[index % keyLength]) % 256;
    [state[index], state[stateIndex]] = [state[stateIndex], state[index]];
  }

  let index = 0;
  stateIndex = 0;
  const nextByte = () => {
    index = (index + 1) % 256;
    stateIndex = (stateIndex + state[index]) % 256;
    [state[index], state[stateIndex]] = [state[stateIndex], state[index]];
    return state[(state[index] + state[stateIndex]) % 256];
  };

  for (let skip = 0; skip < 1024; skip += 1) {
    nextByte();
  }

  const input = Buffer.from(payload);
  const output = Buffer.alloc(input.length);
  for (let offset = 0; offset < input.length; offset += 1) {
    output[offset] = input[offset] ^ nextByte();
  }
  return output;
}

export function generateNonce(now = Date.now()) {
  const nonce = Buffer.alloc(12);
  randomBytes(8).copy(nonce, 0);
  nonce.writeUInt32BE(Math.floor(now / 60_000), 8);
  return nonce;
}

export function generateSignedNonce(ssecurity, nonce) {
  return createHash("sha256").update(Buffer.concat([ssecurity, nonce])).digest();
}

export function generateSignature(method, path, values, signedNonce) {
  let base = `${method}&${path}&data=${values.data}`;
  if (Object.hasOwn(values, "rc4_hash__")) {
    base += `&rc4_hash__=${values.rc4_hash__}`;
  }
  base += `&${signedNonce.toString("base64")}`;
  return createHash("sha1").update(base, "utf8").digest("base64");
}

export function serializeEncryptedForm(method, path, payload, ssecurity, nonce) {
  const signedNonce = generateSignedNonce(ssecurity, nonce);
  const form = { data: JSON.stringify(payload) };
  form.rc4_hash__ = generateSignature(method, path, form, signedNonce);

  const encrypted = {};
  for (const [key, value] of Object.entries(form)) {
    encrypted[key] = rc4Crypt(signedNonce, Buffer.from(value, "utf8")).toString("base64");
  }
  encrypted.signature = generateSignature(method, path, encrypted, signedNonce);
  encrypted._nonce = nonce.toString("base64");
  return { signedNonce, body: new URLSearchParams(encrypted).toString() };
}

export function decryptResponse(signedNonce, ciphertext) {
  const plaintext = rc4Crypt(signedNonce, Buffer.from(ciphertext, "base64")).toString("utf8");
  return JSON.parse(plaintext);
}

export function md5Upper(value) {
  return createHash("md5").update(String(value), "utf8").digest("hex").toUpperCase();
}

export function clientSign(nonce, ssecurity) {
  return createHash("sha1").update(`nonce=${nonce}&${ssecurity}`, "utf8").digest("base64");
}

export function deviceIdFromUsername(username) {
  return createHash("sha1").update(String(username), "utf8").digest("hex").slice(0, 16).toUpperCase();
}

export function b64urlDecode(value) {
  const normalized = String(value).replaceAll("-", "+").replaceAll("_", "/");
  return Buffer.from(normalized + "=".repeat((4 - (normalized.length % 4)) % 4), "base64");
}

function aesAlgorithm(keyLength) {
  if (keyLength === 16) {
    return "aes-128-cbc";
  }
  if (keyLength === 24) {
    return "aes-192-cbc";
  }
  if (keyLength === 32) {
    return "aes-256-cbc";
  }
  throw new Error(`Unsupported FDS AES key length: ${keyLength}`);
}

function fdsCiphertext(body) {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (typeof body !== "string") {
    return b64urlDecode(JSON.stringify(body));
  }
  const trimmed = body.trim();
  if (trimmed.startsWith('"')) {
    return b64urlDecode(JSON.parse(trimmed));
  }
  return b64urlDecode(trimmed);
}

export function encryptFdsData(plaintext, objectKey) {
  const key = b64urlDecode(objectKey);
  const cipher = createCipheriv(aesAlgorithm(key.length), key, FDS_AES_IV);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]).toString("base64url");
}

export function decryptFdsData(body, objectKey) {
  const key = b64urlDecode(objectKey);
  const decipher = createDecipheriv(aesAlgorithm(key.length), key, FDS_AES_IV);
  const ciphertext = fdsCiphertext(body);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function buildFdsSuffix({ sid, timestamp, timezoneOffset, sportType, fileType }) {
  const serverKey = Buffer.alloc(6);
  serverKey.writeUInt32LE(Number(timestamp) >>> 0, 0);
  serverKey[4] = Number(timezoneOffset) & 0xff;
  serverKey[5] = ((1 << 7) + (Number(sportType) << 2) + Number(fileType)) & 0xff;
  const sidHash = createHash("sha1").update(String(sid), "utf8").digest();
  return `${serverKey.toString("base64url")}_${sidHash.toString("base64url")}`;
}
