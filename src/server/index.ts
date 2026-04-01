import {
	type Connection,
	Server,
	type WSMessage,
	routePartykitRequest,
} from "partyserver";

import type { ChatMessage, Message, Page } from "../shared";

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
	pageAdds: { slug: string; title: string; abstract: string; body: string }[];
	pageEdits: { slug: string; title?: string; abstract?: string; body?: string }[];
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

	// Extract page-add blocks: ```page-add\nslug: ...\ntitle: ...\nabstract: ...\n---\nbody HTML\n```
	const pageAdds: KimiAction["pageAdds"] = [];
	const pageAddRegex = /```page-add\s*\n([\s\S]*?)```/g;
	for (const match of text.matchAll(pageAddRegex)) {
		const parts = match[1].split(/\n---\n/);
		if (parts.length >= 2) {
			const header = parts[0];
			const body = parts.slice(1).join("\n---\n").trim();
			const slug = header.match(/slug:\s*(.+)/)?.[1]?.trim() || "";
			const title = header.match(/title:\s*(.+)/)?.[1]?.trim() || "";
			const abstract = header.match(/abstract:\s*(.+)/)?.[1]?.trim() || "";
			if (slug && title) {
				pageAdds.push({ slug, title, abstract, body });
			}
		}
		chat = chat.replace(match[0], "").trim();
	}

	// Extract page-edit blocks: ```page-edit slug=<slug>\ntitle: ...\nabstract: ...\n---\nnew body\n```
	const pageEdits: KimiAction["pageEdits"] = [];
	const pageEditRegex = /```page-edit\s+slug=(\S+)\s*\n([\s\S]*?)```/g;
	for (const match of text.matchAll(pageEditRegex)) {
		const slug = match[1];
		const content = match[2];
		const parts = content.split(/\n---\n/);
		const header = parts[0];
		const body = parts.length >= 2 ? parts.slice(1).join("\n---\n").trim() : undefined;
		const title = header.match(/title:\s*(.+)/)?.[1]?.trim();
		const abstract = header.match(/abstract:\s*(.+)/)?.[1]?.trim();
		if (title || abstract || body) {
			pageEdits.push({ slug, title, abstract, body });
		}
		chat = chat.replace(match[0], "").trim();
	}

	return { chat, cssAdd: cssAdd.trim() || null, cssEdits, cssReset, clearMessages, edits, pageAdds, pageEdits };
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

