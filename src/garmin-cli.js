import path from "node:path";
import { addDays, argValue, loadDotEnv, localIsoDate } from "./cli.js";
import { GarminConnectClient, garminFileName, parseGarminToken, withHeartRateDesc } from "./garmin.js";
import { writeGpxFiles } from "./write.js";

export async function run(argv = process.argv.slice(2), envVars = process.env) {
  await loadDotEnv(envVars);

  const outDir = path.resolve(argValue(argv, "--out", envVars.OUTPUT_DIR || "out"));
  const timeZone = argValue(argv, "--timezone", envVars.XIAOMI_TIMEZONE || "Asia/Yekaterinburg");
  const lookbackDays = Number(argValue(argv, "--lookback-days", envVars.GARMIN_LOOKBACK_DAYS || "60"));
  const startDate = argValue(argv, "--start-date", addDays(localIsoDate(timeZone), -Math.max(1, lookbackDays)));

  const token = parseGarminToken(envVars.GARMIN_TOKEN);
  if (!token && !(envVars.GARMIN_USERNAME && envVars.GARMIN_PASSWORD)) {
    console.log("Garmin is not configured (no GARMIN_TOKEN or GARMIN_USERNAME/GARMIN_PASSWORD), skipping");
    return { written: 0, skipped: true };
  }

  if (token) {
    console.log(`GARMIN_TOKEN fields: ${Object.keys(token).join(", ")}`);
  }
  const client = new GarminConnectClient({
    username: envVars.GARMIN_USERNAME,
    password: envVars.GARMIN_PASSWORD,
    token,
  });
  await client.login();

  const activities = await client.fetchActivities({ startDate });
  const files = [];
  let skipped = 0;
  for (const activity of activities) {
    if (activity.hasPolyline === false || activity.startLatitude == null) {
      console.log(`Skipped (no GPS): ${activity.activityId} [${activity.activityType?.typeKey}] ${activity.startTimeLocal}`);
      skipped += 1;
      continue;
    }
    const name = garminFileName(activity);
    const xml = withHeartRateDesc(await client.downloadGpx(activity.activityId), activity);
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
