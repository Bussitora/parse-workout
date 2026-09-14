const TYPE_HR = 5;
const TYPE_CADENCE = 49;
const TYPE_CALORIES = 2;
const TYPE_INTEGER_KM = 6;
const TYPE_DISTANCE = 9;
const TYPE_STRIDE = 40;
const TYPE_IT_STATE = 41;
const TYPE_LANDING_IMPACT = 44;
const TYPE_TOUCHDOWN_AIR_RATIO = 48;
const TYPE_PACE = 12;
const TYPE_RUNNING_POWER = 57;
const TYPE_IT_TOTAL_DURATION = 78;
const TYPE_HEIGHT_VALUE = 87;
const HEADER_PREFIX = 8;

const STEP_VALID_LEN = { 1: 2, 2: 3, 3: 3, 4: 3, 5: 5, 6: 6, 7: 6, 8: 7, 9: 7 };
const OUTDOOR_VALID_LEN = { 1: 2, 2: 2 };

const STEP_IT = [
  [TYPE_IT_STATE, 1, 1],
  [43, 4, 3],
  [TYPE_IT_TOTAL_DURATION, 4, 7],
  [54, 4, 6],
  [55, 2, 6],
];
const STEP_FIELDS = [
  [TYPE_CALORIES, 1, 1, 4, 4],
  [TYPE_HR, 1, 1],
  [TYPE_HEIGHT_VALUE, 4, 9],
  [TYPE_INTEGER_KM, 2, 9, 15, 1],
  [TYPE_INTEGER_KM, 1, 1, 7, 1],
  [TYPE_DISTANCE, 1, 1],
  [TYPE_STRIDE, 1, 2],
  [TYPE_LANDING_IMPACT, 4, 4, 26, 6],
  [TYPE_TOUCHDOWN_AIR_RATIO, 1, 5],
  [TYPE_CADENCE, 1, 5],
  [TYPE_PACE, 2, 5],
  [56, 2, 6],
  [TYPE_RUNNING_POWER, 2, 6],
  [79, 2, 8],
  [80, 2, 8],
];
const OUTDOOR_IT = [[TYPE_IT_STATE, 1, 2]];
const OUTDOOR_FIELDS = [
  [TYPE_CALORIES, 1, 1, 4, 4],
  [TYPE_HR, 1, 1],
  [TYPE_INTEGER_KM, 1, 1, 7, 1],
  [TYPE_DISTANCE, 1, 1],
];

const SPORT_LAYOUT = {
  1: { validLen: OUTDOOR_VALID_LEN, it: OUTDOOR_IT, fields: OUTDOOR_FIELDS, pauseInit: 4 },
  2: { validLen: OUTDOOR_VALID_LEN, it: OUTDOOR_IT, fields: OUTDOOR_FIELDS, pauseInit: 4 },
  4: { validLen: OUTDOOR_VALID_LEN, it: OUTDOOR_IT, fields: OUTDOOR_FIELDS, pauseInit: 4 },
  5: { validLen: OUTDOOR_VALID_LEN, it: OUTDOOR_IT, fields: OUTDOOR_FIELDS, pauseInit: 4 },
  22: { validLen: STEP_VALID_LEN, it: STEP_IT, fields: STEP_FIELDS, pauseInit: 4 },
};

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
  throw new Error(`Unsupported integer size ${size}`);
}

function fieldSize(field, version) {
  const supportVersion = field[2];
  if (supportVersion > version) {
    return 0;
  }
  return field[1];
}

function itSummaryBytes(types, version) {
  return types.reduce((sum, type) => sum + (type[2] <= version ? type[1] : 0), 0);
}

function parseFourDimenValid(fields, version, dataValid) {
  const validMap = new Map();
  let nibbleIndex = 0;
  for (const field of fields) {
    const typeId = field[0];
    const supportVersion = field[2];
    if (supportVersion > version) {
      validMap.set(typeId, { exist: false, high: false });
      continue;
    }
    const byteIndex = Math.floor(nibbleIndex / 2);
    if (byteIndex >= dataValid.length) {
      validMap.set(typeId, { exist: false, high: false });
      continue;
    }
    const nibble = nibbleIndex % 2 === 0 ? dataValid[byteIndex] >> 4 : dataValid[byteIndex] & 0x0f;
    validMap.set(typeId, { exist: Boolean(nibble & 0x8), high: Boolean(nibble & 0x4) });
    nibbleIndex += 1;
  }
  return validMap;
}

function extractValue(raw, field) {
  const highStart = field[3];
  const highCount = field[4];
  if (highStart == null || highCount == null) {
    return raw;
  }
  return (raw >> highStart) & ((1 << highCount) - 1);
}

export function parseSportSamples(decrypted, sportType) {
  if (!Buffer.isBuffer(decrypted) || decrypted.length < HEADER_PREFIX) {
    return [];
  }
  const layout = SPORT_LAYOUT[Number(sportType)];
  if (!layout) {
    return [];
  }
  const version = decrypted[5];
  const validLen = layout.validLen[version];
  if (!validLen) {
    return [];
  }
  const headerLen = HEADER_PREFIX + validLen;
  if (decrypted.length < headerLen) {
    return [];
  }
  const validMap = parseFourDimenValid(layout.fields, version, decrypted.subarray(HEADER_PREFIX, headerLen));
  const itBytes = itSummaryBytes(layout.it, version);
  const pauseInit = layout.pauseInit;
  const minSegment = pauseInit + 8 + itBytes;
  let offset = headerLen;
  const samples = [];

  while (offset + minSegment <= decrypted.length) {
    offset += pauseInit;
    let recordCount;
    let startTime;
    [recordCount, offset] = readUint(decrypted, offset, 4);
    [startTime, offset] = readUint(decrypted, offset, 4);
    offset += itBytes;
    if (!Number.isFinite(recordCount) || recordCount <= 0 || recordCount > 200_000) {
      break;
    }
    for (let index = 0; index < recordCount; index += 1) {
      const record = {};
      for (const field of layout.fields) {
        const size = fieldSize(field, version);
        if (!size) {
          continue;
        }
        const valid = validMap.get(field[0]);
        if (!valid?.exist) {
          continue;
        }
        if (offset + size > decrypted.length) {
          return samples;
        }
        let raw;
        [raw, offset] = readUint(decrypted, offset, size);
        if (valid.high) {
          record[field[0]] = extractValue(raw, field);
        }
      }
      const heartRate = record[TYPE_HR];
      const cadence = record[TYPE_CADENCE];
      samples.push({
        timestamp: startTime + index,
        heartRate: heartRate > 0 && heartRate < 255 ? heartRate : null,
        cadence: cadence > 0 ? cadence : null,
      });
    }
  }
  return samples;
}

export function mergeSensorSamples(points, samples, maxDeltaSec = 2) {
  if (!points?.length || !samples?.length) {
    return points ?? [];
  }
  const usable = samples.filter((sample) => sample.heartRate || sample.cadence);
  if (!usable.length) {
    return points;
  }
  let sampleIndex = 0;
  return points.map((point) => {
    while (
      sampleIndex + 1 < usable.length &&
      Math.abs(usable[sampleIndex + 1].timestamp - point.timestamp) <= Math.abs(usable[sampleIndex].timestamp - point.timestamp)
    ) {
      sampleIndex += 1;
    }
    const sample = usable[sampleIndex];
    if (!sample || Math.abs(sample.timestamp - point.timestamp) > maxDeltaSec) {
      return point;
    }
    return {
      ...point,
      heartRate: point.heartRate ?? sample.heartRate,
      cadence: point.cadence ?? sample.cadence,
    };
  });
}
