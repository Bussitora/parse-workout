import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mergeWorkouts, parseSportRecords, parseWorkoutRecord } from "../src/parse.js";
import { loadExistingWorkouts, writeWorkouts } from "../src/write.js";
import { apiWindow } from "../src/xiaomi.js";

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
  assert.equal(workouts[0].metrics.avg_speed, 2.78);
});

test("skips records without a parseable payload", () => {
  assert.equal(parseWorkoutRecord({ sid: "x", key: "run", value: "not-json" }), null);
  assert.deepEqual(parseSportRecords([{ sid: "x", key: "run", value: "not-json" }]), []);
});

test("merges workouts by id and keeps the latest copy", () => {
  const merged = mergeWorkouts(
    [{ id: "a", start: "2026-01-01T00:00:00.000Z", caloriesKcal: 1 }],
    [
      { id: "a", start: "2026-01-01T00:00:00.000Z", caloriesKcal: 2 },
      { id: "b", start: "2026-01-02T00:00:00.000Z", caloriesKcal: 3 },
    ],
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].caloriesKcal, 2);
  assert.equal(merged[1].id, "b");
});

test("apiWindow uses timezone midnight", () => {
  const [start, end] = apiWindow("2026-09-14", "2026-09-14", "Europe/Moscow");
  assert.equal(start, Date.parse("2026-09-13T21:00:00Z") / 1000);
  assert.equal(end, Date.parse("2026-09-14T21:00:00Z") / 1000);
});

test("writeWorkouts stores index and per-workout files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "parse-workout-"));
  try {
    const workouts = [
      {
        id: "device-1_1743501600_outdoor_running",
        localDate: "2025-04-01",
        start: "2025-04-01T10:00:00.000Z",
        activityType: "outdoor_running",
      },
    ];
    await writeWorkouts(dir, workouts, {
      syncedAt: "2026-09-14T00:00:00.000Z",
      region: "ru",
      timeZone: "Europe/Moscow",
    });
    const loaded = await loadExistingWorkouts(dir);
    assert.equal(loaded.length, 1);
    const saved = JSON.parse(
      await readFile(path.join(dir, "workouts", "2025", "2025-04-01--device-1_1743501600_outdoor_running.json"), "utf8"),
    );
    assert.equal(saved.id, workouts[0].id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
