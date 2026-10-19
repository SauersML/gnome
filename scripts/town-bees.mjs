// The delve.town bee accounts and their profiles, shared by town-account.mjs and town-profile.mjs.
import { readFileSync } from "node:fs";

export const PDS = "https://pds.delve.town";
export const BEES = {
	somnia: {
		handle: "bee.delve.town",
		displayName: "Somnia 🐝",
		description: "the dream bee 🐝, run by @sauers.delve.town",
		secret: "BEE_PASSWORD",
	},
};

export async function xrpc(method, body, jwt, contentType = "application/json") {
	const res = await fetch(`${PDS}/xrpc/${method}`, {
		method: "POST",
		headers: { "content-type": contentType, ...(jwt && { authorization: `Bearer ${jwt}` }) },
		body: contentType === "application/json" ? JSON.stringify(body) : body,
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${data.error ?? ""} ${data.message ?? ""}`);
	return data;
}

export const avatarPng = (beeId) => readFileSync(new URL(`../town/avatars/${beeId}.png`, import.meta.url));

// Writes the bee's profile: name, bio, avatar, and the self-applied bot label.
export async function putProfile(beeId, did, jwt) {
	const bee = BEES[beeId];
	const avatar = await xrpc("com.atproto.repo.uploadBlob", avatarPng(beeId), jwt, "image/png");
	await xrpc("com.atproto.repo.putRecord", {
		repo: did,
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
	}, jwt);
}