const DEFAULT_PAGES: Page[] = [
	{
		slug: "golden-contour",
		title: "\u2234 Golden Contour Integrals",
		abstract: "\u2220\u22C5\u2236 residues of rational functions at powers of the golden ratio.",
		body: `<p>Let <span class="k">\\varphi = \\frac{1+\\sqrt{5}}{2}</span> and consider the rational function <span class="k">f(z) = \\frac{1}{z^2 - z - 1}</span>. Its poles are at <span class="k">z = \\varphi</span> and <span class="k">z = 1 - \\varphi = -1/\\varphi</span>. We compute</p>
<div class="tex-block"><span class="kb">\\text{Res}_{z=\\varphi}\\, f = \\frac{1}{2\\varphi - 1} = \\frac{1}{\\sqrt{5}}</span></div>
<p>Let <span class="k">\\gamma</span> be a positively oriented circle of radius 2 centered at the origin. Both poles lie inside <span class="k">\\gamma</span>, so by the residue theorem</p>
<div class="tex-block"><span class="kb">\\oint_\\gamma \\frac{dz}{z^2 - z - 1} = 2\\pi i \\left( \\frac{1}{\\sqrt{5}} + \\frac{-1}{\\sqrt{5}} \\right) = 0</span></div>
<p>This vanishing is not a coincidence. For any monic quadratic with distinct roots, the sum of residues of <span class="k">1/(z^2 + bz + c)</span> is always zero.</p>
<p>The <span class="k">n</span>-th Fibonacci number satisfies <span class="k">F_n = \\frac{\\varphi^n - \\psi^n}{\\sqrt{5}}</span> where <span class="k">\\psi = -1/\\varphi</span>. We can recover this via</p>
<div class="tex-block"><span class="kb">F_n = \\frac{1}{2\\pi i} \\oint_\\gamma \\frac{z^n}{z^2 - z - 1}\\, dz = \\frac{\\varphi^n - \\psi^n}{\\sqrt{5}}</span></div>
<p>Setting <span class="k">x = 1/10</span> gives the curious decimal <span class="k">\\sum F_n / 10^n = 10/89</span>.</p>`,
	},
	{
		slug: "random-walk-torus",
		title: "\u22C8 Random Walks on a Torus",
		abstract: "\u2261\u2237 mixing times for the discrete random walk on a torus.",
		body: `<p>Consider the simple random walk on the discrete torus <span class="k">\\mathbb{Z}_n \\times \\mathbb{Z}_n</span>: at each step, move to one of the 4 neighbors uniformly at random. The stationary distribution is uniform.</p>
<p>The transition matrix has eigenvalues indexed by <span class="k">(j,k) \\in \\mathbb{Z}_n^2</span>:</p>
<div class="tex-block"><span class="kb">\\lambda_{j,k} = \\frac{1}{2}\\left(\\cos\\frac{2\\pi j}{n} + \\cos\\frac{2\\pi k}{n}\\right)</span></div>
<p>The spectral gap is <span class="k">\\gamma = 1 - \\cos(2\\pi/n) = \\frac{2\\pi^2}{n^2} + O(n^{-4})</span>. The mixing time satisfies</p>
<div class="tex-block"><span class="kb">t_{\\text{mix}}(\\varepsilon) = \\Theta(n^2 \\log n)</span></div>
<p>Compare with the 1D cycle, where the mixing time is also <span class="k">\\Theta(n^2 \\log n)</span>. The torus is not faster despite having more edges; the bottleneck is the same Cheeger constant.</p>`,
	},
	{
		slug: "thin-categories",
		title: "\u2235 Thin Categories & Preorders",
		abstract: "\u223F\u2322 profunctors on posets and paraconsistent negation.",
		body: `<p>A thin category is a category in which every hom-set has at most one morphism. Writing <span class="k">a \\leq b</span> when <span class="k">\\text{Hom}(a,b) \\neq \\emptyset</span>:</p>
<div class="tex-block"><span class="kb">\\text{id}_a : a \\leq a \\quad\\text{(reflexivity)}</span></div>
<div class="tex-block"><span class="kb">a \\leq b,\\; b \\leq c \\;\\Longrightarrow\\; a \\leq c \\quad\\text{(transitivity)}</span></div>
<p>A profunctor <span class="k">P : \\mathcal{C}^{\\text{op}} \\times \\mathcal{C} \\to \\textbf{Bool}</span> on a thin category satisfies</p>
<div class="tex-block"><span class="kb">a' \\leq a,\\; P(a,b),\\; b \\leq b' \\;\\Longrightarrow\\; P(a', b')</span></div>
<p>Given a thin category with relation <span class="k">\\leq</span>, we can independently define a second relation <span class="k">\\not\\sim</span>. The pair is paraconsistent if we permit both simultaneously without deriving <span class="k">\\bot</span>.</p>`,
	},
	{
		slug: "bing-bong",
		title: "\u22A2 Bing/Bong",
		abstract: "\u22A8\u22A3 a categorical formalization of copular discourse.",
		body: `<p>We model the Bing/Bong discourse as a presented theory over a thin category. The objects are discourse entities:</p>
<div class="tex-block"><span class="kb">\\text{Ob} = \\{\\xi, \\bar\\xi, \\mu, \\nu, \\omega, \\phi, \\psi, g, b, \\beta^+, \\beta^-, \\beta^*, \\tau\\}</span></div>
<p>Since <span class="k">\\xi \\leq \\psi</span> and <span class="k">\\psi \\leq \\xi</span>, we get <span class="k">\\xi \\cong \\psi</span>. By transitivity, all of <span class="k">\\{\\xi, \\psi, \\mu, \\nu, \\omega, \\phi, \\beta^*\\}</span> collapse to a single equivalence class <span class="k">[\\xi]</span>.</p>
<p>The negative copula profunctor coexists with <span class="k">\\xi \\leq g</span> and <span class="k">\\bar\\xi \\leq b</span> without contradiction, because <span class="k">\\text{NotIs}</span> is a separate profunctor, not the negation of <span class="k">\\leq</span>.</p>
<p>The full presented theory is</p>
<div class="tex-block"><span class="kb">\\mathcal{T} = \\left(\\mathcal{C},\\; \\text{NotIs},\\; \\{P_v\\},\\; \\{N_v\\},\\; W\\right)</span></div>
<p>with <span class="k">|[\\xi]| = 7</span>, <span class="k">|[\\bar\\xi]| = 2</span>, and <span class="k">|\\{\\tau\\}| = 1</span>. The quotient category has exactly 3 objects.</p>`,
	},
];

