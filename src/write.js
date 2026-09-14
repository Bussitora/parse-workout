import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gpxFileName } from "./gpx.js";

export async function writeGpxFiles(outDir, files) {
  await mkdir(outDir, { recursive: true });
  const written = [];
  for (const file of files) {
    const filePath = path.join(outDir, file.name);
    await writeFile(filePath, file.xml, "utf8");
    written.push(filePath);
  }
  return written;
}

export { gpxFileName };
