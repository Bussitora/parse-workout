// One-time local login: prints the GARMIN_TOKEN value for GitHub Secrets.
// Garmin often blocks password logins from GitHub runners and may ask for an MFA code,
// so the long-lived OAuth1 token (~1 year) is obtained here and reused by Actions.
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadDotEnv } from "./cli.js";
import { GarminConnectClient } from "./garmin.js";

const envVars = { ...process.env };
await loadDotEnv(envVars);

const rl = createInterface({ input: stdin, output: stdout });
const username = envVars.GARMIN_USERNAME || (await rl.question("Garmin email: "));
const password = envVars.GARMIN_PASSWORD || (await rl.question("Garmin password: "));

try {
  const client = new GarminConnectClient({ username, password });
  const token = await client.loginWithPassword({ mfaCode: () => rl.question("MFA code: ") });
  await client.exchange();
  console.log("\nLogin OK. Save this value as the GARMIN_TOKEN secret:\n");
  console.log(Buffer.from(JSON.stringify(token)).toString("base64"));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rl.close();
}
