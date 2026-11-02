import assert from "node:assert/strict";
import test from "node:test";
import {
  GarminConnectClient,
  garminFileName,
  oauth1Header,
  parseGarminToken,
  withHeartRateDesc,
} from "../src/garmin.js";

const consumer = { consumer_key: "ck", consumer_secret: "cs" };

test("OAuth1 signature matches the Twitter reference example", () => {
  const header = oauth1Header({
    method: "POST",
    url: "https://api.twitter.com/1.1/statuses/update.json?include_entities=true",
    consumer: {
      consumer_key: "xvz1evFS4wEEPTGEFPHBog",
      consumer_secret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
    },
    token: {
      oauth_token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
      oauth_token_secret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
    },
    body: { status: "Hello Ladies + Gentlemen, a signed OAuth request!" },
    nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
    timestamp: 1318622958,
  });
  assert.match(header, /oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"/);
});

test("file names use local date, UTC time and Xiaomi-compatible activity type", () => {
  assert.equal(
    garminFileName({
      startTimeLocal: "2026-11-03 00:40:54",
      startTimeGMT: "2026-11-02 19:40:54",
      activityType: { typeKey: "running" },
    }),
    "2026-11-03_194054_outdoor_running_garmin.gpx",
  );
  assert.equal(
    garminFileName({ startTimeLocal: "2026-11-03 10:00:00", startTimeGMT: "2026-11-03 05:00:00", activityType: { typeKey: "trail_running" } }),
    "2026-11-03_050000_trail_running_garmin.gpx",
  );
});

test("heart rate summary is added to Garmin GPX metadata once", () => {
  const xml = '<gpx><metadata><time>2026-11-03T05:00:00.000Z</time></metadata></gpx>';
  const withDesc = withHeartRateDesc(xml, { averageHR: 147.4, maxHR: 163 });
  assert.match(withDesc, /<metadata>\n    <desc>HR avg 147, max 163<\/desc><time>/);
  assert.equal(withHeartRateDesc(withDesc, { averageHR: 150 }), withDesc);
  assert.equal(withHeartRateDesc(xml, {}), xml);
});

test("GARMIN_TOKEN accepts base64 or raw JSON", () => {
  const token = { oauth_token: "t", oauth_token_secret: "s" };
  assert.deepEqual(parseGarminToken(Buffer.from(JSON.stringify(token)).toString("base64")), token);
  assert.deepEqual(parseGarminToken(JSON.stringify(token)), token);
  assert.equal(parseGarminToken(""), null);
  assert.throws(() => parseGarminToken('{"oauth_token":"t"}'), /oauth_token_secret/);
});

test("password login, token exchange and activity download against a mocked Garmin API", async () => {
  const calls = [];
  const client = new GarminConnectClient({
    username: "runner@example.com",
    password: "secret",
    consumer,
    fetchImpl: async (url, init = {}) => {
      const target = String(url);
      calls.push(`${init.method ?? "GET"} ${target.split("?")[0]}`);
      if (target.startsWith("https://sso.garmin.com/sso/embed")) {
        return new Response("", { headers: { "set-cookie": "GARMIN-SSO=1; Path=/" } });
      }
      if (target.startsWith("https://sso.garmin.com/sso/signin") && !init.method) {
        assert.equal(init.headers.Cookie, "GARMIN-SSO=1");
        return new Response('<input type="hidden" name="_csrf" value="csrf-1" />');
      }
      if (target.startsWith("https://sso.garmin.com/sso/signin")) {
        const form = new URLSearchParams(init.body);
        assert.equal(form.get("_csrf"), "csrf-1");
        assert.equal(form.get("username"), "runner@example.com");
        return new Response('<title>Success</title><script>var url = "https://sso.garmin.com/sso/embed?ticket=ST-123";</script>');
      }
      if (target.includes("/oauth/preauthorized")) {
        assert.equal(new URL(target).searchParams.get("ticket"), "ST-123");
        assert.match(init.headers.Authorization, /^OAuth oauth_consumer_key="ck"/);
        return new Response("oauth_token=tok&oauth_token_secret=sec");
      }
      if (target.endsWith("/oauth/exchange/user/2.0")) {
        assert.match(init.headers.Authorization, /oauth_token="tok"/);
        return Response.json({ access_token: "access-1" });
      }
      assert.equal(init.headers.Authorization, "Bearer access-1");
      if (target.includes("/activities/search/activities")) {
        const start = Number(new URL(target).searchParams.get("start"));
        const page = start === 0
          ? [
              { activityId: 2, startTimeLocal: "2026-11-02 21:00:00" },
              { activityId: 1, startTimeLocal: "2026-10-01 21:00:00" },
            ]
          : [];
        return Response.json(page);
      }
      if (target.includes("/download-service/export/gpx/activity/2")) {
        return new Response("<gpx/>");
      }
      throw new Error(`unexpected url ${target}`);
    },
  });

  await client.login();
  assert.deepEqual(client.oauth1, { oauth_token: "tok", oauth_token_secret: "sec" });
  const activities = await client.fetchActivities({ startDate: "2026-10-15", pageSize: 2 });
  assert.deepEqual(activities.map((a) => a.activityId), [2]);
  assert.equal(await client.downloadGpx(2), "<gpx/>");
  assert.ok(calls.includes("POST https://connectapi.garmin.com/oauth-service/oauth/exchange/user/2.0"));
});

test("a saved token skips the password login", async () => {
  const client = new GarminConnectClient({
    token: { oauth_token: "tok", oauth_token_secret: "sec" },
    consumer,
    fetchImpl: async (url) => {
      assert.ok(String(url).endsWith("/oauth/exchange/user/2.0"), `unexpected url ${url}`);
      return Response.json({ access_token: "access-2" });
    },
  });
  await client.login();
  assert.equal(client.accessToken, "access-2");
});

test("token exchange retries on HTTP 429 and then reports rate limiting", async () => {
  let attempts = 0;
  const nonces = new Set();
  const make = (failures) =>
    new GarminConnectClient({
      token: { oauth_token: "tok", oauth_token_secret: "sec" },
      consumer,
      retryDelaysMs: [0, 0],
      fetchImpl: async (url, init) => {
        attempts += 1;
        nonces.add(init.headers.Authorization.match(/oauth_nonce="([^"]+)"/)[1]);
        return attempts <= failures ? new Response("", { status: 429 }) : Response.json({ access_token: "ok" });
      },
    });

  await make(2).login();
  assert.equal(attempts, 3);
  assert.equal(nonces.size, 3);

  attempts = 0;
  await assert.rejects(make(5).login(), /HTTP 429 \(Garmin rate-limits/);
  assert.equal(attempts, 3);
});

test("MFA prompt without a code handler fails with a clear message", async () => {
  const client = new GarminConnectClient({
    username: "u",
    password: "p",
    consumer,
    fetchImpl: async (url, init = {}) => {
      if (String(url).includes("/signin") && init.method === "POST") {
        return new Response('<title>Enter MFA code for login</title><input name="_csrf" value="c2" />');
      }
      return new Response('<input name="_csrf" value="c1" />');
    },
  });
  await assert.rejects(client.login(), /garmin-login\.js/);
});
