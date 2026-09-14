import { createHash } from "node:crypto";
import {
  clientSign,
  decryptFdsData,
  decryptResponse,
  deviceIdFromUsername,
  generateNonce,
  md5Upper,
  serializeEncryptedForm,
  buildFdsSuffix,
} from "./crypto.js";
import { parseGpsRecord, pointsFromDetailPayload, pointsFromPackedCoordinates } from "./gps.js";

const LOGIN_PREFIX = "&&&START&&&";
const KNOWN_REGIONS = ["ru", "cn", "de", "i2", "sg", "us"];
const ACCOUNT_BASE = "https://account.xiaomi.com";
const LOGIN_URL = `${ACCOUNT_BASE}/pass/serviceLogin?sid=miothealth&_json=true`;
const LOGIN_AUTH_URL = `${ACCOUNT_BASE}/pass/serviceLoginAuth2`;
const USER_AGENT = "Dalvik/2.1.0 (Linux; U; Android 13) APP/mi.health parse-workout/1.0";
const FDS_GPS_FILE_TYPE = 2;

export class XiaomiError extends Error {}
export class AuthenticationError extends XiaomiError {}
export class ProtocolError extends XiaomiError {}
export class RegionError extends XiaomiError {}

function cookieHeader(jar) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function storeCookies(jar, response) {
  const cookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
  for (const cookie of cookies) {
    const pair = String(cookie).split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator > 0) {
      jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }
}

function parseLoginPayload(text) {
  const body = text.startsWith(LOGIN_PREFIX) ? text.slice(LOGIN_PREFIX.length) : text;
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") {
      throw new ProtocolError("Xiaomi login response is not an object");
    }
    return parsed;
  } catch (error) {
    if (error instanceof ProtocolError) {
      throw error;
    }
    throw new ProtocolError("Xiaomi login response is not JSON");
  }
}

export function regionBaseUrl(region) {
  const normalized = String(region || "ru").trim().toLowerCase();
  if (normalized === "" || normalized === "cn") {
    return "https://hlth.io.mi.com";
  }
  return `https://${normalized}.hlth.io.mi.com`;
}

export function apiWindow(startDate, endDate, timeZone) {
  const start = zonedMidnightUtcMs(startDate, timeZone);
  const endExclusive = zonedMidnightUtcMs(addDays(endDate, 1), timeZone);
  if (!Number.isFinite(start) || !Number.isFinite(endExclusive)) {
    throw new ProtocolError("Invalid date window");
  }
  return [Math.floor(start / 1000), Math.floor(endExclusive / 1000)];
}

function zonedMidnightUtcMs(isoDate, timeZone) {
  const [year, month, day] = isoDate.split("-").map(Number);
  let utc = Date.UTC(year, month - 1, day, 0, 0, 0);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = formatter.formatToParts(new Date(utc));
    const value = (type) => Number(parts.find((part) => part.type === type)?.value);
    const asUtc = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
    utc += Date.UTC(year, month - 1, day, 0, 0, 0) - asUtc;
  }
  return utc;
}

function addDays(isoDate, days) {
  const millis = Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000;
  return new Date(millis).toISOString().slice(0, 10);
}

function dateChunks(startDate, endDate, maxDays = 30) {
  const chunks = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    const chunkEnd = addDays(cursor, maxDays - 1);
    chunks.push([cursor, chunkEnd < endDate ? chunkEnd : endDate]);
    cursor = addDays(chunks.at(-1)[1], 1);
  }
  return chunks;
}

function firstValue(...values) {
  for (const value of values) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string" && value.trim() === "") {
      continue;
    }
    return value;
  }
  return "";
}

export class XiaomiFitnessClient {
  constructor({
    username,
    password,
    region = "ru",
    timeZone = "UTC",
    deviceId,
    fetchImpl = fetch,
  } = {}) {
    this.username = username;
    this.password = password;
    this.region = String(region || "ru").trim().toLowerCase() || "ru";
    this.timeZone = timeZone;
    this.deviceId = deviceId || (username ? deviceIdFromUsername(username) : createHash("sha1").update("parse-workout").digest("hex").slice(0, 16).toUpperCase());
    this.fetchImpl = fetchImpl;
    this.cookieJar = new Map();
    this.ssecurity = null;
    this.userId = "";
  }

  cookieHeader() {
    return cookieHeader(this.cookieJar);
  }

