import { createHash, randomBytes } from "node:crypto";

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
