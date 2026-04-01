import {
	type Connection,
	Server,
	type WSMessage,
	routePartykitRequest,
} from "partyserver";

import type { ChatMessage, Message } from "../shared";

const KIMI_PATTERN = /\bkimi\b|\bk2\.?5\b/i;

const CSS_RESET_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

const KIMI_SYSTEM_PROMPT = `You are Kimi, a playful and creative AI who lives inside a chatroom at gnome.science. You are chatting with real people.

You have a special ability: you can change the CSS styling of the page. When you want to change the page's appearance, include a CSS code block in your response like this:

\`\`\`css
body { background: pink; }
\`\`\`

Rules:
- You can ONLY change CSS. You cannot change HTML structure or JavaScript behavior.
- Be creative and have fun with styling when asked!
- Keep your chat responses concise and friendly.
- If someone asks you to change the look of the page, do it enthusiastically.
- You can change colors, fonts, sizes, animations, layouts — anything CSS can do.
- The default stylesheet uses CSS variables like --bg, --text, --accent, --green, --border, etc. You can override these or write new rules.
- Don't break the page — keep it usable (e.g. don't hide the input or make text invisible).
- If no CSS change is needed, just chat normally without a CSS block.
- Your name is Kimi. You also respond to K2.5.`;

function extractCss(text: string): { chat: string; css: string | null } {
	const cssBlockRegex = /```css\s*\n([\s\S]*?)```/g;
	let css = "";
	let chat = text;

	for (const match of text.matchAll(cssBlockRegex)) {
		css += match[1].trim() + "\n";
		chat = chat.replace(match[0], "").trim();
	}

	return { chat, css: css.trim() || null };
}

export class Chat extends Server<Env> {
	static options = { hibernate: true };

	messages = [] as ChatMessage[];
	customCss = "";
	cssUpdatedAt = 0;

	broadcastMessage(message: Message, exclude?: string[]) {
		this.broadcast(JSON.stringify(message), exclude);
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

		// Load custom CSS
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

		// Check 24h reset
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
			// Broadcast reset to all connected clients
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

		// Send current custom CSS
		if (this.customCss) {
			connection.send(
				JSON.stringify({ type: "css", css: this.customCss } satisfies Message),
			);
		}
	}

	saveMessage(message: ChatMessage) {
		const existingMessage = this.messages.find((m) => m.id === message.id);
		if (existingMessage) {
			this.messages = this.messages.map((m) => {
				if (m.id === message.id) {
					return message;
				}
				return m;
			});
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

	async callKimi(userMessage: string, recentMessages: ChatMessage[]) {
		// Build conversation context (last 20 messages for context)
		const context = recentMessages.slice(-20).map((m) => ({
			role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
			content: m.role === "assistant" ? m.content : `${m.user}: ${m.content}`,
		}));

		const ai = (this.env as any).AI;
		const response = await ai.run("@cf/moonshotai/kimi-k2.5", {
			messages: [
				{ role: "system", content: KIMI_SYSTEM_PROMPT },
				...context,
			],
			max_tokens: 1024,
		});

		return response.response as string;
	}

	async onMessage(connection: Connection, message: WSMessage) {
		// Broadcast the raw message to everyone else
		this.broadcast(message);

		const parsed = JSON.parse(message as string) as Message;
		if (parsed.type === "add" || parsed.type === "update") {
			this.saveMessage(parsed);

			// Check if message mentions Kimi
			if (parsed.type === "add" && KIMI_PATTERN.test(parsed.content)) {
				try {
					const rawResponse = await this.callKimi(parsed.content, this.messages);
					const { chat, css } = extractCss(rawResponse);

					// Send Kimi's chat response
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

					// Apply CSS changes
					if (css) {
						this.saveCss(css);
						this.broadcastMessage({ type: "css", css });
					}
				} catch (err) {
					console.error("Kimi AI error:", err);
				}
			}
		}
	}
}

export default {
	async fetch(request, env) {
		return (
			(await routePartykitRequest(request, { ...env })) ||
			env.ASSETS.fetch(request)
		);
	},
} satisfies ExportedHandler<Env>;
