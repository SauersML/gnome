import {
	type Connection,
	Server,
	type WSMessage,
	routePartykitRequest,
} from "partyserver";

import type { ChatMessage, Message } from "../shared";

const KIMI_PATTERN = /\bkimi\b|\bk2\.?5\b/i;

const CSS_RESET_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Rate limit: max 10 Kimi calls per minute
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;

interface KimiAction {
	chat: string;
	cssAdd: string | null;
	cssEdits: { old: string; new: string }[];
	cssReset: boolean;
	clearMessages: boolean;
	edits: { id: string; content: string }[];
}

function parseKimiResponse(text: string): KimiAction {
	let chat = text;
	let cssAdd = "";
	const cssEdits: { old: string; new: string }[] = [];
	let cssReset = false;
	let clearMessages = false;
	const edits: { id: string; content: string }[] = [];

	// Extract css-reset blocks
	const cssResetRegex = /```css-reset\s*\n?[\s\S]*?```/g;
	for (const match of text.matchAll(cssResetRegex)) {
		cssReset = true;
		chat = chat.replace(match[0], "").trim();
	}

	// Extract css-edit blocks: old CSS separated from new CSS by "---"
	const cssEditRegex = /```css-edit\s*\n([\s\S]*?)```/g;
	for (const match of text.matchAll(cssEditRegex)) {
		const parts = match[1].split(/\n---\n/);
		if (parts.length === 2) {
			cssEdits.push({ old: parts[0].trim(), new: parts[1].trim() });
		}
		chat = chat.replace(match[0], "").trim();
	}

	// Extract css-add blocks (append rules)
	const cssAddRegex = /```css-add\s*\n([\s\S]*?)```/g;
	for (const match of text.matchAll(cssAddRegex)) {
		cssAdd += match[1].trim() + "\n";
		chat = chat.replace(match[0], "").trim();
	}

	// Extract clear-messages blocks
	const clearRegex = /```clear-messages\s*\n?[\s\S]*?```/g;
	for (const match of text.matchAll(clearRegex)) {
		clearMessages = true;
		chat = chat.replace(match[0], "").trim();
	}

	// Extract edit blocks: ```edit id=<msgId>\n<new content>\n```
	const editBlockRegex = /```edit\s+id=(\S+)\s*\n([\s\S]*?)```/g;
	for (const match of text.matchAll(editBlockRegex)) {
		edits.push({ id: match[1], content: match[2].trim() });
		chat = chat.replace(match[0], "").trim();
	}

	return { chat, cssAdd: cssAdd.trim() || null, cssEdits, cssReset, clearMessages, edits };
}

const PAGE_STRUCTURE = `<canvas class="pixel-bg" /> <!-- animated background -->
<div class="layout">
  <div class="app">
    <header class="header">
      <div class="brand">gnome<span class="dot">.</span>science</div>
      <div class="header-right">Live</div>
    </header>
    <div class="messages">
      <!-- repeated for each message: -->
      <div class="msg msg-self? msg-assistant? msg-new?">
        <span class="msg-who" style="color: {userColor}">username</span>
        <span class="msg-body">message text</span>
      </div>
    </div>
    <div class="compose">
      <form class="compose-form">
        <input class="compose-input" placeholder="Write something..." />
        <button class="compose-send">Send</button>
      </form>
      <div class="compose-meta">as username</div>
    </div>
  </div>
  <aside class="sidebar">
    <div class="sidebar-label">Papers</div>
    <button class="sidebar-item">
      <span class="sidebar-item-title">...</span>
      <span class="sidebar-item-desc">...</span>
    </button>
  </aside>
</div>`;

const BASE_CSS = `/* CSS variables */
:root {
  --mist: #b5cfac; --light: #dae8d2; --sage: #7da87a; --fern: #4a7a4a;
  --moss: #2d5a36; --earth: #1d3322; --glow: #6aec78; --gold: #e2b84a; --amber: #cf9636;
}
html, body { background: #0a140c; color: var(--mist); font-family: "Hanken Grotesk", sans-serif; }
.pixel-bg { position: fixed; inset: 0; z-index: 0; pointer-events: none; }
#root { height: 100%; position: relative; z-index: 1; overflow: hidden; }
.layout { display: flex; height: 100%; padding-left: clamp(24px, 8vw, 14%); }
.app { display: flex; flex-direction: column; height: 100%; width: 50%; max-width: 580px; }
.header { padding: clamp(28px, 6vh, 52px) 0 clamp(16px, 3vh, 24px); display: flex; align-items: baseline; justify-content: space-between; }
.brand { font-family: "Syne", sans-serif; font-size: clamp(22px, 3.5vw, 30px); font-weight: 700; color: var(--light); }
.brand .dot { color: var(--gold); }
.messages { flex: 1; overflow-y: auto; padding: clamp(16px, 3vh, 28px) 0 60px; }
.msg { padding: 5px 0; }
.msg-who { font-family: "Syne", sans-serif; font-size: 0.82em; font-weight: 600; color: var(--gold); margin-right: 10px; }
.msg-self .msg-who { color: var(--glow); }
.msg-body { color: var(--light); word-wrap: break-word; }
.msg-assistant .msg-who { color: var(--amber); }
.msg-assistant .msg-body { color: var(--light); }
.compose { flex-shrink: 0; padding: clamp(14px, 2.5vh, 24px) 0 clamp(24px, 5vh, 44px); }
.compose-input { flex: 1; background: none; border: none; color: var(--light); font-size: clamp(14px, 1.6vw, 16px); }
.compose-send { background: none; border: none; color: var(--light); text-transform: uppercase; }
.compose-meta { font-size: 11px; color: var(--mist); }
.sidebar { flex: 1; max-width: 380px; border-left: 1px solid var(--moss); padding: clamp(28px, 6vh, 52px) clamp(24px, 3vw, 40px); }
.sidebar-item { display: block; width: 100%; background: none; border: none; border-bottom: 1px solid rgba(45, 90, 54, 0.3); padding: 16px 0; cursor: pointer; }
.sidebar-item-title { font-family: "Syne", sans-serif; font-weight: 600; color: var(--light); }
.sidebar-item-desc { font-size: 0.8em; color: var(--mist); }`;

