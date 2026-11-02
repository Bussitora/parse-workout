import zlib from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

// Minimal reader for Garmin's download ZIP: uses the central directory, so entries
// written with data descriptors (sizes zero in the local header) still work.
export function extractFirstFile(zip, namePattern = /./) {
  let eocd = -1;
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 22 - 0xffff); offset -= 1) {
    if (zip.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd === -1) {
    throw new Error("ZIP end of central directory not found");
  }

  const entries = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  for (let index = 0; index < entries; index += 1) {
    if (zip.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error("Corrupt ZIP central directory");
    }
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;

    if (!namePattern.test(name)) {
      continue;
    }
    if (zip.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`Corrupt ZIP local header for ${name}`);
    }
    const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    const data = zip.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) {
      return Buffer.from(data);
    }
    if (method === 8) {
      return zlib.inflateRawSync(data);
    }
    throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
  }
  throw new Error("No matching file in ZIP");
}
