import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptResponse,
  generateNonce,
  generateSignature,
  generateSignedNonce,
  rc4Crypt,
  serializeEncryptedForm,
} from "../src/crypto.js";

test("RC4 round-trips plaintext", () => {
  const key = Buffer.from("parse-workout-rc4-key");
  const payload = Buffer.from("xiaomi-fitness-payload", "utf8");
  assert.deepEqual(rc4Crypt(key, rc4Crypt(key, payload)), payload);
});

test("nonce is 12 bytes with a minute timestamp", () => {
  const now = Date.parse("2026-09-14T12:00:00Z");
  const nonce = generateNonce(now);
  assert.equal(nonce.length, 12);
  assert.equal(nonce.readUInt32BE(8), Math.floor(now / 60_000));
});

test("encrypted form can be decrypted back to the JSON payload", () => {
  const ssecurity = Buffer.from("0123456789abcdef0123456789abcdef");
  const nonce = Buffer.alloc(12, 7);
  const payload = { start_time: 1, end_time: 2, key: "steps" };
  const { signedNonce, body } = serializeEncryptedForm(
    "POST",
    "/app/v1/data/get_fitness_data_by_time",
    payload,
    ssecurity,
    nonce,
  );
  const params = new URLSearchParams(body);
  assert.equal(generateSignedNonce(ssecurity, nonce).toString("base64"), signedNonce.toString("base64"));
  assert.ok(params.get("data"));
  assert.ok(params.get("rc4_hash__"));
  assert.ok(params.get("signature"));
  assert.equal(params.get("_nonce"), nonce.toString("base64"));

  const decryptedData = rc4Crypt(signedNonce, Buffer.from(params.get("data"), "base64")).toString("utf8");
  assert.equal(decryptedData, JSON.stringify(payload));
  assert.equal(
    params.get("signature"),
    generateSignature(
      "POST",
      "/app/v1/data/get_fitness_data_by_time",
      { data: params.get("data"), rc4_hash__: params.get("rc4_hash__") },
      signedNonce,
    ),
  );
});

test("decryptResponse parses JSON", () => {
  const signedNonce = Buffer.from("signed-nonce-bytes!!");
  const payload = { code: 0, result: { ok: true } };
  const ciphertext = rc4Crypt(signedNonce, Buffer.from(JSON.stringify(payload), "utf8")).toString("base64");
  assert.deepEqual(decryptResponse(signedNonce, ciphertext), payload);
});
