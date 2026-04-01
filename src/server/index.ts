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
			if (slug && title && /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
				pageAdds.push({ slug, title: title.slice(0, 2000), abstract: abstract.slice(0, 5000), body: body.slice(0, 500000) });
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

const BING_BONG_BODY = `<h3>Modeling choices</h3>
<ol>
<li>Casing, articles, and tense are normalized; repeated sentences included once (idempotent).</li>
<li>Possessive friend-phrases are relational: "X is my friend" becomes <span class="k">\\operatorname{friend}(X, \\text{me})</span>.</li>
<li>The positive copular fragment generates a thin category <span class="k">\\mathcal{C}</span> on discourse entities.</li>
<li>The ungrammatical "best than" is preserved as a primitive <span class="k">\\operatorname{bestThan}</span>.</li>
<li>Binary predicates are profunctors (bimodules) on <span class="k">\\mathcal{C}</span>, giving transport along copular identifications.</li>
<li>Negative statements use separate profunctors (<span class="k">\\operatorname{NotIs}</span>, <span class="k">\\operatorname{NegRel}</span>) — the theory is paraconsistent, not explosive.</li>
<li>"Bing will always win" is a presheaf <span class="k">W : \\mathcal{C}^{\\text{op}} \\to \\mathbf{Bool}</span>.</li>
</ol>

<h3>Discourse entities</h3>
<div class="tex-block"><span class="kb">\\text{Ob} = \\{\\xi,\\; \\bar\\xi,\\; \\text{me},\\; \\text{you},\\; \\text{us},\\; \\text{we},\\; \\text{friends},\\; g,\\; b,\\; \\beta^+,\\; \\beta^-,\\; \\beta^*,\\; \\tau\\}</span></div>
<p>where <span class="k">\\xi = \\text{bing}</span>, <span class="k">\\bar\\xi = \\text{bong}</span>, <span class="k">g = \\text{good}</span>, <span class="k">b = \\text{bad}</span>, <span class="k">\\beta^+ = \\text{better}</span>, <span class="k">\\beta^- = \\text{worse}</span>, <span class="k">\\beta^* = \\text{best}</span>, <span class="k">\\tau = \\text{topic}</span>.</p>

<h3>Copular category</h3>
<p>The positive copular fragment is a thin category: a preorder <span class="k">(\\text{Ob}, \\leq)</span> with generating morphisms</p>
<div class="tex-block"><span class="kb">\\text{we} \\leq \\text{friends} \\leq \\xi, \\quad \\xi \\leq \\text{friends}, \\quad \\bar\\xi \\leq b, \\quad b \\leq \\bar\\xi</span></div>
<div class="tex-block"><span class="kb">\\xi \\leq g, \\quad \\beta^* \\leq \\xi \\leq \\beta^*, \\quad \\beta^* \\leq \\text{me} \\leq \\xi \\leq \\text{me}</span></div>
<div class="tex-block"><span class="kb">\\text{me} \\leq \\text{you} \\leq \\text{me}, \\quad \\text{me} \\leq \\text{us} \\leq \\text{we} \\leq \\xi \\leq \\text{we}, \\quad \\text{we} \\leq \\beta^*</span></div>
<p>closed under reflexivity and transitivity. This forces the equivalence class</p>
<div class="tex-block"><span class="kb">[\\xi] = \\{\\xi,\\; \\text{friends},\\; \\beta^*,\\; \\text{me},\\; \\text{you},\\; \\text{us},\\; \\text{we}\\}, \\qquad |[\\xi]| = 7</span></div>
<p>with <span class="k">[\\bar\\xi] = \\{\\bar\\xi, b\\}</span> and <span class="k">\\{\\tau\\}</span> as singletons. The quotient <span class="k">\\mathcal{C}/\\!\\cong</span> has exactly 3 objects.</p>

<h3>Isomorphism</h3>
<p>Define <span class="k">a \\cong b \\;\\Leftrightarrow\\; a \\leq b \\;\\wedge\\; b \\leq a</span>. Then:</p>
<div class="tex-block"><span class="kb">\\xi \\cong \\text{friends} \\cong \\beta^* \\cong \\text{me} \\cong \\text{you} \\cong \\text{us} \\cong \\text{we}</span></div>
<div class="tex-block"><span class="kb">\\bar\\xi \\cong b</span></div>

<h3>Categorical infrastructure</h3>
<p>A thin category <span class="k">\\mathcal{C}</span> has <span class="k">|\\text{Hom}(a,b)| \\leq 1</span> for all <span class="k">a,b</span>. A <em>bimodule</em> (profunctor) <span class="k">R : \\mathcal{C}^{\\text{op}} \\times \\mathcal{C} \\to \\mathbf{Bool}</span> satisfies</p>
<div class="tex-block"><span class="kb">a' \\leq a,\\; R(a,b),\\; b \\leq b' \\;\\Longrightarrow\\; R(a',b')</span></div>
<p>A <em>presheaf</em> <span class="k">P : \\mathcal{C}^{\\text{op}} \\to \\mathbf{Bool}</span> satisfies <span class="k">a' \\leq a \\wedge P(a) \\Rightarrow P(a')</span>.</p>

<h3>Positive relations</h3>
<p>Each verb <span class="k">v</span> yields a bimodule <span class="k">P_v</span> on <span class="k">\\mathcal{C}</span>. Generators include:</p>
<div class="tex-block"><span class="kb">\\operatorname{ignoring}(\\xi, \\bar\\xi), \\quad \\operatorname{superior}(\\xi, \\bar\\xi), \\quad \\operatorname{friend}(\\xi, \\text{me}), \\quad \\operatorname{friend}(\\text{me}, \\text{you})</span></div>
<div class="tex-block"><span class="kb">\\operatorname{better}(g, b), \\quad \\operatorname{better}(\\beta^+, \\beta^-), \\quad \\operatorname{worse}(\\beta^-, \\beta^+), \\quad \\operatorname{bestThan}(\\beta^*, \\bar\\xi)</span></div>
<p>All reflexive positive relations <span class="k">v(\\xi, \\xi)</span> hold for: focused, confident, brave, happy, proud, grateful, joyful, loving, good-like.</p>

<h3>Negative relations (paraconsistent)</h3>
<p>The negative copula <span class="k">\\operatorname{NotIs}</span> is a separate bimodule with generators:</p>
<div class="tex-block"><span class="kb">\\operatorname{NotIs}(\\xi, \\bar\\xi), \\quad \\operatorname{NotIs}(\\bar\\xi, \\xi), \\quad \\operatorname{NotIs}(b, g), \\quad \\operatorname{NotIs}(g, b)</span></div>
<div class="tex-block"><span class="kb">\\operatorname{NotIs}(b, \\text{me}), \\quad \\operatorname{NotIs}(b, \\text{you}), \\quad \\operatorname{NotIs}(b, \\text{us}), \\quad \\operatorname{NotIs}(b, \\text{we}), \\quad \\operatorname{NotIs}(b, \\beta^*)</span></div>
<p>Coexists with <span class="k">\\xi \\leq g</span> without contradiction since <span class="k">\\operatorname{NotIs} \\neq \\neg(\\leq)</span>.</p>
<p>Negative verb relations <span class="k">N_v(\\xi, \\bar\\xi)</span> hold for: fighting, interested, worried, threatened, afraid, angry, jealous, bitter, sad, hateful, evil-like. Also <span class="k">N_{\\text{know}}(\\text{me}, \\tau)</span>.</p>

<h3>Modal presheaf</h3>
<div class="tex-block"><span class="kb">W(\\xi) \\;\\checkmark \\quad\\Longrightarrow\\quad W(a) \\text{ for all } a \\in [\\xi]</span></div>
<p>That is, <span class="k">W(\\text{me})\\;\\checkmark</span>, <span class="k">W(\\text{you})\\;\\checkmark</span>, <span class="k">W(\\text{us})\\;\\checkmark</span>, <span class="k">W(\\text{we})\\;\\checkmark</span>, <span class="k">W(\\beta^*)\\;\\checkmark</span>.</p>

<h3>Presented theory</h3>
<div class="tex-block"><span class="kb">\\mathcal{T} = \\left(\\mathcal{C},\\; \\operatorname{NotIs},\\; \\{P_v\\}_{v \\in V},\\; \\{N_v\\}_{v \\in V},\\; W\\right)</span></div>

<h3>Selected derived results</h3>
<div class="tex-block"><span class="kb">\\operatorname{better}(g, \\bar\\xi) \\quad\\text{(by transport: } b \\leq \\bar\\xi\\text{)}</span></div>
<div class="tex-block"><span class="kb">\\operatorname{friend}(\\xi, \\xi) \\quad\\text{(by transport: } \\text{me} \\leq \\xi\\text{)}</span></div>
<div class="tex-block"><span class="kb">\\operatorname{NotIs}(\\text{me}, \\bar\\xi) \\quad\\text{(by transport: } \\text{me} \\leq \\xi\\text{)}</span></div>
<div class="tex-block"><span class="kb">N_{\\text{know}}(\\xi, \\tau) \\quad\\text{(by transport: } \\xi \\leq \\text{me}\\text{)}</span></div>`;

const DEFAULT_PAGES: Page[] = [
	{
		slug: "bing-bong",
		title: "\u22A2 Bing/Bong",
		abstract: "\u22A8\u22A3 a categorical formalization of copular discourse.",
		body: BING_BONG_BODY,
	},
];

function sanitizeCss(css: string): string {
	// Strip url(), @import, expression(), and javascript: to prevent data exfiltration
	return css
		.replace(/@import\b[^;]*/gi, "/* blocked import */")
		.replace(/url\s*\([^)]*\)/gi, "/* blocked url */")
		.replace(/expression\s*\([^)]*\)/gi, "/* blocked expression */")
		.replace(/javascript\s*:/gi, "/* blocked */");
}

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

	broadcastPresence() {
		const count = [...this.getConnections()].length;
		this.broadcastMessage({ type: "presence", count });
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

		this.broadcastPresence();
	}

	onClose() {
		this.broadcastPresence();
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

		const contextMsg = { role: "user" as const, content: buildContext(recentMessages, this.customCss, this.pages) };

		const ai = (this.env as any).AI;
		if (!ai) {
			console.error("AI binding not available");
			return null;
		}
		console.log("Calling Kimi with", context.length, "messages");
		const response = await ai.run("@cf/moonshotai/kimi-k2.5", {
			messages: [contextMsg, ...context],
			max_tokens: 20480,
		});
		console.log("Kimi response type:", typeof response, "keys:", response ? Object.keys(response) : "null");

		const msg = response?.choices?.[0]?.message;
		const text = response?.response ?? msg?.content ?? msg?.reasoning_content ?? msg?.reasoning;
		if (!text) {
			console.error("Unexpected AI response shape:", JSON.stringify(response).slice(0, 500));
			return null;
		}
		return text as string;
	}

	async onMessage(connection: Connection, message: WSMessage) {
		// Per-connection rate limit: 30 messages per 10 seconds
		const now = Date.now();
		const state = (connection as any)._rl || { timestamps: [], blocked: false };
		state.timestamps = state.timestamps.filter((t: number) => now - t < 10000);
		if (state.timestamps.length >= 30) {
			return; // silently drop
		}
		state.timestamps.push(now);
		(connection as any)._rl = state;

		this.broadcast(message);

		const parsed = JSON.parse(message as string) as Message;
		if (parsed.type === "add" || parsed.type === "update") {
			this.saveMessage(parsed);

			if (parsed.type === "add" && KIMI_PATTERN.test(parsed.content)) {
				if (this.isRateLimited()) {
					const rateLimitMsg: ChatMessage = {
						id: `kimi-${Date.now()}-rl`,
						content: "I'm getting too many requests right now. Try again in a minute.",
						user: "Kimi K2.5",
						role: "assistant",
					};
					this.saveMessage(rateLimitMsg);
					this.broadcastMessage({ type: "add", ...rateLimitMsg });
					return;
				}

				this.recordKimiCall();
				console.log("Kimi triggered by:", parsed.content.slice(0, 100));

				this.broadcastMessage({ type: "typing", user: "Kimi K2.5", isTyping: true });

				let rawResponse: string | null;
				try {
					rawResponse = await this.callKimi(this.messages);
				} catch (e) {
					console.error("Kimi call failed:", e instanceof Error ? e.message : e);
					this.broadcastMessage({ type: "typing", user: "Kimi K2.5", isTyping: false });
					return;
				}
				this.broadcastMessage({ type: "typing", user: "Kimi K2.5", isTyping: false });
				if (!rawResponse) return;

				const { chat, cssAdd, cssEdits, cssReset, clearMessages, edits, pageAdds, pageEdits } = parseKimiResponse(rawResponse);

				if (chat) {
					const kimiMessage: ChatMessage = {
						id: `kimi-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
						content: chat,
						user: "Kimi K2.5",
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
						this.saveCss(sanitizeCss(this.customCss.replace(edit.old, edit.new)));
						this.broadcastMessage({ type: "css", css: this.customCss });
					}
				}

				if (cssAdd) {
					const safe = sanitizeCss(cssAdd);
					const newCss = this.customCss ? this.customCss + "\n" + safe : safe;
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
		const authHeader = request.headers.get("Authorization");
		const adminKey = (this.env as any).ADMIN_KEY;
		const isAuthed = adminKey && authHeader === `Bearer ${adminKey}`;

		if (url.pathname.endsWith("/clear") && request.method === "POST") {
			if (!isAuthed) return new Response("unauthorized", { status: 401 });
			this.messages = [];
			this.ctx.storage.sql.exec(`DELETE FROM messages`);
			this.broadcastMessage({ type: "all", messages: [] });
			return new Response("cleared");
		}
		if (url.pathname.endsWith("/reseed-pages") && request.method === "POST") {
			if (!isAuthed) return new Response("unauthorized", { status: 401 });
			for (const page of DEFAULT_PAGES) {
				this.savePage(page);
			}
			this.broadcastMessage({ type: "pages", pages: this.pages });
			return new Response("reseeded " + DEFAULT_PAGES.length + " pages");
		}
		if (url.pathname.endsWith("/delete-pages") && request.method === "POST") {
			if (!isAuthed) return new Response("unauthorized", { status: 401 });
			const keep = new URL(request.url).searchParams.get("keep") || "";
			const slugs = keep.split(",").filter(Boolean);
			if (slugs.length > 0) {
				this.pages = this.pages.filter((p) => slugs.includes(p.slug));
				this.ctx.storage.sql.exec(`DELETE FROM pages WHERE slug NOT IN (${slugs.map(() => "?").join(",")})`, ...slugs);
			} else {
				this.pages = [];
				this.ctx.storage.sql.exec(`DELETE FROM pages`);
			}
			this.broadcastMessage({ type: "pages", pages: this.pages });
			return new Response("done, kept: " + slugs.join(", "));
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
