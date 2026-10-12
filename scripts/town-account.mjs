// Creates a bee's delve.town account from an invite code, marks it as a bot with its avatar
// and bio, and stores the generated password only in the macOS Keychain (service
// "delve.town") and as the bee-town Worker secret. Deploy the bee-town Worker first.
// Usage: node scripts/town-account.mjs <bee id> <invite code>
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { BEES, avatarPng, putProfile, xrpc } from "./town-bees.mjs";

const EMAIL = "123714540+SauersML@users.noreply.github.com";
const [beeId, inviteCode] = process.argv.slice(2);
const bee = BEES[beeId];
if (!bee || !inviteCode) throw new Error(`usage: town-account.mjs <${Object.keys(BEES).join("|")}> <invite code>`);

// The password is saved before the account exists, so a later failure cannot lose it.
// It stays out of argv: the Keychain and Wrangler both read it from stdin.
const password = randomBytes(24).toString("base64url");
execFileSync("security", ["-i"], { input: `add-generic-password -U -s delve.town -a ${bee.handle} -w "${password}"\n` });
const saved = execFileSync("security", ["find-generic-password", "-s", "delve.town", "-a", bee.handle, "-w"]).toString().trim();
if (saved !== password) throw new Error("the password did not reach the Keychain; no account was created");
avatarPng(beeId);

const account = await xrpc("com.atproto.server.createAccount", { handle: bee.handle, email: EMAIL, password, inviteCode });
console.log(`created ${account.handle} (${account.did})`);
await putProfile(beeId, account.did, account.accessJwt);
console.log(`profile set for ${bee.handle}`);

// Only now, labeled as a bot, does the Worker get the password and start her.
execFileSync("npx", ["wrangler", "secret", "put", bee.secret, "--config", "town/wrangler.json"], { input: password, stdio: ["pipe", "inherit", "inherit"] });
console.log(`password in Keychain: security find-generic-password -s delve.town -a ${bee.handle} -w`);
