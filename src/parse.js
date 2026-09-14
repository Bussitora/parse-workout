const WORKOUT_METRIC_KEYS = [
  "avg_speed",
  "max_speed",
  "avg_cadence",
  "max_cadence",
  "min_hrm",
  "train_effect",
  "anaerobic_train_effect",
  "train_load",
  "train_load_level",
  "recover_time",
  "vo2_max",
  "rise_height",
  "fall_height",
  "vitality",
  "hrm_warm_up_duration",
  "hrm_fat_burning_duration",
  "hrm_aerobic_duration",
  "hrm_anaerobic_duration",
  "hrm_extreme_duration",
];

function asObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string" || value.trim() === "") {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function asNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asInt(value) {
  const parsed = asNumber(value);
  return parsed === null ? null : Math.round(parsed);
}

function isoFromUnix(seconds) {
  const parsed = asNumber(seconds);
  if (parsed === null) {
    return null;
  }
  return new Date(parsed * 1000).toISOString();
}

function localDateFromUnix(seconds, timeZone, zoneOffset) {
  const parsed = asNumber(seconds);
  if (parsed === null) {
    return null;
  }
  if (zoneOffset !== undefined && zoneOffset !== null && zoneOffset !== "") {
    const shifted = new Date((parsed + Number(zoneOffset)) * 1000);
    if (!Number.isNaN(shifted.getTime())) {
      return shifted.toISOString().slice(0, 10);
    }
  }
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(parsed * 1000));
  } catch {
    return new Date(parsed * 1000).toISOString().slice(0, 10);
  }
}

export function parseWorkoutRecord(record, { timeZone = "UTC" } = {}) {
  const payload = asObject(record?.value);
  const startTs = asInt(payload.start_time ?? record?.time);
  if (startTs === null) {
    return null;
  }
  const endTs = asInt(payload.end_time) ?? startTs;
  const durationSec = asInt(payload.duration) ?? Math.max(0, endTs - startTs);
  const deviceId = record?.sid ? String(record.sid) : null;
  const activityType = String(record?.key || record?.category || "unknown");
  const category = record?.category ? String(record.category) : null;
  const recordTimeZone = record?.zone_name ? String(record.zone_name) : timeZone;
  const metrics = {};
  for (const key of WORKOUT_METRIC_KEYS) {
    if (payload[key] !== undefined && payload[key] !== null) {
      metrics[key] = payload[key];
    }
  }

  return {
    id: `${deviceId ?? "unknown"}_${startTs}_${activityType}`,
    activityType,
    category,
    start: isoFromUnix(startTs),
    end: isoFromUnix(endTs),
    localDate: localDateFromUnix(startTs, recordTimeZone, record?.zone_offset),
    timeZone: recordTimeZone,
    durationSec,
    distanceM: asNumber(payload.distance),
    caloriesKcal: asNumber(payload.calories),
    steps: asInt(payload.steps),
    heartRate: {
      avg: asInt(payload.avg_hrm),
      max: asInt(payload.max_hrm),
      min: asInt(payload.min_hrm),
    },
    paceSecPerKm: {
      avg: asNumber(payload.avg_pace),
      max: asNumber(payload.max_pace),
    },
    deviceId,
    metrics,
  };
}

export function parseSportRecords(records, options) {
  const workouts = [];
  const seen = new Set();
  for (const record of records ?? []) {
    const workout = parseWorkoutRecord(record, options);
    if (!workout?.start || seen.has(workout.id)) {
      continue;
    }
    seen.add(workout.id);
    workouts.push(workout);
  }
  workouts.sort((left, right) => String(left.start).localeCompare(String(right.start)));
  return workouts;
}

export function mergeWorkouts(existing, incoming) {
  const byId = new Map();
  for (const workout of [...(existing ?? []), ...(incoming ?? [])]) {
    if (workout?.id) {
      byId.set(workout.id, workout);
    }
  }
  return [...byId.values()].sort((left, right) => String(left.start).localeCompare(String(right.start)));
}
