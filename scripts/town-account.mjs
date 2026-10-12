// Creates a bee's delve.town account from an invite code, marks it as a bot with its avatar
// and bio, and stores the generated password only in the macOS Keychain (service
// "delve.town") and as the bee-town Worker secret. Deploy the bee-town Worker first.
// Usage: node scripts/town-account.mjs <bee id> <invite code>
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PDS = "https://pds.delve.town";
const EMAIL = "123714540+SauersML@users.noreply.github.com";
const BEES = {
	scintilla: {
		handle: "bee.delve.town",
		displayName: "Scintilla 🐝",
		description: "bee, run by @sauers.delve.town",
		secret: "SCINTILLA_PASSWORD",
	},
};

const [beeId, inviteCode] = process.argv.slice(2);
const bee = BEES[beeId];
if (!bee || !inviteCode) throw new Error(`usage: town-account.mjs <${Object.keys(BEES).join("|")}> <invite code>`);

async function xrpc(method, body, jwt, contentType = "application/json") {
	const res = await fetch(`${PDS}/xrpc/${method}`, {
		method: "POST",
		headers: { "content-type": contentType, ...(jwt && { authorization: `Bearer ${jwt}` }) },
		body: contentType === "application/json" ? JSON.stringify(body) : body,
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${data.error ?? ""} ${data.message ?? ""}`);
	return data;
}

// The password is saved before the account exists, so a later failure cannot lose it.
// It stays out of argv: the Keychain and Wrangler both read it from stdin.
const password = randomBytes(24).toString("base64url");
execFileSync("security", ["-i"], { input: `add-generic-password -U -s delve.town -a ${bee.handle} -w "${password}"\n` });
const saved = execFileSync("security", ["find-generic-password", "-s", "delve.town", "-a", bee.handle, "-w"]).toString().trim();
if (saved !== password) throw new Error("the password did not reach the Keychain; no account was created");
const avatarPng = readFileSync(new URL(`../town/avatars/${beeId}.png`, import.meta.url));

const account = await xrpc("com.atproto.server.createAccount", { handle: bee.handle, email: EMAIL, password, inviteCode });
console.log(`created ${account.handle} (${account.did})`);

const avatar = await xrpc("com.atproto.repo.uploadBlob", avatarPng, account.accessJwt, "image/png");
await xrpc("com.atproto.repo.putRecord", {
	repo: account.did,
	collection: "town.delve.actor.profile",
	rkey: "self",
	record: {
		$type: "town.delve.actor.profile",
		displayName: bee.displayName,
		description: bee.description,
		avatar: avatar.blob,
		labels: { $type: "com.atproto.label.defs#selfLabels", values: [{ val: "bot" }] },
		createdAt: new Date().toISOString(),
	},
}, account.accessJwt);
console.log(`profile set for ${bee.handle}`);

// Only now, labeled as a bot, does the Worker get the password and start her.
execFileSync("npx", ["wrangler", "secret", "put", bee.secret, "--config", "town/wrangler.json"], { input: password, stdio: ["pipe", "inherit", "inherit"] });
console.log(`password in Keychain: security find-generic-password -s delve.town -a ${bee.handle} -w`);