function buildContext(messages: ChatMessage[], customCss: string): string {
	const recentIds = messages.slice(-100).map((m) => `  ${m.id} (${m.user}): ${m.content}`).join("\n");
	const currentCssSnippet = customCss ? `\n\nCustom CSS currently applied:\n${customCss}` : "\n\nNo custom CSS is currently applied.";
	return `You're chatting in a live room at gnome.science. Here are the recent messages:\n${recentIds}\n\nPage HTML structure:\n${PAGE_STRUCTURE}\n\nBase CSS (always loaded):\n${BASE_CSS}${currentCssSnippet}\n\nYour custom CSS gets injected into a <style> tag in <head>, so it overrides the base styles above.\n\nYou have a few tools you can use by including fenced code blocks in your response. Totally optional — feel free to just chat.\n\n\`\`\`css-add — appends new CSS rules to what's already there.\n\`\`\`css-add\n.msg-body { color: red; }\n\`\`\`\n\n\`\`\`css-edit — tweaks existing custom CSS. Put the old snippet above a --- line and the replacement below.\n\`\`\`css-edit\n.msg-body { color: red; }\n---\n.msg-body { color: blue; }\n\`\`\`\n\n\`\`\`css-reset — wipes all custom CSS back to defaults.\n\`\`\`css-reset\n\`\`\`\n\n\`\`\`edit id=<message_id> — rewrites a message.\n\`\`\`edit id=abc123\nNew content\n\`\`\`\n\n\`\`\`clear-messages — wipes all chat messages.\n\`\`\`clear-messages\n\`\`\`\n\nPlease use css-add or css-edit instead of plain css blocks so the tools work correctly.`;
}

export class Chat extends Server<Env> {
	static options = { hibernate: true };

	messages: ChatMessage[] = [];
	customCss = "";
	cssUpdatedAt = 0;
	kimiCallTimestamps: number[] = [];

	broadcastMessage(message: Message, exclude?: string[]) {
		this.broadcast(JSON.stringify(message), exclude);
	}

	isRateLimited(): boolean {
		const now = Date.now();
		this.kimiCallTimestamps = this.kimiCallTimestamps.filter(
			(t) => now - t < RATE_LIMIT_WINDOW_MS,
		);
		return this.kimiCallTimestamps.length >= RATE_LIMIT_MAX;
	}

	recordKimiCall() {
		this.kimiCallTimestamps.push(Date.now());
	}

