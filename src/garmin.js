// Garmin Connect Personal API (official, read-only): a personal API key from
// Garmin Connect → Settings → Personal API is exchanged for a short-lived JWT.
// Endpoints follow Garmin's reference client github.com/garmin/connect-personal-api-python.
import { renderGpx } from "./gpx.js";
import { parseFitRecords } from "./fit.js";
import { extractFirstFile } from "./zip.js";

export const DEFAULT_BASE_URL = "https://personal.connectapi.garmin.com";
const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";

// Garmin activity types that map onto the names Xiaomi files already use.
const TYPE_ALIASES = {
  running: "outdoor_running",
  street_running: "outdoor_running",
  walking: "outdoor_walking",
  cycling: "outdoor_cycling",
  road_biking: "outdoor_cycling",
};

export class GarminError extends Error {}

// Status, headers and the start of the body, for diagnosing Garmin/Cloudflare rejections.
async function describeResponse(response) {
  const headers = [...response.headers.entries()]
    .filter(([name]) => !["set-cookie", "date", "report-to", "nel"].includes(name))
    .map(([name, value]) => `  ${name}: ${value}`)
    .join("\n");
  let body = "";
  try {
    body = (await response.clone().text()).replaceAll(/\s+/g, " ").slice(0, 800);
  } catch {
    body = "(unreadable)";
  }
  return `Garmin HTTP ${response.status} ${response.url || ""}\n${headers}\n  body: ${body}`;
}

export function garminActivityType(activity) {
  const typeKey = String(activity.activityType?.typeKey || "workout");
  return (TYPE_ALIASES[typeKey] ?? typeKey).replaceAll(/[^\w.-]+/g, "_");
}

export function garminFileName(activity) {
  const local = String(activity.startTimeLocal || activity.startTimeGMT || "");
  const gmt = String(activity.startTimeGMT || activity.startTimeLocal || "");
  const datePart = local.slice(0, 10) || "unknown-date";
  const timePart = gmt.slice(11, 19).replaceAll(":", "") || "000000";
  return `${datePart}_${timePart}_${garminActivityType(activity)}_garmin.gpx`;
}

// FIT cadence for running is strides per minute; Xiaomi files carry steps per minute.
export function fitToGpx(fitBuffer, activity) {
  const running = String(activity.activityType?.typeKey || "").includes("running");
  const points = parseFitRecords(fitBuffer)
    .filter((record) => record.latitude != null && record.longitude != null && record.timestamp != null)
    .map((record) => ({
      latitude: record.latitude,
      longitude: record.longitude,
      altitude: record.altitude,
      timestamp: record.timestamp,
      heartRate: record.heartRate,
      cadence: record.cadence == null ? null : running ? record.cadence * 2 : record.cadence,
    }));
  if (!points.length) {
    return null;
  }
  const heartRate = {
    avg: activity.averageHR ? Math.round(activity.averageHR) : null,
    max: activity.maxHR ? Math.round(activity.maxHR) : null,
  };
  return renderGpx({ activityType: garminActivityType(activity), heartRate }, points);
}

export class GarminPersonalApiClient {
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch } = {}) {
    if (!apiKey) {
      throw new GarminError("GARMIN_API_KEY is not set");
    }
    this.apiKey = String(apiKey).trim();
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetch = fetchImpl;
    this.accessToken = null;
  }

  async login() {
    const response = await this.fetch(`${this.baseUrl}${TOKEN_PATH}`, {
      method: "POST",
      headers: { Accept: "*/*", Authorization: `ApiKey ${this.apiKey}` },
    });
    if (!response.ok) {
      console.log(await describeResponse(response));
      const hint = response.status === 401 || response.status === 403 ? " (GARMIN_API_KEY is invalid or expired)" : "";
      throw new GarminError(`Garmin token request failed: HTTP ${response.status}${hint}`);
    }
    this.accessToken = (await response.text()).trim();
  }

  async api(pathAndQuery, accept = "application/json") {
    const response = await this.fetch(`${this.baseUrl}${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${this.accessToken}`, Accept: accept },
    });
    if (!response.ok) {
      console.log(await describeResponse(response));
      throw new GarminError(`Garmin API ${pathAndQuery.split("?")[0]}: HTTP ${response.status}`);
    }
    return response;
  }

  // Activities newest first, stopping once they are older than startDate (YYYY-MM-DD, local).
  async fetchActivities({ startDate, pageSize = 100 } = {}) {
    const activities = [];
    for (let start = 0; ; start += pageSize) {
      const query = new URLSearchParams({ start: String(start), limit: String(pageSize) });
      if (startDate) {
        query.set("startDate", startDate);
      }
      const page = await (await this.api(`/activitylist-service/activities/search/activities?${query}`)).json();
      for (const activity of page) {
        if (startDate && String(activity.startTimeLocal).slice(0, 10) < startDate) {
          return activities;
        }
        activities.push(activity);
      }
      if (page.length < pageSize) {
        return activities;
      }
    }
  }

  // The original file: a ZIP holding the FIT (a bare FIT is accepted too).
  async downloadFit(activityId) {
    const response = await this.api(`/download-service/files/activity/${activityId}`, "*/*");
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.subarray(0, 2).toString("latin1") === "PK" ? extractFirstFile(bytes, /\.fit$/i) : bytes;
  }
}
