import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import { parseFitRecords } from "../src/fit.js";
import { GarminPersonalApiClient, fitToGpx, garminFileName } from "../src/garmin.js";
import { extractFirstFile } from "../src/zip.js";

const FIT_EPOCH_OFFSET = 631065600;

// FIT file: a "record" definition (timestamp, lat, lon, enhanced altitude, HR, cadence),
// two normal data messages and one with a compressed timestamp header.
function buildFit() {
  const deg = (value) => Math.round((value * 2 ** 31) / 180);
  const definition = Buffer.from([
    0x40, 0, 0, 20, 0, 6,
    253, 4, 0x86,
    0, 4, 0x85,
    1, 4, 0x85,
    78, 4, 0x86,
    3, 1, 0x02,
    4, 1, 0x02,
  ]);
  const record = (headerByte, timestamp, lat, lon, altitude, hr, cadence) => {
    const buffer = Buffer.alloc(19);
    buffer.writeUInt8(headerByte, 0);
    buffer.writeUInt32LE(timestamp, 1);
    buffer.writeInt32LE(lat, 5);
    buffer.writeInt32LE(lon, 9);
    buffer.writeUInt32LE(altitude, 13);
    buffer.writeUInt8(hr, 17);
    buffer.writeUInt8(cadence, 18);
    return buffer;
  };
  const t0 = Date.parse("2026-11-03T11:40:00Z") / 1000 - FIT_EPOCH_OFFSET;
  const first = record(0x00, t0, deg(57.8646774), deg(59.9490623), (200 + 500) * 5, 140, 82);
  const second = record(0x00, t0 + 1, deg(57.8646622), deg(59.9490738), 0xffffffff, 0xff, 83);
  // Compressed header: local type 0, time offset = (t0 + 3) & 0x1f; the body has no timestamp
  // field in a real file, but here the definition still includes it, so the size matches.
  const compressed = record(0x80 | ((t0 + 3) & 0x1f), 0xffffffff, deg(57.86465), deg(59.94912), (201 + 500) * 5, 142, 84);
  const data = Buffer.concat([definition, first, second, compressed]);
  const header = Buffer.alloc(12);
  header.writeUInt8(12, 0);
  header.writeUInt8(0x20, 1);
  header.writeUInt16LE(2132, 2);
  header.writeUInt32LE(data.length, 4);
  header.write(".FIT", 8, "latin1");
  return Buffer.concat([header, data, Buffer.alloc(2)]);
}

// ZIP with one deflated entry, sizes only in the central directory (data descriptor style).
function buildZip(name, content) {
  const compressed = zlib.deflateRawSync(content);
  const fileName = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(0x08, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  central.writeUInt32LE(0, 42);
  const localPart = Buffer.concat([local, fileName, compressed]);
  const centralPart = Buffer.concat([central, fileName]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

test("FIT records decode GPS, altitude, HR, cadence and compressed timestamps", () => {
  const records = parseFitRecords(buildFit());
  assert.equal(records.length, 3);
  const start = Date.parse("2026-11-03T11:40:00Z") / 1000;
  assert.deepEqual(records.map((r) => r.timestamp), [start, start + 1, start + 3]);
  assert.ok(Math.abs(records[0].latitude - 57.8646774) < 1e-6);
  assert.ok(Math.abs(records[0].longitude - 59.9490623) < 1e-6);
  assert.equal(records[0].altitude, 200);
  assert.equal(records[0].heartRate, 140);
  assert.equal(records[1].altitude, null);
  assert.equal(records[1].heartRate, null);
  assert.equal(records[2].cadence, 84);
});

test("ZIP reader inflates the FIT entry using central directory sizes", () => {
  const fit = buildFit();
  assert.deepEqual(extractFirstFile(buildZip("123_ACTIVITY.fit", fit), /\.fit$/i), fit);
  assert.throws(() => extractFirstFile(buildZip("notes.txt", fit), /\.fit$/i), /No matching file/);
});

test("FIT converts to GPX with per-point HR, elevation and steps-per-minute cadence", () => {
  const xml = fitToGpx(buildFit(), { activityType: { typeKey: "running" }, averageHR: 141.2, maxHR: 150 });
  assert.match(xml, /<desc>HR avg 141, max 150, min 140<\/desc>/);
  assert.match(xml, /<type>outdoor_running<\/type>/);
  assert.match(xml, /<ele>200<\/ele>/);
  assert.match(xml, /<gpxtpx:hr>140<\/gpxtpx:hr>\s*<gpxtpx:cad>164<\/gpxtpx:cad>/);
  assert.equal((xml.match(/<trkpt /g) || []).length, 3);
});

test("file names use local date, UTC time and Xiaomi-compatible activity type", () => {
  assert.equal(
    garminFileName({
      startTimeLocal: "2026-11-03 00:40:54",
      startTimeGMT: "2026-11-02 19:40:54",
      activityType: { typeKey: "running" },
    }),
    "2026-11-03_194054_outdoor_running_garmin.gpx",
  );
  assert.equal(
    garminFileName({ startTimeLocal: "2026-11-03 10:00:00", startTimeGMT: "2026-11-03 05:00:00", activityType: { typeKey: "trail_running" } }),
    "2026-11-03_050000_trail_running_garmin.gpx",
  );
});

test("API key exchange, activity paging and ZIP download against a mocked Personal API", async () => {
  const zip = buildZip("1_ACTIVITY.fit", buildFit());
  const client = new GarminPersonalApiClient({
    apiKey: " key-1 \n",
    baseUrl: "https://personal.example/",
    fetchImpl: async (url, init = {}) => {
      const target = String(url);
      if (target === "https://personal.example/personalapitoken-service/personal-api/personal-api-key/token") {
        assert.equal(init.method, "POST");
        assert.equal(init.headers.Authorization, "ApiKey key-1");
        return new Response("jwt-1\n");
      }
      assert.equal(init.headers.Authorization, "Bearer jwt-1");
      if (target.includes("/activitylist-service/activities/search/activities")) {
        const params = new URL(target).searchParams;
        assert.equal(params.get("startDate"), "2026-10-15");
        const page = params.get("start") === "0"
          ? [
              { activityId: 2, startTimeLocal: "2026-11-02 21:00:00" },
              { activityId: 1, startTimeLocal: "2026-11-01 21:00:00" },
            ]
          : [{ activityId: 0, startTimeLocal: "2026-10-01 21:00:00" }];
        return Response.json(page);
      }
      if (target.endsWith("/download-service/files/activity/2")) {
        return new Response(zip);
      }
      throw new Error(`unexpected url ${target}`);
    },
  });

  await client.login();
  const activities = await client.fetchActivities({ startDate: "2026-10-15", pageSize: 2 });
  assert.deepEqual(activities.map((a) => a.activityId), [2, 1]);
  assert.deepEqual(await client.downloadFit(2), buildFit());
});

test("rejected API key reports a clear error", async () => {
  const client = new GarminPersonalApiClient({
    apiKey: "bad",
    fetchImpl: async () => new Response("Unauthorized", { status: 401 }),
  });
  await assert.rejects(client.login(), /HTTP 401 \(GARMIN_API_KEY is invalid or expired\)/);
});
