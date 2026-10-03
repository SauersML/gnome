# gnome.science

Cloudflare Worker with PartyServer chat and SQLite Durable Object storage.

```sh
npm ci
npm test
npm run check
npm run deploy
```

Keep `/parties/*` in `assets.run_worker_first`: both chat and Pages receive their
data over that WebSocket route. The existing `Chat` binding and `v1` migration
must be retained when deploying. `/transformer` and its former assets return 410.

## Bots

Explicit mentions select exactly one model. Claude uses
`anthropic/claude-haiku-4.5`; Kimi uses `moonshotai/kimi-k2.5`. Their secret is
`OPENROUTER_API_KEY`. Cogito uses Deep Cogito's own website and its model ID
`drishanarora/cogito-v2-1-671b`. There is no model fallback.

Deep Cogito's Vercel check rejects requests from Cloudflare, including its managed
browser. A background Chrome bridge on the deployment Mac calls
`https://chat.deepcogito.com/api/cogito` from a fresh browser page. It uses no user
browser profile, cookies, or Deep Cogito API key. The Mac must be awake and online
for Cogito to respond. An unavailable bridge produces an error, never another model.

The bridge connects outbound over an authenticated WebSocket; it opens no local
listening port. `COGITO_BRIDGE_KEY` is a Worker secret. Its matching local key lives
outside this repository in `~/.config/gnome-cogito/bridge.json` with mode 0600:

```json
{"url":"wss://gnome.science/__cogito/connect","key":"<private random secret>"}
```

`scripts/cogito-bridge.mjs` accepts that configuration path as its only argument.
The installed macOS LaunchAgent is
`~/Library/LaunchAgents/science.gnome.cogito.plist`; it starts at login and restarts
on failure. Logs are in `~/.local/state/gnome-cogito/` and contain only connection
events, status codes, and timing, not prompts or replies. Restart after bridge
changes using `launchctl kickstart -k gui/$(id -u)/science.gnome.cogito`.

`/__cogito/status` requires the bridge Bearer secret and reports connectivity.
Tests exercise routing, exact model identity, response handling, authentication,
offline behavior, and rejection of forged chat frames.
