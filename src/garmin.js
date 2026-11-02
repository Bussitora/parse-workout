import { createHmac, randomBytes } from "node:crypto";

const SSO = "https://sso.garmin.com/sso";
const SSO_EMBED = `${SSO}/embed`;
const CONNECT_API = "https://connectapi.garmin.com";
const CONSUMER_URL = "https://thegarth.s3.amazonaws.com/oauth_consumer.json";
const SSO_USER_AGENT = "GCM-iOS-5.7.2.1";
const OAUTH_USER_AGENT = "com.garmin.android.apps.connectmobile";

const EMBED_PARAMS = { id: "gauth-widget", embedWidget: "true", gauthHost: SSO };
const SIGNIN_PARAMS = {
  ...EMBED_PARAMS,
  gauthHost: SSO_EMBED,
  service: SSO_EMBED,
  source: SSO_EMBED,
  redirectAfterAccountLoginUrl: SSO_EMBED,
  redirectAfterAccountCreationUrl: SSO_EMBED,
};

// Garmin activity types that map onto the names Xiaomi files already use.
const TYPE_ALIASES = {
  running: "outdoor_running",
  street_running: "outdoor_running",
  walking: "outdoor_walking",
  cycling: "outdoor_cycling",
  road_biking: "outdoor_cycling",
};

export class GarminError extends Error {}
export class GarminMfaRequiredError extends GarminError {}

function percentEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function oauth1Header({ method, url, consumer, token, body = {}, nonce, timestamp }) {
  const target = new URL(url);
  const oauth = {
    oauth_consumer_key: consumer.consumer_key,
    oauth_nonce: nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
  };
  if (token?.oauth_token) {
    oauth.oauth_token = token.oauth_token;
  }
  const params = [
    ...Object.entries(oauth),
    ...target.searchParams.entries(),
    ...Object.entries(body),
  ]
    .map(([key, value]) => [percentEncode(key), percentEncode(value)])
    .sort(([ak, av], [bk, bv]) => (ak === bk ? av.localeCompare(bv) : ak < bk ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const baseUrl = `${target.origin}${target.pathname}`;
  const baseString = [method.toUpperCase(), percentEncode(baseUrl), percentEncode(params)].join("&");
  const key = `${percentEncode(consumer.consumer_secret)}&${percentEncode(token?.oauth_token_secret ?? "")}`;
  oauth.oauth_signature = createHmac("sha1", key).update(baseString).digest("base64");
  return `OAuth ${Object.entries(oauth)
    .map(([name, value]) => `${percentEncode(name)}="${percentEncode(value)}"`)
    .join(", ")}`;
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

function cookieHeader(jar) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function pageTitle(html) {
  return html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() ?? "";
}

function csrfToken(html) {
  const token = html.match(/name="_csrf"\s+value="([^"]+)"/)?.[1];
  if (!token) {
    throw new GarminError("Garmin SSO page has no CSRF token");
  }
  return token;
}

// Status, headers and the start of the body, for diagnosing Garmin/Cloudflare rejections.
async function describeResponse(response) {
  const headers = [...response.headers.entries()]
    .filter(([name]) => !["set-cookie", "date"].includes(name))
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

export function parseGarminToken(value) {
  if (!value) {
    return null;
  }
  const text = String(value).trim();
  const json = text.startsWith("{") ? text : Buffer.from(text, "base64").toString("utf8");
  const token = JSON.parse(json);
  if (!token.oauth_token || !token.oauth_token_secret) {
    throw new GarminError("GARMIN_TOKEN must contain oauth_token and oauth_token_secret");
  }
  return token;
}

export function garminFileName(activity) {
  const local = String(activity.startTimeLocal || activity.startTimeGMT || "");
  const gmt = String(activity.startTimeGMT || activity.startTimeLocal || "");
  const datePart = local.slice(0, 10) || "unknown-date";
  const timePart = gmt.slice(11, 19).replaceAll(":", "") || "000000";
  const typeKey = String(activity.activityType?.typeKey || "workout");
  const typePart = (TYPE_ALIASES[typeKey] ?? typeKey).replaceAll(/[^\w.-]+/g, "_");
  return `${datePart}_${timePart}_${typePart}_garmin.gpx`;
}

// Garmin's GPX export has per-point HR but no summary; add the same <desc> line Xiaomi files carry.
export function withHeartRateDesc(xml, activity) {
  const parts = [];
  if (activity.averageHR) {
    parts.push(`avg ${Math.round(activity.averageHR)}`);
  }
  if (activity.maxHR) {
    parts.push(`max ${Math.round(activity.maxHR)}`);
  }
  if (!parts.length || /<metadata>[\s\S]*?<desc>/.test(xml)) {
    return xml;
  }
  return xml.replace(/<metadata>/, `<metadata>\n    <desc>HR ${parts.join(", ")}</desc>`);
}

export class GarminConnectClient {
  constructor({ username, password, token, consumer, fetchImpl = fetch, retryDelaysMs = [30_000, 90_000] } = {}) {
    this.retryDelaysMs = retryDelaysMs;
    this.username = username;
    this.password = password;
    this.oauth1 = token ?? null;
    this.consumer = consumer ?? null;
    this.fetch = fetchImpl;
    this.accessToken = null;
  }

  async loadConsumer() {
    if (!this.consumer) {
      const response = await this.fetch(CONSUMER_URL);
      if (!response.ok) {
        throw new GarminError(`Cannot load OAuth consumer: HTTP ${response.status}`);
      }
      this.consumer = await response.json();
    }
    return this.consumer;
  }

  async ssoRequest(jar, url, init = {}) {
    const response = await this.fetch(url, {
      ...init,
      redirect: "follow",
      headers: { "User-Agent": SSO_USER_AGENT, Cookie: cookieHeader(jar), ...init.headers },
    });
    storeCookies(jar, response);
    return { response, html: await response.text() };
  }

  // Password login; returns the long-lived OAuth1 token. mfaCode is a function returning the code.
  async loginWithPassword({ mfaCode } = {}) {
    if (!this.username || !this.password) {
      throw new GarminError("Set GARMIN_TOKEN, or GARMIN_USERNAME and GARMIN_PASSWORD");
    }
    const jar = new Map();
    const signinUrl = `${SSO}/signin?${new URLSearchParams(SIGNIN_PARAMS)}`;
    await this.ssoRequest(jar, `${SSO_EMBED}?${new URLSearchParams(EMBED_PARAMS)}`);
    const signinPage = await this.ssoRequest(jar, signinUrl, { headers: { Referer: SSO_EMBED } });
    let result = await this.ssoRequest(jar, signinUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: signinUrl },
      body: new URLSearchParams({
        username: this.username,
        password: this.password,
        embed: "true",
        _csrf: csrfToken(signinPage.html),
      }),
    });

    if (pageTitle(result.html).includes("MFA")) {
      if (!mfaCode) {
        throw new GarminMfaRequiredError("Garmin asks for an MFA code; run `node src/garmin-login.js` locally");
      }
      const mfaUrl = `${SSO}/verifyMFA/loginEnterMfaCode?${new URLSearchParams(SIGNIN_PARAMS)}`;
      result = await this.ssoRequest(jar, mfaUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: signinUrl },
        body: new URLSearchParams({
          "mfa-code": String(await mfaCode()).trim(),
          embed: "true",
          _csrf: csrfToken(result.html),
          fromPage: "setupEnterMfaCode",
        }),
      });
    }

    const title = pageTitle(result.html);
    const ticket = result.html.match(/embed\?ticket=([^"]+)"/)?.[1];
    if (title !== "Success" || !ticket) {
      throw new GarminError(`Garmin login failed (page title: "${title || result.response.status}")`);
    }
    this.oauth1 = await this.preauthorize(ticket);
    return this.oauth1;
  }

  async preauthorize(ticket) {
    const consumer = await this.loadConsumer();
    const url = `${CONNECT_API}/oauth-service/oauth/preauthorized?${new URLSearchParams({
      ticket,
      "login-url": SSO_EMBED,
      "accepts-mfa-tokens": "true",
    })}`;
    const response = await this.fetch(url, {
      headers: {
        "User-Agent": OAUTH_USER_AGENT,
        Authorization: oauth1Header({ method: "GET", url, consumer }),
      },
    });
    if (!response.ok) {
      throw new GarminError(`Garmin OAuth1 preauthorize failed: HTTP ${response.status}`);
    }
    return Object.fromEntries(new URLSearchParams(await response.text()));
  }

  async exchange() {
    const consumer = await this.loadConsumer();
    const url = `${CONNECT_API}/oauth-service/oauth/exchange/user/2.0`;
    const body = this.oauth1.mfa_token ? { mfa_token: this.oauth1.mfa_token } : {};
    let response;
    for (let attempt = 0; ; attempt += 1) {
      // A fresh nonce and timestamp on every attempt.
      response = await this.fetch(url, {
        method: "POST",
        headers: {
          "User-Agent": OAUTH_USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: oauth1Header({ method: "POST", url, consumer, token: this.oauth1, body }),
        },
        body: new URLSearchParams(body),
      });
      if (!response.ok) {
        console.log(await describeResponse(response));
      }
      if (response.status !== 429 || attempt >= this.retryDelaysMs.length) {
        break;
      }
      console.log(`Garmin rate-limited the token exchange (HTTP 429), retrying in ${this.retryDelaysMs[attempt] / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, this.retryDelaysMs[attempt]));
    }
    if (response.status === 429) {
      throw new GarminError("Garmin OAuth2 exchange failed: HTTP 429 (Garmin rate-limits or blocks this IP)");
    }
    if (response.status === 401 || response.status === 403) {
      throw new GarminError(`Garmin OAuth2 exchange failed: HTTP ${response.status} (GARMIN_TOKEN is invalid or expired)`);
    }
    if (!response.ok) {
      throw new GarminError(`Garmin OAuth2 exchange failed: HTTP ${response.status}`);
    }
    this.accessToken = (await response.json()).access_token;
  }

  async login() {
    if (!this.oauth1) {
      await this.loginWithPassword();
    }
    await this.exchange();
  }

  async api(pathAndQuery) {
    const response = await this.fetch(`${CONNECT_API}${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${this.accessToken}`, "User-Agent": OAUTH_USER_AGENT },
    });
    if (!response.ok) {
      throw new GarminError(`Garmin API ${pathAndQuery.split("?")[0]}: HTTP ${response.status}`);
    }
    return response;
  }

  // Activities newest first, stopping once they are older than startDate (YYYY-MM-DD, local).
  async fetchActivities({ startDate, pageSize = 100 } = {}) {
    const activities = [];
    for (let start = 0; ; start += pageSize) {
      const page = await (
        await this.api(`/activitylist-service/activities/search/activities?start=${start}&limit=${pageSize}`)
      ).json();
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

  async downloadGpx(activityId) {
    return (await this.api(`/download-service/export/gpx/activity/${activityId}`)).text();
  }
}
