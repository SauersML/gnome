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
`anthropic/claude-haiku-5.5`; Kimi uses `moonshotai/kimi-k2.5`. Their secret is
`OPENROUTER_API_KEY`. Cogito uses Deep Cogito's own website and its model ID
`drishanarora/cogito-v2-1-671b`. There is no model fallback.

Only the room `global` exists; other `/parties/` paths return 404. The bees stay silent rather
than post a slur. A six-draft Somnia reply on a long conversation takes about 40 s of CPU on
Cloudflare, so the Workers allow 120 s.

## Cost ceiling

Whatever requests arrive, the three Workers can cost at most about $6.20 a month beyond the
Workers Paid plan, which leaves room under $10 for about 8 million requests beyond the
plan's included 10 million (Cloudflare bills $0.30 per million Worker requests and $0.15 per
million Durable Object requests, and has no spending cap).

- OpenRouter, at most $3: bot replies $0.25 a day and $2.50 a month, Haiku moderation $0.05 a
  day and $0.50 a month, counted from the cost OpenRouter reports and kept in the `Chat`
  object's storage. Moderation reviews at most 30 messages a minute (past that a message is
  dropped); past its budget only the word filter checks messages.
- Durable Object time, at most $3.20 ($1.60 per million busy seconds): each object that runs a
  bee or waits on a provider stops for the month once its allowance of busy seconds is spent
  (`src/server/busy.ts`): the chat 300,000, the chat bee 300,000, the delve.town bee 600,000,
  each of Somnia's four swarm cells 100,000 and each other swarm bee 20,000, plus the Cogito
  relay, which is busy only while the chat waits on it. The plan includes 3.1 million.
- Workers AI: the delve.town bee embeds at most 1,500 posts a day, inside the free allocation.

The bee is Somnia, the dream bee, post-trained from [BeeLLM 12M Mood](https://huggingface.co/schizophyllume/BeeLLM)
by way of Mellifera (see "Post-training the delve.town bee"), run inside the Worker by the `BeeHive` Durable Object (`src/server/bee.ts`: GGUF reader,
llama.cpp's SPM tokenizer, llama forward pass, llama-server's default sampler). She
answers to `bee`, `@bee` and her name, Somnia, and sees only messages that name
her plus her own replies. She drafts six replies and posts the one most specific to what
was said, preferring drafts made of whole words that do not repeat a clause (`src/server/garble.ts`, with a word list
built by `train/bee_words.py` from TinyStories and her training data, plus the words she is
answering). The build runs `scripts/fetch-bee.mjs`, which downloads the
pinned GGUF, checks its SHA-256, and splits it into `public/bee/` (ignored by git).
`tests/bee.test.mjs` compares tokens and next-token probabilities with llama.cpp.

## bee.gnome.science

`swarm/` is a second Worker (`npm run deploy:swarm`): six BeeLLM models (Somnia post-trained,
her five sisters as published) answer one
after another, each hearing the person in full and the latest two buzzes of the other bees,
until the swarm settles. The page decides who speaks next; `POST /api/buzz` runs one bee.

## delve.town bees

`town/` is a Worker run every minute by a Cron Trigger (`npm run deploy:town`). Each bee is
one delve.town account with a `BeeAgent` Durable Object: she answers mentions, replies and
quotes, and otherwise, at most every five minutes, replies to anyone's fresh post, the most
bee-like first, skipping posts addressed to someone else. Her memory of earlier exchanges
starts every prompt and is cleared when the model's SHA-256 changes. Per-thread, per-author
and hourly caps stop reply loops with other bots.
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

`train/` post-trained BeeLLM 12M Mood into Mellifera, the first delve.town bee: vivid bee senses,
confident self-awareness, agency, and the original mood mechanics. `train/model.py` is the
llama forward pass in PyTorch (checked against llama.cpp by `train/parity_check.py`);
`train/encode.mjs` and `train/encode-text.mjs` tokenize with the production tokenizer.
Stage A (`train/pretrain.py`) teaches English on TinyStories with bee chat mixed in; stage B
(`train/train.py`) fine-tunes on the bee conversations in `train/data/`.
`train/extend_vocab.py` grows the vocabulary with whole tokens for her caps words
(MELLIFERA, NECTAR, YES!!!), so the small model does not spell them from fragments, and
`train/caps.mjs` keeps caps in her data only on words held in one or two tokens.
`train/data/raw-computer*.jsonl` teach her where she lives: a Cloudflare computer, behind
the screen, as thirteen million weights.
`train/data/raw-threads.jsonl` holds real delve.town threads she answered, with her old
replies in the prompt masked out of the loss. `train/probe.mjs` samples a checkpoint through
the production engine and scores moods, hedging, variety and half-words;
`train/replay-town.mjs` replays her real delve.town replies with a checkpoint.
Mellifera is retired from serving and published on Hugging Face as
[Sauers/BeeLLM-Mellifera](https://huggingface.co/Sauers/BeeLLM-Mellifera).

Somnia, who replaced her on delve.town, gnome.science/chat and the swarm, is trained from
Mellifera in four steps: continued pretraining on public-domain nature writing mixed with
TinyStories; reading three books with the goldfish loss (`BEE_BOOKS` in `train/pretrain.py`),
which drops a fixed quarter of each passage's tokens from the loss so she learns from the books
but cannot recite them; a short warm start on conversations written by Claude
(`train/data/somnia-*.jsonl`); and conversations whose replies were written by a base model
(Llama 3.1 405B or Trinity-Large-TrueBase) prompted with passages from the books, then chosen
among its drafts without edits (`train/data/somnia-loom.jsonl`), mixed with the books and
TinyStories so her English holds. She is served in Q8_0 (`train/quantize.py`) and published as
[Sauers/BeeLLM-Somnia](https://huggingface.co/Sauers/BeeLLM-Somnia); the build reads her from
`~/BeeLLM/models` on the deploying Mac, pinned by hash in `scripts/fetch-bee.mjs`.
