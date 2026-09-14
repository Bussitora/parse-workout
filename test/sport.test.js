import assert from "node:assert/strict";
import test from "node:test";
import { mergeSensorSamples, parseSportSamples } from "../src/sport.js";

function buildOutdoorRunV8({ startTime, heartRates, cadences = [] }) {
  const header = Buffer.alloc(15);
  header.writeUInt32LE(startTime, 0);
  header[4] = 20;
  header[5] = 8;
  header[6] = 22;
  header.fill(0xcc, 8);
  const pause = Buffer.alloc(4);
  const meta = Buffer.alloc(8);
  meta.writeUInt32LE(heartRates.length, 0);
  meta.writeUInt32LE(startTime, 4);
  const it = Buffer.alloc(15);
  const records = Buffer.alloc(heartRates.length * 21);
  for (let index = 0; index < heartRates.length; index += 1) {
    const offset = index * 21;
    records[offset + 1] = heartRates[index];
    records[offset + 10] = cadences[index] || 0;
  }
  return Buffer.concat([header, pause, meta, it, records]);
}

test("parses outdoor running heart rate and cadence samples", () => {
  const decrypted = buildOutdoorRunV8({
    startTime: 1_000,
    heartRates: [0, 148, 152],
    cadences: [0, 168, 170],
  });
  const samples = parseSportSamples(decrypted, 22);
  assert.equal(samples.length, 3);
  assert.deepEqual(
    samples.map((sample) => sample.heartRate),
    [null, 148, 152],
  );
  assert.equal(samples[2].cadence, 170);
  assert.equal(samples[2].timestamp, 1_002);
});

test("merges heart rate onto GPS points by timestamp", () => {
  const points = [
    { timestamp: 1000, latitude: 1, longitude: 2, heartRate: null, cadence: null },
    { timestamp: 1001, latitude: 1.1, longitude: 2.1, heartRate: null, cadence: null },
  ];
  const merged = mergeSensorSamples(points, [
    { timestamp: 1000, heartRate: 140, cadence: 160 },
    { timestamp: 1001, heartRate: 145, cadence: 162 },
  ]);
  assert.equal(merged[0].heartRate, 140);
  assert.equal(merged[1].cadence, 162);
});
