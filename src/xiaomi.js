import { decryptResponse, generateNonce, serializeEncryptedForm } from "./crypto.js";

const LOGIN_PREFIX = "&&&START&&&";
const KNOWN_REGIONS = ["ru", "cn", "de", "i2", "sg", "us"];
const LOGIN_URL = "https://account.xiaomi.com/pass/serviceLogin?_json=true&sid=miothealth";
const USER_AGENT = "Mozilla/5.0 (compatible; parse-workout/1.0)";

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

function regionBaseUrl(region) {
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

export class XiaomiFitnessClient {
  constructor({ userId, passToken, region = "ru", timeZone = "UTC", fetchImpl = fetch } = {}) {
    this.userId = userId;
    this.passToken = passToken;
    this.region = String(region || "ru").trim().toLowerCase() || "ru";
    this.timeZone = timeZone;
    this.fetchImpl = fetchImpl;
    this.cookieJar = new Map();
    this.ssecurity = null;
  }

  cookieHeader() {
    return cookieHeader(this.cookieJar);
  }

  async login() {
    if (!this.userId || !this.passToken) {
      throw new AuthenticationError("XIAOMI_USER_ID and XIAOMI_PASS_TOKEN are required");
    }

    this.cookieJar.set("userId", this.userId);
    this.cookieJar.set("passToken", this.passToken);

    const loginResponse = await this.fetchImpl(LOGIN_URL, {
      headers: {
        Cookie: this.cookieHeader(),
        "User-Agent": USER_AGENT,
      },
      redirect: "manual",
    });
    storeCookies(this.cookieJar, loginResponse);
    if (!loginResponse.ok) {
      throw new AuthenticationError(`Xiaomi login failed: HTTP ${loginResponse.status}`);
    }

    const payload = parseLoginPayload(await loginResponse.text());
    const location = payload.location;
    const ssecurity = payload.ssecurity;
    if (typeof location !== "string" || !location.startsWith("https://") || typeof ssecurity !== "string") {
      throw new AuthenticationError("Xiaomi login did not return a session. Check userId/passToken.");
    }

    this.ssecurity = Buffer.from(ssecurity, "base64");
    if (payload.userId !== undefined) {
      this.userId = String(payload.userId);
      this.cookieJar.set("userId", this.userId);
    }
    if (typeof payload.passToken === "string" && payload.passToken) {
      this.passToken = payload.passToken;
      this.cookieJar.set("passToken", this.passToken);
    }

    const redirect = await this.fetchImpl(location, {
      headers: {
        Cookie: this.cookieHeader(),
        "User-Agent": USER_AGENT,
      },
      redirect: "manual",
    });
    storeCookies(this.cookieJar, redirect);
    if (![...this.cookieJar.keys()].some((name) => name.toLowerCase() === "servicetoken")) {
      throw new AuthenticationError("Xiaomi login did not return session cookies");
    }
  }

  async request(apiPath, payload, region = this.region) {
    if (!this.ssecurity || this.cookieJar.size === 0) {
      throw new AuthenticationError("Not authenticated");
    }
    const nonce = generateNonce();
    const { signedNonce, body } = serializeEncryptedForm("POST", apiPath, payload, this.ssecurity, nonce);
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
        await this.request(
          "/app/v1/data/get_fitness_data_by_time",
          {
            start_time: apiWindow(start, today, this.timeZone)[0],
            end_time: apiWindow(start, today, this.timeZone)[1],
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
}
