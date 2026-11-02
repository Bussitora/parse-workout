import path from "node:path";
import { addDays, argValue, loadDotEnv, localIsoDate } from "./cli.js";
import { DEFAULT_BASE_URL, GarminPersonalApiClient, fitToGpx, garminFileName } from "./garmin.js";
import { writeGpxFiles } from "./write.js";

export async function run(argv = process.argv.slice(2), envVars = process.env) {
  await loadDotEnv(envVars);

  const outDir = path.resolve(argValue(argv, "--out", envVars.OUTPUT_DIR || "out"));
  const timeZone = argValue(argv, "--timezone", envVars.XIAOMI_TIMEZONE || "Asia/Yekaterinburg");
  const lookbackDays = Number(argValue(argv, "--lookback-days", envVars.GARMIN_LOOKBACK_DAYS || "60"));
  const startDate = argValue(argv, "--start-date", addDays(localIsoDate(timeZone), -Math.max(1, lookbackDays)));

  if (!envVars.GARMIN_API_KEY) {
    console.log("Garmin is not configured (no GARMIN_API_KEY), skipping");
    return { written: 0, skipped: true };
  }

  const client = new GarminPersonalApiClient({
    apiKey: envVars.GARMIN_API_KEY,
    baseUrl: envVars.GARMIN_PERSONAL_API_BASE_URL || DEFAULT_BASE_URL,
  });
  await client.login();

  const activities = await client.fetchActivities({ startDate });
  if (activities[0]) {
    console.log(`Garmin activity fields: ${Object.keys(activities[0]).join(", ")}`);
  }
  const files = [];
  let skipped = 0;
  for (const activity of activities) {
    const label = `${activity.activityId} [${activity.activityType?.typeKey}] ${activity.startTimeLocal}`;
    if (activity.hasPolyline === false) {
      console.log(`Skipped (no GPS): ${label}`);
      skipped += 1;
      continue;
    }
    const xml = fitToGpx(await client.downloadFit(activity.activityId), activity);
    if (!xml) {
      console.log(`Skipped (no GPS points in FIT): ${label}`);
      skipped += 1;
      continue;
    }
    const name = garminFileName(activity);
    console.log(`Track: ${name}`);
    files.push({ name, xml });
  }

  await writeGpxFiles(outDir, files);
  const summary = { startDate, fetched: activities.length, written: files.length, skippedWithoutGps: skipped, outDir };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (process.argv[1] && path.basename(process.argv[1]) === "garmin-cli.js") {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
