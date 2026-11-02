import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gpxStartMs, planPublish, publish } from "../src/publish.js";

const gpx = (time) => `<gpx><metadata><time>${time}</time></metadata></gpx>`;

test("start time is read from the first <time> element", () => {
  assert.equal(gpxStartMs(gpx("2026-11-03T11:40:54Z")), Date.parse("2026-11-03T11:40:54Z"));
  assert.equal(gpxStartMs("<gpx/>"), null);
});

test("Garmin file shadows a Xiaomi file started within the window", () => {
  const t = Date.parse("2026-11-03T11:40:00Z");
  const plan = planPublish([
    { name: "2026-11-03_114054_outdoor_running.gpx", start: t + 54_000, inRepo: true, inOut: true },
    { name: "2026-11-03_114000_outdoor_running_garmin.gpx", start: t, inRepo: false, inOut: true },
    { name: "2026-11-01_120000_outdoor_running.gpx", start: t - 2 * 86_400_000, inRepo: false, inOut: true },
    { name: "2026-11-03_115000_outdoor_running.gpx", start: t + 10 * 60_000, inRepo: false, inOut: true },
  ]);
  assert.deepEqual(plan.copy, [
    "2026-11-01_120000_outdoor_running.gpx",
    "2026-11-03_114000_outdoor_running_garmin.gpx",
    "2026-11-03_115000_outdoor_running.gpx",
  ]);
  assert.deepEqual(plan.remove, ["2026-11-03_114054_outdoor_running.gpx"]);
});

test("publish copies new files and removes the published Xiaomi duplicate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "publish-"));
  const out = path.join(root, "out");
  const repo = path.join(root, "repo");
  await mkdir(out);
  await mkdir(repo);
  await writeFile(path.join(repo, "2026-11-03_114054_outdoor_running.gpx"), gpx("2026-11-03T11:40:54Z"));
  await writeFile(path.join(repo, "README.md"), "# workout");
  await writeFile(path.join(out, "2026-11-03_114054_outdoor_running.gpx"), gpx("2026-11-03T11:40:54Z"));
  await writeFile(path.join(out, "2026-11-03_114030_outdoor_running_garmin.gpx"), gpx("2026-11-03T11:40:30Z"));

  await publish(out, repo);
  assert.deepEqual((await readdir(repo)).sort(), ["2026-11-03_114030_outdoor_running_garmin.gpx", "README.md"]);
});

test("publish tolerates a missing out dir", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "publish-"));
  await mkdir(path.join(root, "repo"));
  const plan = await publish(path.join(root, "out"), path.join(root, "repo"));
  assert.deepEqual(plan, { copy: [], remove: [] });
});
