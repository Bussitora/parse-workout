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

export async function run(argv = process.argv.slice(2), envVars = process.env) {
  await loadDotEnv(envVars);

  const outDir = path.resolve(argValue(argv, "--out", envVars.OUTPUT_DIR || "out"));
  const timeZone = argValue(argv, "--timezone", envVars.XIAOMI_TIMEZONE || "Asia/Yekaterinburg");
  const preferredRegion = argValue(argv, "--region", envVars.XIAOMI_REGION || "de");
  const lookbackDays = Number(argValue(argv, "--lookback-days", envVars.LOOKBACK_DAYS || "730"));
  const today = new Date().toISOString().slice(0, 10);
  const endDate = argValue(argv, "--end-date", today);
  const startDate = argValue(argv, "--start-date", addDays(endDate, -Math.max(1, lookbackDays)));

  const client = new XiaomiFitnessClient({
    username: envVars.XIAOMI_USERNAME,
    password: envVars.XIAOMI_PASSWORD,
    region: preferredRegion,
    timeZone,
    deviceId: envVars.XIAOMI_DEVICE_ID,
  });

  await client.login();
  const region = await client.discoverRegion(preferredRegion);
  const records = await client.fetchSportRecords({ startDate, endDate, region });
  const workouts = parseSportRecords(records, { timeZone });

  const files = [];
  let skipped = 0;
  for (const workout of workouts) {
    const points = await client.fetchTrackPoints(workout);
    if (!points.length) {
      skipped += 1;
      continue;
    }
    files.push({
      name: gpxFileName(workout),
      xml: renderGpx(workout, points),
    });
  }

  await writeGpxFiles(outDir, files);
  const summary = {
    region,
    startDate,
    endDate,
    fetched: workouts.length,
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
