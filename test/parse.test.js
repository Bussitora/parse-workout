import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseSportRecords, parseWorkoutRecord } from "../src/parse.js";
import { writeGpxFiles } from "../src/write.js";
import { apiWindow } from "../src/xiaomi.js";
import { renderGpx } from "../src/gpx.js";

const fixturePath = fileURLToPath(new URL("./fixtures/sport-records.json", import.meta.url));

test("parses Xiaomi sport records into normalized workouts", async () => {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const workouts = parseSportRecords(fixture.sport_records, { timeZone: "Europe/Moscow" });
  assert.equal(workouts.length, 1);
  assert.equal(workouts[0].id, "device-1_1743501600_outdoor_running");
  assert.equal(workouts[0].activityType, "outdoor_running");
  assert.equal(workouts[0].durationSec, 3600);
  assert.equal(workouts[0].distanceM, 10000);
  assert.equal(workouts[0].heartRate.avg, 152);
  assert.equal(workouts[0].localDate, "2025-04-01");
});

test("skips records without a parseable payload", () => {
  assert.equal(parseWorkoutRecord({ sid: "x", key: "run", value: "not-json" }), null);
  assert.deepEqual(parseSportRecords([{ sid: "x", key: "run", value: "not-json" }]), []);
});

test("apiWindow uses timezone midnight", () => {
  const [start, end] = apiWindow("2026-09-14", "2026-09-14", "Europe/Moscow");
  assert.equal(start, Date.parse("2026-09-13T21:00:00Z") / 1000);
  assert.equal(end, Date.parse("2026-09-14T21:00:00Z") / 1000);
});

test("writeGpxFiles stores only GPX", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "parse-workout-"));
  try {
    const xml = renderGpx(
      { activityType: "outdoor_running" },
      [{ timestamp: 1743501600, latitude: 55.7, longitude: 37.5 }],
    );
    await writeGpxFiles(dir, [{ name: "run.gpx", xml }]);
    const saved = await readFile(path.join(dir, "run.gpx"), "utf8");
    assert.match(saved, /<gpx /);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
