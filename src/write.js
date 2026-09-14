import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export async function loadExistingWorkouts(outDir) {
  const document = await readJson(path.join(outDir, "workouts.json"), null);
  if (Array.isArray(document)) {
    return document;
  }
  if (document && Array.isArray(document.workouts)) {
    return document.workouts;
  }
  return [];
}

function workoutFileName(workout) {
  const datePart = workout.localDate || (workout.start ? workout.start.slice(0, 10) : "unknown-date");
  const safeId = String(workout.id).replaceAll(/[^\w.-]+/g, "_");
  return path.join(datePart.slice(0, 4), `${datePart}--${safeId}.json`);
}

export async function writeWorkouts(outDir, workouts, meta) {
  await mkdir(outDir, { recursive: true });
  const workoutsDir = path.join(outDir, "workouts");
  await rm(workoutsDir, { recursive: true, force: true });

  const document = {
    source: "xiaomi-fitness",
    syncedAt: meta.syncedAt,
    region: meta.region,
    timeZone: meta.timeZone,
    count: workouts.length,
    workouts,
  };
  await writeFile(path.join(outDir, "workouts.json"), `${JSON.stringify(document, null, 2)}\n`, "utf8");

  for (const workout of workouts) {
    const relative = workoutFileName(workout);
    const filePath = path.join(workoutsDir, relative);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(workout, null, 2)}\n`, "utf8");
  }

  return document;
}
