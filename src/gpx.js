function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function isoUtc(seconds) {
  return new Date(Number(seconds) * 1000).toISOString().replace(/\.000Z$/, "Z");
}

function formatCoord(value) {
  return Number(value).toFixed(7);
}

export function gpxFileName(workout) {
  const datePart = workout.localDate || (workout.start ? workout.start.slice(0, 10) : "unknown-date");
  const timePart = workout.start ? workout.start.slice(11, 19).replaceAll(":", "") : "000000";
  const typePart = String(workout.activityType || "workout").replaceAll(/[^\w.-]+/g, "_");
  return `${datePart}_${timePart}_${typePart}.gpx`;
}

export function renderGpx(workout, points) {
  if (!points?.length) {
    throw new Error("GPX export requires GPS track points");
  }

  const name = escapeXml(workout.activityType || "workout");
  const start = isoUtc(points[0].timestamp);
  const trackPoints = points
    .filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude))
    .map((point) => {
      const elevation =
        point.altitude === null || point.altitude === undefined ? "" : `\n        <ele>${Number(point.altitude)}</ele>`;
      let extensions = "";
      if (point.heartRate != null || point.cadence != null) {
        const hr =
          point.heartRate == null ? "" : `\n            <gpxtpx:hr>${Math.round(point.heartRate)}</gpxtpx:hr>`;
        const cad =
          point.cadence == null ? "" : `\n            <gpxtpx:cad>${Math.round(point.cadence)}</gpxtpx:cad>`;
        extensions = `
        <extensions>
          <gpxtpx:TrackPointExtension>${hr}${cad}
          </gpxtpx:TrackPointExtension>
        </extensions>`;
      }
      return `      <trkpt lat="${formatCoord(point.latitude)}" lon="${formatCoord(point.longitude)}">${elevation}
        <time>${isoUtc(point.timestamp)}</time>${extensions}
      </trkpt>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="parse-workout"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${name}</name>
    <time>${start}</time>
  </metadata>
  <trk>
    <name>${name}</name>
    <type>${name}</type>
    <trkseg>
${trackPoints}
    </trkseg>
  </trk>
</gpx>
`;
}
