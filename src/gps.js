const GPS_VALIDITY = { 1: 1, 2: 1, 3: 1, 4: 1 };
const GPS_TYPE_TIME = 0;
const GPS_TYPE_LONGITUDE = 1;
const GPS_TYPE_LATITUDE = 2;
const GPS_TYPE_ACCURACY = 3;
const GPS_TYPE_SPEED = 4;
const GPS_TYPE_ALTITUDE = 6;
const GPS_TYPE_HDOP = 7;
const GPS_FLOAT_TYPES = new Set([GPS_TYPE_LONGITUDE, GPS_TYPE_LATITUDE, GPS_TYPE_ACCURACY, GPS_TYPE_ALTITUDE, GPS_TYPE_HDOP]);
const GPS_TYPES = [
  { typeId: GPS_TYPE_TIME, byteCount: 4, supportVersion: 1 },
  { typeId: GPS_TYPE_LONGITUDE, byteCount: 4, supportVersion: 1 },
  { typeId: GPS_TYPE_LATITUDE, byteCount: 4, supportVersion: 1 },
  { typeId: GPS_TYPE_ACCURACY, byteCount: 4, supportVersion: 2 },
  { typeId: GPS_TYPE_SPEED, byteCount: 2, supportVersion: 2 },
  { typeId: 5, byteCount: 0, supportVersion: 2 },
  { typeId: GPS_TYPE_ALTITUDE, byteCount: 4, supportVersion: 3 },
  { typeId: GPS_TYPE_HDOP, byteCount: 4, supportVersion: 3 },
];

function readUint(buffer, offset, size) {
  if (size === 1) {
    return [buffer[offset], offset + 1];
  }
  if (size === 2) {
    return [buffer.readUInt16LE(offset), offset + 2];
  }
  if (size === 4) {
    return [buffer.readUInt32LE(offset), offset + 4];
  }
  throw new Error(`Unsupported GPS integer size ${size}`);
}

function parseValidMap(version, dataValid) {
  const validMap = new Map();
  let bitIndex = 0;
  for (const dataType of GPS_TYPES) {
    if (dataType.typeId < 0) {
      continue;
    }
    if (dataType.supportVersion > version) {
      validMap.set(dataType.typeId, false);
      continue;
    }
    if (!dataValid.length) {
      validMap.set(dataType.typeId, true);
      continue;
    }
    const byteIndex = Math.floor(bitIndex / 8);
    const bit = bitIndex % 8;
    validMap.set(dataType.typeId, Boolean(dataValid[byteIndex] & (1 << (7 - bit))));
    bitIndex += 1;
  }
  return validMap;
}

function minRecordBytes(version) {
  return GPS_TYPES.filter((type) => type.supportVersion <= version && type.byteCount > 0).reduce(
    (sum, type) => sum + type.byteCount,
    0,
  );
}

function readField(buffer, offset, dataType) {
  if (dataType.byteCount === 0) {
    return [0, offset];
  }
  if (GPS_FLOAT_TYPES.has(dataType.typeId) && dataType.byteCount === 4) {
    return [buffer.readFloatLE(offset), offset + 4];
  }
  return readUint(buffer, offset, dataType.byteCount);
}

export function parseGpsRecord(decrypted) {
  if (decrypted.length < 8) {
    return [];
  }
  const version = decrypted[5];
  const validLen = GPS_VALIDITY[version];
  if (!validLen) {
    return [];
  }
  const headerLen = 8 + validLen;
  if (decrypted.length < headerLen) {
    return [];
  }
  const validMap = parseValidMap(version, decrypted.subarray(8, 8 + validLen));
  if (!validMap.get(GPS_TYPE_TIME) || !validMap.get(GPS_TYPE_LONGITUDE) || !validMap.get(GPS_TYPE_LATITUDE)) {
    return [];
  }

  const body = decrypted.subarray(headerLen);
  let offset = 0;
  let recordCount;
  if (version >= 4) {
    if (body.length < 4) {
      return [];
    }
    [recordCount, offset] = readUint(body, 0, 4);
  } else {
    const size = minRecordBytes(version);
    recordCount = size ? Math.floor(body.length / size) : 0;
  }

  const points = [];
  for (let index = 0; index < recordCount; index += 1) {
    const raw = new Map();
    for (const dataType of GPS_TYPES) {
      if (dataType.supportVersion > version || dataType.byteCount === 0) {
        continue;
      }
      if (offset + dataType.byteCount > body.length) {
        return points;
      }
      let value;
      [value, offset] = readField(body, offset, dataType);
      if (validMap.get(dataType.typeId)) {
        raw.set(dataType.typeId, value);
      }
    }
    const timestamp = raw.get(GPS_TYPE_TIME);
    const longitude = raw.get(GPS_TYPE_LONGITUDE);
    const latitude = raw.get(GPS_TYPE_LATITUDE);
    if (timestamp === undefined || longitude === undefined || latitude === undefined) {
      continue;
    }
    const point = {
      timestamp: Number(timestamp),
      latitude: Number(latitude),
      longitude: Number(longitude),
      altitude: raw.has(GPS_TYPE_ALTITUDE) ? Number(raw.get(GPS_TYPE_ALTITUDE)) : null,
      speed: null,
      heartRate: null,
      cadence: null,
    };
    if (raw.has(GPS_TYPE_SPEED)) {
      const packed = Number(raw.get(GPS_TYPE_SPEED));
      point.speed = ((packed & 0xfff0) >> 4) / 10;
    }
    points.push(point);
  }
  return points;
}

export function packedCoordinateSeries(value) {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  const parts = value.split(",").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) {
    return [];
  }
  const series = [];
  let current = 0;
  for (const part of parts) {
    current += part;
    series.push(current / 100_000_000);
  }
  return series;
}

export function pointsFromPackedCoordinates({ longitude, latitude, altitude, startTime } = {}) {
  const lons = packedCoordinateSeries(longitude);
  const lats = packedCoordinateSeries(latitude);
  const alts = packedCoordinateSeries(altitude);
  const count = Math.min(lons.length, lats.length);
  const points = [];
  for (let index = 0; index < count; index += 1) {
    points.push({
      timestamp: Number(startTime || 0) + index,
      latitude: lats[index],
      longitude: lons[index],
      altitude: alts[index] ?? null,
      speed: null,
      heartRate: null,
      cadence: null,
    });
  }
  return points;
}

export function pointsFromDetailPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const points = [];
  for (const value of Object.values(payload)) {
    if (!Array.isArray(value)) {
      continue;
    }
    for (const item of value) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const latitude = Number(item.latitude);
      const longitude = Number(item.longitude);
      const timestamp = Number(item.timestamp ?? item.time);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(timestamp)) {
        continue;
      }
      points.push({
        timestamp,
        latitude,
        longitude,
        altitude: Number.isFinite(Number(item.altitude)) ? Number(item.altitude) : null,
        speed: Number.isFinite(Number(item.speed ?? item.locationSpeed)) ? Number(item.speed ?? item.locationSpeed) : null,
        heartRate: Number.isFinite(Number(item.hr ?? item.heartRate)) ? Number(item.hr ?? item.heartRate) : null,
        cadence: Number.isFinite(Number(item.cadence)) ? Number(item.cadence) : null,
      });
    }
  }
  points.sort((left, right) => left.timestamp - right.timestamp);
  return points;
}