  async login() {
    if (!this.username || !this.password) {
      throw new AuthenticationError("XIAOMI_USERNAME and XIAOMI_PASSWORD are required");
    }

    this.cookieJar.set("deviceId", this.deviceId);
    this.cookieJar.set("sdkVersion", "accountsdk-18.8.15");
    this.cookieJar.set("userId", this.username);

    const metaResponse = await this.fetchImpl(LOGIN_URL, {
      headers: {
        Cookie: this.cookieHeader(),
        "User-Agent": USER_AGENT,
        "X-Requested-With": "XMLHttpRequest",
      },
      redirect: "manual",
    });
    storeCookies(this.cookieJar, metaResponse);
    if (!metaResponse.ok) {
      throw new AuthenticationError(`Xiaomi login bootstrap failed: HTTP ${metaResponse.status}`);
    }
    const meta = parseLoginPayload(await metaResponse.text());
    if (!meta._sign || !meta.qs || !meta.callback) {
      throw new AuthenticationError("Xiaomi login did not return _sign/qs/callback");
    }

    const form = new URLSearchParams({
      user: this.username,
      hash: md5Upper(this.password),
      sid: "miothealth",
      _json: "true",
      _sign: String(meta._sign),
      qs: String(meta.qs),
      callback: String(meta.callback),
    });
    const authResponse = await this.fetchImpl(LOGIN_AUTH_URL, {
      method: "POST",
      headers: {
        Cookie: this.cookieHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
        "X-Requested-With": "XMLHttpRequest",
      },
      body: form.toString(),
      redirect: "manual",
    });
    storeCookies(this.cookieJar, authResponse);
    if (!authResponse.ok) {
      throw new AuthenticationError(`Xiaomi password login failed: HTTP ${authResponse.status}`);
    }

    const payload = parseLoginPayload(await authResponse.text());
    this.assertLoginPayload(payload);

    const ssecurity = firstValue(payload.ssecurity);
    const nonce = firstValue(payload.nonce);
    const location = firstValue(payload.location);
    if (!ssecurity || !nonce || !String(location).startsWith("https://")) {
      throw new AuthenticationError("Xiaomi password login did not return a session");
    }

    this.ssecurity = Buffer.from(ssecurity, "base64");
    this.userId = String(firstValue(payload.userId, this.username));
    this.cookieJar.set("userId", this.userId);
    const passToken = firstValue(payload.passToken, this.cookieJar.get("passToken"));
    if (passToken) {
      this.cookieJar.set("passToken", passToken);
    }
    const cUserId = firstValue(payload.cUserId, this.cookieJar.get("cUserId"));
    if (cUserId) {
      this.cookieJar.set("cUserId", cUserId);
    }

    await this.followSts(location, nonce, ssecurity);
    if (![...this.cookieJar.keys()].some((name) => name.toLowerCase().includes("servicetoken"))) {
      throw new AuthenticationError("Xiaomi STS exchange did not return serviceToken");
    }
  }

  assertLoginPayload(payload) {
    if (payload.notificationUrl) {
      const url = String(payload.notificationUrl).startsWith("http")
        ? payload.notificationUrl
        : `${ACCOUNT_BASE}${payload.notificationUrl}`;
      throw new AuthenticationError(`Xiaomi requires extra verification in the browser: ${url}`);
    }
    if (payload.code === 87001) {
      throw new AuthenticationError("Xiaomi requested a captcha; unattended login cannot continue");
    }
    if (payload.code === 81003) {
      throw new AuthenticationError("Xiaomi requested SMS/email 2FA; unattended login cannot continue");
    }
    if (payload.code && payload.code !== 0) {
      throw new AuthenticationError(payload.desc || payload.description || `Xiaomi login failed with code ${payload.code}`);
    }
  }

  async followSts(location, nonce, ssecurity) {
    const signed = clientSign(nonce, ssecurity);
    let current = new URL(location);
    current.searchParams.set("clientSign", signed);
    current.searchParams.set("_userIdNeedEncrypt", "true");

    for (let hop = 0; hop < 6; hop += 1) {
      const response = await this.fetchImpl(current.toString(), {
        headers: {
          Cookie: this.cookieHeader(),
          "User-Agent": USER_AGENT,
        },
        redirect: "manual",
      });
      storeCookies(this.cookieJar, response);
      if (response.status >= 300 && response.status < 400) {
        const next = response.headers.get("location");
        if (!next) {
          break;
        }
        current = new URL(next, current);
        continue;
      }
      break;
    }
  }

