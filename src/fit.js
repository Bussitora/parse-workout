// Minimal FIT decoder: only "record" messages (GPS, altitude, HR, cadence per second).
// Spec: developer.garmin.com/fit/protocol

const FIT_EPOCH_OFFSET = 631065600; // 1989-12-31T00:00:00Z in Unix seconds
const SEMICIRCLE_TO_DEG = 180 / 2 ** 31;
const RECORD_MESSAGE = 20;

const FIELD = {
  timestamp: 253,
  latitude: 0,
  longitude: 1,
  altitude: 2,
  heartRate: 3,
  cadence: 4,
  enhancedAltitude: 78,
};

// Base types by low 5 bits: [byte size, signed, invalid value].
const BASE_TYPES = {
  0x00: [1, false, 0xff], // enum
  0x01: [1, true, 0x7f], // sint8
  0x02: [1, false, 0xff], // uint8
  0x03: [2, true, 0x7fff], // sint16
  0x04: [2, false, 0xffff], // uint16
  0x05: [4, true, 0x7fffffff], // sint32
  0x06: [4, false, 0xffffffff], // uint32
  0x0a: [1, false, 0x00], // uint8z
  0x0b: [2, false, 0x0000], // uint16z
  0x0c: [4, false, 0x00000000], // uint32z
  0x0d: [1, false, 0xff], // byte
};

function readScalar(buffer, offset, size, baseType, littleEndian) {
  const type = BASE_TYPES[baseType & 0x1f];
  if (!type || type[0] !== size) {
    return null;
  }
  const [, signed, invalid] = type;
  let value;
  if (size === 1) {
    value = signed ? buffer.readInt8(offset) : buffer.readUInt8(offset);
  } else if (size === 2) {
    value = signed
      ? littleEndian ? buffer.readInt16LE(offset) : buffer.readInt16BE(offset)
      : littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  } else {
    value = signed
      ? littleEndian ? buffer.readInt32LE(offset) : buffer.readInt32BE(offset)
      : littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  }
  return value === invalid ? null : value;
}

function toRecord(fields) {
  const altitudeRaw = fields.get(FIELD.enhancedAltitude) ?? fields.get(FIELD.altitude);
  const latitude = fields.get(FIELD.latitude);
  const longitude = fields.get(FIELD.longitude);
  const timestamp = fields.get(FIELD.timestamp);
  return {
    timestamp: timestamp == null ? null : timestamp + FIT_EPOCH_OFFSET,
    latitude: latitude == null ? null : latitude * SEMICIRCLE_TO_DEG,
    longitude: longitude == null ? null : longitude * SEMICIRCLE_TO_DEG,
    altitude: altitudeRaw == null ? null : Math.round((altitudeRaw / 5 - 500) * 10) / 10,
    heartRate: fields.get(FIELD.heartRate) ?? null,
    cadence: fields.get(FIELD.cadence) ?? null,
  };
}

export function parseFitRecords(buffer) {
  if (buffer.length < 12 || buffer.subarray(8, 12).toString("latin1") !== ".FIT") {
    throw new Error("Not a FIT file");
  }
  const headerSize = buffer.readUInt8(0);
  const end = Math.min(buffer.length, headerSize + buffer.readUInt32LE(4));
  const definitions = new Map();
  const records = [];
  let lastTimestamp = null;
  let offset = headerSize;

  while (offset < end) {
    const header = buffer.readUInt8(offset);
    offset += 1;

    if (header & 0x80) {
      // Compressed timestamp header: data message with a 5-bit time offset.
      const definition = definitions.get((header >> 5) & 0x03);
      if (!definition) {
        throw new Error("FIT data message without definition");
      }
      const fields = readFields(buffer, offset, definition);
      offset += definition.size;
      if (lastTimestamp != null) {
        const timeOffset = header & 0x1f;
        lastTimestamp += (timeOffset - (lastTimestamp & 0x1f)) & 0x1f;
        fields.set(FIELD.timestamp, lastTimestamp);
      }
      if (definition.globalMessage === RECORD_MESSAGE) {
        records.push(toRecord(fields));
      }
      continue;
    }

    const localType = header & 0x0f;
    if (header & 0x40) {
      const littleEndian = buffer.readUInt8(offset + 1) === 0;
      const globalMessage = littleEndian ? buffer.readUInt16LE(offset + 2) : buffer.readUInt16BE(offset + 2);
      const fieldCount = buffer.readUInt8(offset + 4);
      offset += 5;
      const fields = [];
      let size = 0;
      for (let index = 0; index < fieldCount; index += 1) {
        const field = {
          number: buffer.readUInt8(offset),
          size: buffer.readUInt8(offset + 1),
          baseType: buffer.readUInt8(offset + 2),
        };
        fields.push(field);
        size += field.size;
        offset += 3;
      }
      if (header & 0x20) {
        const devFieldCount = buffer.readUInt8(offset);
        offset += 1;
        for (let index = 0; index < devFieldCount; index += 1) {
          size += buffer.readUInt8(offset + 1);
          offset += 3;
        }
      }
      definitions.set(localType, { globalMessage, littleEndian, fields, size });
      continue;
    }

    const definition = definitions.get(localType);
    if (!definition) {
      throw new Error("FIT data message without definition");
    }
    const fields = readFields(buffer, offset, definition);
    offset += definition.size;
    if (fields.get(FIELD.timestamp) != null) {
      lastTimestamp = fields.get(FIELD.timestamp);
    }
    if (definition.globalMessage === RECORD_MESSAGE) {
      records.push(toRecord(fields));
    }
  }
  return records;
}

function readFields(buffer, offset, definition) {
  const values = new Map();
  let position = offset;
  for (const field of definition.fields) {
    const value = readScalar(buffer, position, field.size, field.baseType, definition.littleEndian);
    if (value != null) {
      values.set(field.number, value);
    }
    position += field.size;
  }
  // Developer fields trail the regular ones and are skipped via definition.size.
  return values;
}