function buildContext(messages: ChatMessage[], customCss: string, pages: Page[]): string {
	const recentIds = messages.slice(-30).map((m) => `  ${m.id} (${m.user}): ${m.content}`).join("\n");
	const currentCssSnippet = customCss ? `\n\nCustom CSS currently applied:\n${customCss}` : "\n\nNo custom CSS is currently applied.";
	const pagesSnippet = pages.length > 0
		? `\n\nCurrent Pages in the sidebar:\n${pages.map((p) => `  slug="${p.slug}" title="${p.title}" abstract="${p.abstract}"`).join("\n")}`
		: "\n\nNo pages yet.";
	return `You're chatting in a live room at gnome.science. Here are the recent messages:\n${recentIds}\n\nPage HTML structure:\n${PAGE_STRUCTURE}\n\nBase CSS (always loaded):\n${BASE_CSS}${currentCssSnippet}${pagesSnippet}\n\nYour custom CSS gets injected into a <style> tag in <head>, so it overrides the base styles above.\n\nYou have a few tools you can use by including fenced code blocks in your response. Totally optional — feel free to just chat.\n\n\`\`\`css-add — appends new CSS rules to what's already there.\n\`\`\`css-add\n.msg-body { color: red; }\n\`\`\`\n\n\`\`\`css-edit — tweaks existing custom CSS. Put the old snippet above a --- line and the replacement below.\n\`\`\`css-edit\n.msg-body { color: red; }\n---\n.msg-body { color: blue; }\n\`\`\`\n\n\`\`\`css-reset — wipes all custom CSS back to defaults.\n\`\`\`css-reset\n\`\`\`\n\n\`\`\`edit id=<message_id> — rewrites a message.\n\`\`\`edit id=abc123\nNew content\n\`\`\`\n\n\`\`\`clear-messages — wipes all chat messages.\n\`\`\`clear-messages\n\`\`\`\n\n\`\`\`page-add — creates a new page in the sidebar. Body is HTML. For math, use <span class="k">LaTeX</span> for inline or <span class="kb">LaTeX</span> for display math (rendered by KaTeX on the client).\n\`\`\`page-add\nslug: my-page\ntitle: My Page Title\nabstract: A short description\n---\n<p>Consider <span class="k">f(x) = x^2</span>. Then</p>\n<div class="tex-block"><span class="kb">\\\\int_0^1 f(x)\\\\,dx = \\\\frac{1}{3}</span></div>\n\`\`\`\n\n\`\`\`page-edit slug=<slug> — edits an existing page. Include only the fields you want to change. If changing body, put it below ---.\n\`\`\`page-edit slug=my-page\ntitle: Updated Title\nabstract: Updated description\n---\n<p>New body HTML</p>\n\`\`\`\n\nPlease use css-add or css-edit instead of plain css blocks so the tools work correctly.`;
}

export class Chat extends Server<Env> {
	static options = { hibernate: true };

	messages: ChatMessage[] = [];
	pages: Page[] = [];
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

		this.ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS pages (slug TEXT PRIMARY KEY, title TEXT, abstract TEXT, body TEXT)`,
		);

		this.messages = this.ctx.storage.sql
			.exec(`SELECT * FROM messages`)
			.toArray() as ChatMessage[];

		this.pages = this.ctx.storage.sql
			.exec(`SELECT * FROM pages`)
			.toArray() as Page[];

		// Seed default pages if empty
		if (this.pages.length === 0) {
			for (const page of DEFAULT_PAGES) {
				this.savePage(page);
			}
		}

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

		connection.send(
			JSON.stringify({
				type: "pages",
				pages: this.pages,
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

	savePage(page: Page) {
		const idx = this.pages.findIndex((p) => p.slug === page.slug);
		if (idx !== -1) {
			this.pages[idx] = page;
		} else {
			this.pages.push(page);
		}
		this.ctx.storage.sql.exec(
			`INSERT INTO pages (slug, title, abstract, body) VALUES (?, ?, ?, ?)
			 ON CONFLICT (slug) DO UPDATE SET title = ?, abstract = ?, body = ?`,
			page.slug, page.title, page.abstract, page.body,
			page.title, page.abstract, page.body,
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
		const contextMsg = { role: "user" as const, content: buildContext(recentMessages, this.customCss, this.pages) };

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

				let rawResponse: string | null;
				try {
					rawResponse = await this.callKimi(this.messages);
				} catch (e) {
					console.error("Kimi call failed:", e instanceof Error ? e.message : e);
					return;
				}
				if (!rawResponse) return;
				const { chat, cssAdd, cssEdits, cssReset, clearMessages, edits, pageAdds, pageEdits } = parseKimiResponse(rawResponse);

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

				for (const pa of pageAdds) {
					this.savePage(pa);
					this.broadcastMessage({ type: "page-update", page: pa });
				}

				for (const pe of pageEdits) {
					const existing = this.pages.find((p) => p.slug === pe.slug);
					if (existing) {
						const updated: Page = {
							...existing,
							...(pe.title !== undefined && { title: pe.title }),
							...(pe.abstract !== undefined && { abstract: pe.abstract }),
							...(pe.body !== undefined && { body: pe.body }),
						};
						this.savePage(updated);
						this.broadcastMessage({ type: "page-update", page: updated });
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