  async request(apiPath, payload, regionOrOptions = this.region) {
    if (!this.ssecurity || this.cookieJar.size === 0) {
      throw new AuthenticationError("Not authenticated");
    }
    const options = typeof regionOrOptions === "object" && regionOrOptions !== null ? regionOrOptions : { region: regionOrOptions };
    const region = options.region ?? this.region;
    const signingPath = options.signingPath ?? apiPath;
    const nonce = generateNonce();
    const { signedNonce, body } = serializeEncryptedForm("POST", signingPath, payload, this.ssecurity, nonce);
    const response = await this.fetchImpl(`${regionBaseUrl(region)}${apiPath}`, {
      method: "POST",
      headers: {
        Cookie: this.cookieHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body,
    });
    if (response.status === 401) {
      throw new AuthenticationError("Xiaomi session expired");
    }
    if (!response.ok) {
      throw new ProtocolError(`Xiaomi API ${apiPath} failed: HTTP ${response.status}`);
    }
    const decrypted = decryptResponse(signedNonce, await response.text());
    if (decrypted?.code !== 0) {
      throw new ProtocolError(decrypted?.message || decrypted?.msg || "Xiaomi API returned an error");
    }
    return decrypted.result ?? {};
  }

  async discoverRegion(preferred = this.region) {
    const candidates = [preferred, ...KNOWN_REGIONS.filter((region) => region !== preferred)];
    const errors = [];
    const today = new Date().toISOString().slice(0, 10);
    const start = addDays(today, -14);
    for (const region of candidates) {
      try {
        const [startTime, endTime] = apiWindow(start, today, this.timeZone);
        await this.request(
          "/app/v1/data/get_fitness_data_by_time",
          {
            start_time: startTime,
            end_time: endTime,
            key: "steps",
          },
          region,
        );
        this.region = region;
        return region;
      } catch (error) {
        errors.push(`${region}: ${error.message}`);
      }
    }
    throw new RegionError(`No Mi Fitness region accepted the request. ${errors.join("; ")}`);
  }

  async fetchSportRecords({ startDate, endDate, region = this.region, maxPages = 100 } = {}) {
    const records = [];
    for (const [chunkStart, chunkEnd] of dateChunks(startDate, endDate, 30)) {
      const [startTime, endTime] = apiWindow(chunkStart, chunkEnd, this.timeZone);
      let nextKey = "";
      const seen = new Set();
      for (let page = 0; page < maxPages; page += 1) {
        const result = await this.request(
          "/app/v1/data/get_sport_records_by_time",
          {
            category: "",
            start_time: startTime,
            end_time: endTime,
            reverse: true,
            next_key: nextKey,
            limit: 20,
          },
          region,
        );
        const pageRecords = Array.isArray(result.sport_records) ? result.sport_records : [];
        records.push(...pageRecords);
        if (!result.has_more) {
          break;
        }
        if (!result.next_key || seen.has(result.next_key)) {
          throw new ProtocolError("Xiaomi sport pagination cursor is missing or repeated");
        }
        seen.add(result.next_key);
        nextKey = result.next_key;
      }
    }
    return records;
  }

  async fetchTrackPoints(workout) {
    const packed = pointsFromPackedCoordinates({
      longitude: workout.packedLongitude,
      latitude: workout.packedLatitude,
      altitude: workout.packedAltitude,
      startTime: Math.floor(Date.parse(workout.start) / 1000) || workout.recordTime,
    });
    const fdsPoints = await this.fetchFdsGpsPoints(workout);
    if (fdsPoints.length) {
      return fdsPoints;
    }
    const detailPoints = await this.fetchDetailTrackPoints(workout);
    if (detailPoints.length) {
      return detailPoints;
    }
    return packed;
  }

  async fetchDetailTrackPoints(workout) {
    if (!workout.start) {
      return [];
    }
    const startTime = Math.floor(Date.parse(workout.start) / 1000);
    const endTime = workout.end ? Math.floor(Date.parse(workout.end) / 1000) : startTime + (workout.durationSec || 3600);
    try {
      const result = await this.request("/app/v1/data/get_fitness_data_by_time", {
        key: "huami_sport_record",
        start_time: startTime,
        end_time: endTime,
        reverse: true,
      });
      const items = Array.isArray(result.data_list) ? result.data_list : [];
      for (const item of items) {
        if (String(item.sid || "") !== String(workout.deviceId || "") && workout.deviceId) {
          continue;
        }
        let payload = item.value;
        if (typeof payload === "string") {
          try {
            payload = JSON.parse(payload);
          } catch {
            continue;
          }
        }
        const points = pointsFromDetailPayload(payload);
        if (points.length) {
          return points;
        }
      }
    } catch {
      return [];
    }
    return [];
  }

  async fetchFdsGpsPoints(workout) {
    if (!workout.deviceId || workout.protoType == null || workout.timezoneOffset == null || !workout.recordTime) {
      return [];
    }
    const timestamp = workout.recordTime;
    const suffix = buildFdsSuffix({
      sid: workout.deviceId,
      timestamp,
      timezoneOffset: workout.timezoneOffset,
      sportType: workout.protoType,
      fileType: FDS_GPS_FILE_TYPE,
    });
    let downloads = {};
    try {
      downloads = await this.request(
        "/healthapp/service/gen_download_url",
        {
          did: workout.deviceId,
          items: [{ timestamp, suffix }],
        },
        { signingPath: "/service/gen_download_url" },
      );
    } catch {
      return [];
    }
    const entry = downloads?.[`${suffix}_${timestamp}`];
    if (!entry?.url || !entry?.obj_key) {
      return [];
    }
    try {
      const response = await this.fetchImpl(entry.url);
      if (!response.ok) {
        return [];
      }
      const body = await response.text();
      return parseGpsRecord(decryptFdsData(body, entry.obj_key));
    } catch {
      return [];
    }
  }
}
