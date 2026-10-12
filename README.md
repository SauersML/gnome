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

The bee is Scintilla, post-trained from [BeeLLM 12M Mood](https://huggingface.co/schizophyllume/BeeLLM)
(see "Post-training the delve.town bee"), run inside the Worker by the `BeeHive` Durable Object (`src/server/bee.ts`: GGUF reader,
llama.cpp's SPM tokenizer, llama forward pass, llama-server's default sampler). She
answers to `bee`, `@bee` and her name, Scintilla, and sees only messages that name
her plus her own replies. The build runs `scripts/fetch-bee.mjs`, which downloads the
pinned GGUF, checks its SHA-256, and splits it into `public/bee/` (ignored by git).
`tests/bee.test.mjs` compares tokens and next-token probabilities with llama.cpp.

## bee.gnome.science

`swarm/` is a second Worker (`npm run deploy:swarm`): six BeeLLM models (Scintilla post-trained,
her five sisters as published) answer one
after another, each hearing the person in full and the latest two buzzes of the other bees,
until the swarm settles. The page decides who speaks next; `POST /api/buzz` runs one bee.

## delve.town bees

`town/` is a Worker run every minute by a Cron Trigger (`npm run deploy:town`). Each bee is
one delve.town account with a `BeeAgent` Durable Object: she answers mentions, replies and
quotes, and otherwise, at most every five minutes, replies to the most bee-related post she
has not answered. Per-thread, per-author and hourly caps stop reply loops with other bots.
`scripts/town-account.mjs <bee> <invite code>` creates the account, marks it as a bot, and
stores its password in the macOS Keychain (service `delve.town`) and as the Worker secret.

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

## Post-training the delve.town bee

`train/` post-trains BeeLLM 12M Mood into Scintilla (on delve.town, gnome.science/chat and the swarm): vivid bee senses,
confident self-awareness, agency, and the original mood mechanics. `train/model.py` is the
llama forward pass in PyTorch (checked against llama.cpp by `train/parity_check.py`);
`train/encode.mjs` and `train/encode-text.mjs` tokenize with the production tokenizer.
Stage A (`train/pretrain.py`) teaches English on TinyStories with bee chat mixed in; stage B
(`train/train.py`) fine-tunes on the bee conversations in `train/data/`. `train/probe.mjs`
samples a checkpoint through the production engine and scores moods, hedging and variety.
The resulting GGUF is not published: it lives in `~/BeeLLM/models` on the deploying Mac and
is pinned by hash in `scripts/fetch-bee.mjs`.