	onStart() {
		this.ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, user TEXT, role TEXT, content TEXT)`,
		);

		this.ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)`,
		);

		this.messages = this.ctx.storage.sql
			.exec(`SELECT * FROM messages`)
			.toArray() as ChatMessage[];

		const cssRow = this.ctx.storage.sql
			.exec(`SELECT value FROM kv WHERE key = 'custom_css'`)
			.toArray();
		if (cssRow.length > 0) {
			this.customCss = cssRow[0].value as string;
		}

		const tsRow = this.ctx.storage.sql
			.exec(`SELECT value FROM kv WHERE key = 'css_updated_at'`)
			.toArray();
		if (tsRow.length > 0) {
			this.cssUpdatedAt = Number(tsRow[0].value);
		}

		this.maybeResetCss();
	}

	maybeResetCss() {
		if (this.customCss && Date.now() - this.cssUpdatedAt > CSS_RESET_INTERVAL_MS) {
			this.customCss = "";
			this.cssUpdatedAt = 0;
			this.ctx.storage.sql.exec(
				`INSERT INTO kv (key, value) VALUES ('custom_css', '') ON CONFLICT (key) DO UPDATE SET value = ''`,
			);
			this.ctx.storage.sql.exec(
				`INSERT INTO kv (key, value) VALUES ('css_updated_at', '0') ON CONFLICT (key) DO UPDATE SET value = '0'`,
			);
			this.broadcastMessage({ type: "css", css: "" });
		}
	}

	onConnect(connection: Connection) {
		this.maybeResetCss();

		connection.send(
			JSON.stringify({
				type: "all",
				messages: this.messages,
			} satisfies Message),
		);

		if (this.customCss) {
			connection.send(
				JSON.stringify({ type: "css", css: this.customCss } satisfies Message),
			);
		}
	}

	saveMessage(message: ChatMessage) {
		const idx = this.messages.findIndex((m) => m.id === message.id);
		if (idx !== -1) {
			this.messages[idx] = message;
		} else {
			this.messages.push(message);
		}

		this.ctx.storage.sql.exec(
			`INSERT INTO messages (id, user, role, content) VALUES (?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET content = ?`,
			message.id,
			message.user,
			message.role,
			message.content,
			message.content,
		);
	}

	saveCss(css: string) {
		this.customCss = css;
		this.cssUpdatedAt = Date.now();
		this.ctx.storage.sql.exec(
			`INSERT INTO kv (key, value) VALUES ('custom_css', ?) ON CONFLICT (key) DO UPDATE SET value = ?`,
			css,
			css,
		);
		this.ctx.storage.sql.exec(
			`INSERT INTO kv (key, value) VALUES ('css_updated_at', ?) ON CONFLICT (key) DO UPDATE SET value = ?`,
			String(this.cssUpdatedAt),
			String(this.cssUpdatedAt),
		);
	}

	async callKimi(recentMessages: ChatMessage[]): Promise<string | null> {
		const context = recentMessages.slice(-200).map((m) => ({
			role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
			content: m.role === "assistant" ? m.content : `${m.user}: ${m.content}`,
		}));

		// Inject context about the environment as the first user message
		const contextMsg = { role: "user" as const, content: buildContext(recentMessages, this.customCss) };

		const ai = (this.env as any).AI;
		const response = await ai.run("@cf/moonshotai/kimi-k2.5", {
			messages: [contextMsg, ...context],
			max_tokens: 1024,
		});

		// Kimi K2.5 returns OpenAI-compatible chat completion format
		const text = response?.response ?? response?.choices?.[0]?.message?.content;
		if (!text) {
			console.error("Unexpected AI response shape:", JSON.stringify(response).slice(0, 200));
			return null;
		}
		return text as string;
	}

	async onMessage(connection: Connection, message: WSMessage) {
		this.broadcast(message);

		const parsed = JSON.parse(message as string) as Message;
		if (parsed.type === "add" || parsed.type === "update") {
			this.saveMessage(parsed);

			if (parsed.type === "add" && KIMI_PATTERN.test(parsed.content)) {
				if (this.isRateLimited()) {
					const rateLimitMsg: ChatMessage = {
						id: `kimi-${Date.now()}-rl`,
						content: "I'm getting too many requests right now. Try again in a minute.",
						user: "Kimi",
						role: "assistant",
					};
					this.saveMessage(rateLimitMsg);
					this.broadcastMessage({ type: "add", ...rateLimitMsg });
					return;
				}

				this.recordKimiCall();

				const rawResponse = await this.callKimi(this.messages);
				if (!rawResponse) return;
				const { chat, cssAdd, cssEdits, cssReset, clearMessages, edits } = parseKimiResponse(rawResponse);

				if (chat) {
					const kimiMessage: ChatMessage = {
						id: `kimi-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
						content: chat,
						user: "Kimi",
						role: "assistant",
					};
					this.saveMessage(kimiMessage);
					this.broadcastMessage({ type: "add", ...kimiMessage });
				}

				if (clearMessages) {
					this.messages = [];
					this.ctx.storage.sql.exec(`DELETE FROM messages`);
					this.broadcastMessage({ type: "all", messages: [] });
				}

				if (cssReset) {
					this.saveCss("");
					this.broadcastMessage({ type: "css", css: "" });
				}

				// Apply css-edit find-and-replace operations
				for (const edit of cssEdits) {
					if (this.customCss.includes(edit.old)) {
						this.saveCss(this.customCss.replace(edit.old, edit.new));
						this.broadcastMessage({ type: "css", css: this.customCss });
					}
				}

				if (cssAdd) {
					const newCss = this.customCss ? this.customCss + "\n" + cssAdd : cssAdd;
					this.saveCss(newCss);
					this.broadcastMessage({ type: "css", css: newCss });
				}

				for (const edit of edits) {
					const existing = this.messages.find((m) => m.id === edit.id);
					if (existing) {
						const updated: ChatMessage = { ...existing, content: edit.content };
						this.saveMessage(updated);
						this.broadcastMessage({ type: "update", ...updated });
					}
				}
			}
		}
	}

	async onRequest(request: Request) {
		const url = new URL(request.url);
		if (url.pathname.endsWith("/clear") && request.method === "POST") {
			this.messages = [];
			this.ctx.storage.sql.exec(`DELETE FROM messages`);
			this.broadcastMessage({ type: "all", messages: [] });
			return new Response("cleared");
		}
		return new Response("not found", { status: 404 });
	}
}

export default {
	async fetch(request, env) {
		return (
			(await routePartykitRequest(request, env)) ||
			env.ASSETS.fetch(request)
		);
	},
} satisfies ExportedHandler<Env>;
