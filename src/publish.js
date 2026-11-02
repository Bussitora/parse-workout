// Copies GPX files from the output dir into the workout repo checkout.
// When the same run was recorded by Garmin and Xiaomi, the Garmin file wins:
// the Xiaomi copy is not written, and an already published one is removed.
import { copyFile, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

export const DUPLICATE_WINDOW_MS = 3 * 60 * 1000;

export function gpxStartMs(xml) {
  const time = String(xml).match(/<time>([^<]+)<\/time>/)?.[1];
  const ms = time ? Date.parse(time) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

export function isGarminFile(name) {
  return name.endsWith("_garmin.gpx");
}

// files: [{ name, start, inRepo, inOut }] → which names to copy from out and which to delete from the repo
export function planPublish(files, windowMs = DUPLICATE_WINDOW_MS) {
  const garminStarts = files.filter((f) => isGarminFile(f.name) && f.start != null).map((f) => f.start);
  const shadowed = (file) =>
    !isGarminFile(file.name) &&
    file.start != null &&
    garminStarts.some((start) => Math.abs(start - file.start) <= windowMs);

  const copy = [];
  const remove = [];
  for (const file of files) {
    if (shadowed(file)) {
      if (file.inRepo) {
        remove.push(file.name);
      }
    } else if (file.inOut) {
      copy.push(file.name);
    }
  }
  return { copy: copy.sort(), remove: remove.sort() };
}

async function listGpx(dir) {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".gpx"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function publish(outDir, repoDir) {
  const byName = new Map();
  for (const [dir, flag] of [[repoDir, "inRepo"], [outDir, "inOut"]]) {
    for (const name of await listGpx(dir)) {
      const entry = byName.get(name) ?? { name, start: null, inRepo: false, inOut: false };
      entry[flag] = true;
      // Read the start once, preferring the fresh copy from out/.
      if (entry.start == null || flag === "inOut") {
        entry.start = gpxStartMs(await readFile(path.join(dir, name), "utf8"));
      }
      byName.set(name, entry);
    }
  }

  const plan = planPublish([...byName.values()]);
  for (const name of plan.copy) {
    await copyFile(path.join(outDir, name), path.join(repoDir, name));
  }
  for (const name of plan.remove) {
    console.log(`Removing Xiaomi duplicate of a Garmin workout: ${name}`);
    await rm(path.join(repoDir, name));
  }
  console.log(JSON.stringify({ copied: plan.copy.length, removedDuplicates: plan.remove.length }));
  return plan;
}

if (process.argv[1] && path.basename(process.argv[1]) === "publish.js") {
  const [outDir = "out", repoDir = "workout-repo"] = process.argv.slice(2);
  publish(path.resolve(outDir), path.resolve(repoDir)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
