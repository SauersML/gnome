// bee.gnome.science briefly served llama.cpp's web UI, which installed a service worker at
// /sw.js that keeps showing that old page. This replacement removes itself and its caches,
// then reloads open tabs into the swarm.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
	event.waitUntil((async () => {
		await self.registration.unregister();
		for (const key of await caches.keys()) await caches.delete(key);
		for (const client of await self.clients.matchAll({ type: "window" })) client.navigate(client.url);
	})());
});
