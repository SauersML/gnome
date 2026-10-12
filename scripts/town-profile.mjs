// Rewrites an existing bee's delve.town profile from town-bees.mjs and town/avatars/,
// signing in with the password from the macOS Keychain.
// Usage: node scripts/town-profile.mjs <bee id>
import { execFileSync } from "node:child_process";
import { BEES, putProfile, xrpc } from "./town-bees.mjs";

const beeId = process.argv[2];
const bee = BEES[beeId];
if (!bee) throw new Error(`usage: town-profile.mjs <${Object.keys(BEES).join("|")}>`);
const password = execFileSync("security", ["find-generic-password", "-s", "delve.town", "-a", bee.handle, "-w"]).toString().trim();
const session = await xrpc("com.atproto.server.createSession", { identifier: bee.handle, password });
await putProfile(beeId, session.did, session.accessJwt);
console.log(`profile updated for ${bee.handle}`);
