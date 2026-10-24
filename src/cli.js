import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderGpx, gpxFileName } from "./gpx.js";
import { parseSportRecords } from "./parse.js";
import { writeGpxFiles } from "./write.js";
import { XiaomiFitnessClient } from "./xiaomi.js";

const rootDir = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

function argValue(args, name, fallback = "") {
  const index = args.indexOf(name);
  if (index === -1 || index === args.length - 1) {
    return fallback;
  }
  return args[index + 1];
}

function addDays(isoDate, days) {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

async function loadDotEnv(envVars) {
  try {
    const text = await readFile(path.join(rootDir, ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const separator = trimmed.indexOf("=");
      if (separator === -1) {
        continue;
      }
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (key && !envVars[key]) {
        envVars[key] = value;
      }
    }
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      throw error;
    }
  }
}

function localIsoDate(timeZone, now = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export async function run(argv = process.argv.slice(2), envVars = process.env) {
  await loadDotEnv(envVars);

  const outDir = path.resolve(argValue(argv, "--out", envVars.OUTPUT_DIR || "out"));
  const timeZone = argValue(argv, "--timezone", envVars.XIAOMI_TIMEZONE || "Asia/Yekaterinburg");
  const regionArg = argValue(argv, "--region", envVars.XIAOMI_REGION || "de");
  const lookbackDays = Number(argValue(argv, "--lookback-days", envVars.LOOKBACK_DAYS || "730"));
  const today = localIsoDate(timeZone);
  const defaultEndDate = addDays(today, 1);
  const endDate = argValue(argv, "--end-date", envVars.END_DATE || defaultEndDate);
  const startDate = argValue(argv, "--start-date", envVars.START_DATE || addDays(today, -Math.max(1, lookbackDays)));

  const regionsToQuery = regionArg === "all"
    ? ["de", "ru", "cn", "sg", "us", "i2"]
    : regionArg.split(",").map((r) => r.trim().toLowerCase()).filter(Boolean);

  const initialRegion = regionsToQuery[0] || "de";
  const client = new XiaomiFitnessClient({
    username: envVars.XIAOMI_USERNAME,
    password: envVars.XIAOMI_PASSWORD,
    userId: envVars.XIAOMI_USER_ID,
    passToken: envVars.XIAOMI_PASS_TOKEN,
    region: initialRegion,
    timeZone,
    deviceId: envVars.XIAOMI_DEVICE_ID,
  });

  await client.login();

  const allWorkouts = [];
  const queriedRegions = [];

  for (const targetRegion of regionsToQuery) {
    try {
      console.log(`Checking region: ${targetRegion}...`);
      const region = await client.discoverRegion(targetRegion);
      const records = await client.fetchSportRecords({ startDate, endDate, region });
      const regionWorkouts = parseSportRecords(records, { timeZone });
      for (const w of regionWorkouts) {
        w.region = region;
      }
      console.log(`Region ${region}: found ${regionWorkouts.length} sport records`);
      allWorkouts.push(...regionWorkouts);
      queriedRegions.push(region);
    } catch (error) {
      console.log(`Region ${targetRegion} error or unavailable: ${error.message}`);
    }
  }

  // Deduplicate workouts across regions
  const workoutsMap = new Map();
  for (const w of allWorkouts) {
    const key = gpxFileName(w);
    if (!workoutsMap.has(key)) {
      workoutsMap.set(key, w);
    }
  }
  const workouts = [...workoutsMap.values()].sort((a, b) => String(a.start).localeCompare(String(b.start)));

  const files = [];
  let skipped = 0;
  for (const workout of workouts) {
    if (workout.region) {
      client.region = workout.region;
    }
    const points = await client.fetchTrackPoints(workout);
    if (!points.length) {
      console.log(`Skipped (no GPS points): ${workout.id || workout.key} [${workout.activityType}] start: ${workout.start}`);
      skipped += 1;
      continue;
    }
    const fileName = gpxFileName(workout);
    console.log(`Track: ${fileName} (${points.length} points)`);
    files.push({
      name: fileName,
      xml: renderGpx(workout, points),
    });
  }

  await writeGpxFiles(outDir, files);
  const summary = {
    regions: queriedRegions,
    startDate,
    endDate,
    fetched: allWorkouts.length,
    unique: workouts.length,
    written: files.length,
    skippedWithoutGps: skipped,
    outDir,
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (process.argv[1] && path.basename(process.argv[1]) === "cli.js") {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
