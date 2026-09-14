import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import test from "node:test";
import {
  buildFdsSuffix,
  clientSign,
  decryptFdsData,
  deviceIdFromUsername,
  encryptFdsData,
  FDS_AES_IV,
  md5Upper,
} from "../src/crypto.js";
import { parseGpsRecord, pointsFromPackedCoordinates } from "../src/gps.js";
import { gpxFileName, renderGpx } from "../src/gpx.js";

test("password is hashed the Xiaomi way", () => {
  assert.equal(md5Upper("secret"), "5EBE2294ECD0E0F08EAB7690D2A6EE69");
  assert.match(clientSign("1", "abc"), /^=*[A-Za-z0-9+/]+=*$/);
  assert.equal(deviceIdFromUsername("user@example.com").length, 16);
});

test("FDS AES round-trips", () => {
  const key = Buffer.alloc(16, 7).toString("base64url");
  const plaintext = Buffer.from("xiaomi-fds-payload-ok!!");
  const encrypted = encryptFdsData(plaintext, key);
  assert.deepEqual(decryptFdsData(encrypted, key), plaintext);
});

test("FDS suffix is stable", () => {
  assert.equal(
    buildFdsSuffix({ sid: "device-1", timestamp: 1743501600, timezoneOffset: 12, sportType: 1, fileType: 2 }),
    buildFdsSuffix({ sid: "device-1", timestamp: 1743501600, timezoneOffset: 12, sportType: 1, fileType: 2 }),
  );
});

test("packed Huami coordinates become a track", () => {
  const points = pointsFromPackedCoordinates({
    longitude: "3750000000,1000",
    latitude: "5570000000,2000",
    startTime: 100,
  });
  assert.equal(points.length, 2);
  assert.equal(points[0].longitude, 37.5);
  assert.equal(points[1].latitude, 55.70002);
  assert.equal(points[1].timestamp, 101);
});

test("GPS v1 binary records parse into points", () => {
  const header = Buffer.alloc(9);
  header.writeUInt32LE(1743501600, 0);
  header[5] = 1;
  header[8] = 0xe0;
  const body = Buffer.alloc(12);
  body.writeUInt32LE(1743501600, 0);
  body.writeFloatLE(37.5, 4);
  body.writeFloatLE(55.7, 8);
  const points = parseGpsRecord(Buffer.concat([header, body]));
  assert.equal(points.length, 1);
  assert.equal(points[0].longitude.toFixed(1), "37.5");
  assert.equal(points[0].latitude.toFixed(1), "55.7");
});

test("renderGpx writes a track", () => {
  const xml = renderGpx(
    { activityType: "outdoor_running", start: "2025-04-01T10:00:00.000Z", localDate: "2025-04-01" },
    [{ timestamp: 1743501600, latitude: 55.7, longitude: 37.5, altitude: 120, heartRate: 150 }],
  );
  assert.match(xml, /<trkpt lat="55.7000000" lon="37.5000000">/);
  assert.match(xml, /<gpxtpx:hr>150<\/gpxtpx:hr>/);
  assert.equal(gpxFileName({ localDate: "2025-04-01", start: "2025-04-01T10:00:00.000Z", activityType: "outdoor_running" }), "2025-04-01_100000_outdoor_running.gpx");
});

test("encrypt helper uses AES-CBC", () => {
  const key = Buffer.alloc(16, 3);
  const cipher = createCipheriv("aes-128-cbc", key, FDS_AES_IV);
  const encrypted = Buffer.concat([cipher.update("hello-fds-data!!"), cipher.final()]).toString("base64url");
  assert.equal(decryptFdsData(encrypted, key.toString("base64url")).toString(), "hello-fds-data!!");
});
