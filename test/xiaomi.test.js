import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decryptResponse, generateSignedNonce, rc4Crypt } from "../src/crypto.js";
import { XiaomiFitnessClient } from "../src/xiaomi.js";

const fixturePath = fileURLToPath(new URL("./fixtures/sport-records.json", import.meta.url));
const ssecurity = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

test("password login and sport record fetch against a mocked Xiaomi API", async () => {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const client = new XiaomiFitnessClient({
    username: "user@example.com",
    password: "secret",
    region: "ru",
    timeZone: "Europe/Moscow",
    fetchImpl: async (url, init = {}) => {
      const target = String(url);
      if (target.includes("/pass/serviceLoginAuth2")) {
        return new Response(
          `&&&START&&&${JSON.stringify({
            code: 0,
            userId: "123",
            cUserId: "abc",
            passToken: "refresh",
            ssecurity,
            nonce: "1",
            location: "https://account.xiaomi.com/sts",
          })}`,
          { status: 200 },
        );
      }
      if (target.includes("/pass/serviceLogin")) {
        return new Response(
          `&&&START&&&${JSON.stringify({
            _sign: "sign",
            qs: "?sid=miothealth",
            callback: "https://sts-hlth.io.mi.com/healthapp/sts",
          })}`,
          { status: 200 },
        );
      }
      if (target.includes("/sts")) {
        return new Response("ok", {
          status: 200,
          headers: { "set-cookie": "serviceToken=session-cookie; Path=/" },
        });
      }
      if (target.includes("get_sport_records_by_time")) {
        const params = new URLSearchParams(init.body);
        const nonce = Buffer.from(params.get("_nonce"), "base64");
        const signedNonce = generateSignedNonce(Buffer.from(ssecurity, "base64"), nonce);
        const payload = { code: 0, result: fixture };
        return new Response(rc4Crypt(signedNonce, Buffer.from(JSON.stringify(payload), "utf8")).toString("base64"), {
          status: 200,
        });
      }
      throw new Error(`unexpected url ${target}`);
    },
  });

  await client.login();
  const records = await client.fetchSportRecords({
    startDate: "2025-04-01",
    endDate: "2025-04-01",
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].key, "outdoor_running");
});

test("decrypt helper stays compatible with the request signer", () => {
  const nonce = Buffer.alloc(12, 3);
  const signedNonce = generateSignedNonce(Buffer.from(ssecurity, "base64"), nonce);
  const payload = { code: 0, result: { ok: true } };
  const ciphertext = rc4Crypt(signedNonce, Buffer.from(JSON.stringify(payload), "utf8")).toString("base64");
  assert.deepEqual(decryptResponse(signedNonce, ciphertext), payload);
});
