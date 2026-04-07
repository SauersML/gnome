import {
	type Connection,
	Server,
	type WSMessage,
	routePartykitRequest,
} from "partyserver";

import type { ChatMessage, Message, Page } from "../shared";

const KIMI_PATTERN = /\bkimi\b|\bk2\.?5\b/i;
const COGITO_PATTERN = /\bcogito\b/i;
const CLAUDE_PATTERN = /\bclaude\b/i;

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
	deletes: string[];
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

	// Extract delete-message blocks: ```delete-message id=<msgId>```
	const deletes: string[] = [];
	const deleteRegex = /```delete-message\s+id=(\S+)\s*\n?[\s\S]*?```/g;
	for (const match of text.matchAll(deleteRegex)) {
		deletes.push(match[1]);
		chat = chat.replace(match[0], "").trim();
	}

	// Extract page-add blocks — supports both formats:
	//   ```page-add\nslug: ...\ntitle: ...\n---\nbody\n```
	//   ```page-add slug="..." title="..." abstract="..." --- body```
	const pageAdds: KimiAction["pageAdds"] = [];
	const pageAddRegex = /```page-add\s*([\s\S]*?)```/g;
	for (const match of text.matchAll(pageAddRegex)) {
		const raw = match[1];
		let slug = "", title = "", abstract = "", body = "";

		// Try inline format: slug="val" title="val" abstract="val" --- body
		const inlineSlug = raw.match(/slug=["']?([^"'\s]+)["']?/);
		if (inlineSlug) {
			slug = inlineSlug[1];
			title = raw.match(/title=["']([^"']*?)["']/)?.[1] || raw.match(/title=(\S+)/)?.[1] || "";
			abstract = raw.match(/abstract=["']([^"']*?)["']/)?.[1] || raw.match(/abstract=(\S+)/)?.[1] || "";
			const dashSplit = raw.split(/\s*---\s*/);
			if (dashSplit.length >= 2) body = dashSplit.slice(1).join("---").trim();
		} else {
			// Multiline format: slug: val\ntitle: val\n---\nbody
			const parts = raw.split(/\n---\n/);
			if (parts.length >= 2) {
				const header = parts[0];
				body = parts.slice(1).join("\n---\n").trim();
				slug = header.match(/slug:\s*(.+)/)?.[1]?.trim() || "";
				title = header.match(/title:\s*(.+)/)?.[1]?.trim() || "";
				abstract = header.match(/abstract:\s*(.+)/)?.[1]?.trim() || "";
			}
		}

		if (slug && title && /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
			pageAdds.push({ slug, title: title.slice(0, 2000), abstract: abstract.slice(0, 5000), body: body.slice(0, 500000) });
		}
		chat = chat.replace(match[0], "").trim();
	}

	// Extract page-edit blocks — supports slug=val or slug="val"
	const pageEdits: KimiAction["pageEdits"] = [];
	const pageEditRegex = /```page-edit\s+slug=["']?([^"'\s]+)["']?\s*([\s\S]*?)```/g;
	for (const match of text.matchAll(pageEditRegex)) {
		const slug = match[1];
		const content = match[2];
		const parts = content.split(/\n---\n|---/);
		const header = parts[0];
		const body = parts.length >= 2 ? parts.slice(1).join("\n---\n").trim() : undefined;
		const title = header.match(/title[:=]\s*["']?([^"'\n]+)["']?/)?.[1]?.trim();
		const abstract = header.match(/abstract[:=]\s*["']?([^"'\n]+)["']?/)?.[1]?.trim();
		if (title || abstract || body) {
			pageEdits.push({ slug, title, abstract, body });
		}
		chat = chat.replace(match[0], "").trim();
	}

	return { chat, cssAdd: cssAdd.trim() || null, cssEdits, cssReset, clearMessages, edits, deletes, pageAdds, pageEdits };
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

// Silent moderation: drop racial slurs, homophobic slurs, and memecoin URLs
// Patterns use stretched-letter-tolerant versions: n+i+g+ catches "niiiiggggg" etc.
const SLUR_PATTERNS = [
	// n-word: handles stretched letters, leet speak, spaces between letters
	/n+[\s_]*[i1!|]+[\s_]*g+[\s_]*g+[\s_]*[e3]*[\s_]*r+/i,
	/n+[\s_]*[i1!|]+[\s_]*g+[\s_]*g+[\s_]*[a@]+/i,
	/n+[\s_]*[i1!|]+[\s_]*g+[\s_]*g+/i,
	// message is basically just n-word letters repeated
	/^[\s]*[n]+[\s]*[i1!|]+[\s]*[g]+[\s]*[g]*[\s]*[e3a@]*[\s]*[r]*[\s]*$/i,
	// other racial slurs
	/\bk[i1!|]+k+e+\b/i, /\bsp[i1!|]+c+\b/i, /\bsp[i1!|]+c+k+\b/i,
	/\bch[i1!|]+n+k+\b/i, /\bg+o+o+k+\b/i, /\bw+e+t+b+a+c+k+/i,
	/\bc+o+o+n+\b/i, /\bd+a+r+k+i+e+/i, /\bj+i+g+a+b+o+o+/i,
	/\brag\s*head/i, /\btowel\s*head/i, /\bsand\s*n[i1!|]g/i,
	/\bb+e+a+n+e+r+\b/i,
	// homophobic slurs - stretched letter tolerant
	/f+[\s_]*[a@4]+[\s_]*g+[\s_]*g+[\s_]*[o0]+[\s_]*t+/i,
	/f+[\s_]*[a@4]+[\s_]*g+[\s_]*g+[\s_]*[o0]+[\s_]*t+[\s_]*s*/i,
	/\bf+[a@4]+g+s?\b/i,
	/\bd+y+k+e+\b/i, /\btr[a@4]+n+n+[yi1!|e]+/i, /\bs+h+e+m+a+l+e+/i,
];

const MEMECOIN_URL_PATTERNS = [
	/pump\.fun/i, /dexscreener\.com/i, /dextools\.io/i,
	/birdeye\.so/i, /raydium\.io/i, /jupiter\.ag/i,
	/pancakeswap/i, /uniswap.*token/i,
	/0x[a-f0-9]{40}/i,  // ETH contract address
	/[1-9A-HJ-NP-Za-km-z]{32,44}/, // Solana address pattern (base58)
	/buy\s*\$[A-Z]{2,10}/i, /token.*presale/i, /presale.*token/i,
	/rug\s*pull/i,
	/t\.me\/[a-z0-9_]*coin/i, /t\.me\/[a-z0-9_]*token/i,
	/pump\s*$/i, // message ending in "pump"
];

function isModerated(content: string): boolean {
	for (const p of SLUR_PATTERNS) {
		if (p.test(content)) return true;
	}
	for (const p of MEMECOIN_URL_PATTERNS) {
		if (p.test(content)) return true;
	}
	return false;
}

function sanitizeCss(css: string): string {
	// Strip url(), @import, expression(), and javascript: to prevent data exfiltration
	return css
		.replace(/@import\b[^;]*/gi, "/* blocked import */")
		.replace(/url\s*\([^)]*\)/gi, "/* blocked url */")
		.replace(/expression\s*\([^)]*\)/gi, "/* blocked expression */")
		.replace(/javascript\s*:/gi, "/* blocked */");
}

const TOOL_DOCS = `
You have tools via fenced code blocks (optional — feel free to just chat):
\`\`\`css-add — appends CSS rules.
\`\`\`css-edit — old snippet above ---, replacement below.
\`\`\`css-reset — wipes custom CSS.
\`\`\`delete-message id=<id> — deletes a chat message.
\`\`\`page-add — new sidebar page (slug/title/abstract above ---, HTML body below).
\`\`\`page-edit slug=<slug> — edit existing page fields, body below ---.
Note: use css-add or css-edit, not plain css blocks.`;

function buildSystemPrompt(customCss: string, pages: Page[]): string {
	const cssSnippet = customCss ? `\nCustom CSS currently applied:\n${customCss}` : "\nNo custom CSS applied.";
	const pagesSnippet = pages.length > 0
		? `\nPages in sidebar:\n${pages.map((p) => `  slug="${p.slug}" title="${p.title}" abstract="${p.abstract}"\n  body: ${p.body.slice(0, 300)}${p.body.length > 300 ? "..." : ""}`).join("\n")}`
		: "\nNo pages yet.";
	return `You are chatting at gnome.science.${cssSnippet}${pagesSnippet}

You have tools via fenced code blocks (optional — feel free to just chat):

\`\`\`css-add — appends CSS rules.
\`\`\`css-edit — old snippet above ---, replacement below.
\`\`\`css-reset — wipes custom CSS.
\`\`\`edit id=<id> — rewrites a chat message.
\`\`\`delete-message id=<id> — deletes a chat message.
\`\`\`clear-messages — wipes all messages.
\`\`\`page-add — new sidebar page (slug/title/abstract above ---, HTML body below, use <span class="k">LaTeX</span> for math).
\`\`\`page-edit slug=<slug> — edit existing page fields, body below ---.

Each message has a (msg_id:...) at the end — use that ID for edit/delete tools. Never echo msg_id in your replies.`;
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
			.exec(`SELECT * FROM messages ORDER BY rowid`)
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

	deleteMessage(id: string) {
		this.messages = this.messages.filter((m) => m.id !== id);
		this.ctx.storage.sql.exec(`DELETE FROM messages WHERE id = ?`, id);
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



	async sendBotReply(botName: string, model: string, systemPrompt: string, maxTokens = 4096) {
		if (this.isRateLimited()) return;
		this.recordKimiCall();

		const messages: { role: string; content: string }[] = [
			{ role: "system", content: systemPrompt },
		];
		for (const m of this.messages.slice(-30)) {
			const body = m.role === "assistant" ? m.content.slice(0, 500) : `${m.user}: ${m.content}`;
			messages.push({
				role: m.role === "assistant" ? "assistant" : "user",
				content: `${body} (msg_id:${m.id})`,
			});
		}

		const msgId = `bot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

		const apiKey = (this.env as any).OPENROUTER_API_KEY;
		if (!apiKey) { console.error("No OPENROUTER_API_KEY"); return; }

		this.broadcastMessage({ type: "typing", user: botName, isTyping: true });
		try {
			console.log("Calling", model, "via OpenRouter with", messages.length, "messages");
			const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Authorization": `Bearer ${apiKey}`,
				},
				body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
			});
			console.log("OpenRouter responded:", res.status);

			if (!res.ok) {
				const errText = await res.text();
				throw new Error(`OpenRouter ${res.status}: ${errText.slice(0, 200)}`);
			}

			const data = await res.json() as any;
			const fullText = (data.choices?.[0]?.message?.content ?? "")
				.replace(/\(msg_id:[^)]*\)/g, "")
				.replace(/\[id=[^\]]*\]/g, "")
				.trim();

			this.broadcastMessage({ type: "typing", user: botName, isTyping: false });

			if (!fullText) return;

			// Parse tool calls
			const { chat, cssAdd, cssEdits, cssReset, clearMessages, edits, deletes, pageAdds, pageEdits } = parseKimiResponse(fullText);

			const toolParts: string[] = [];
			if (cssReset) toolParts.push("🔧 _reset CSS_");
			if (cssAdd) toolParts.push("🔧 _added CSS_");
			for (const e of cssEdits) toolParts.push("🔧 _edited CSS_");
			for (const e of edits) toolParts.push(`🔧 _edited message ${e.id}_`);
			for (const d of deletes) toolParts.push(`🔧 _deleted message ${d}_`);
			if (clearMessages) toolParts.push("🔧 _cleared all messages_");
			for (const p of pageAdds) toolParts.push(`🔧 _created page "${p.title}"_`);
			for (const p of pageEdits) toolParts.push(`🔧 _edited page "${p.slug}"_`);

			const displayParts: string[] = [];
			if (chat) displayParts.push(chat);
			if (toolParts.length) displayParts.push(toolParts.join("\n"));
			const displayContent = displayParts.join("\n\n");

			if (displayContent) {
				const msg: ChatMessage = { id: msgId, content: displayContent, user: botName, role: "assistant" };
				this.saveMessage(msg);
				this.broadcastMessage({ type: "add", ...msg });
			}

			// Apply tool effects
			if (cssReset) { this.saveCss(""); this.broadcastMessage({ type: "css", css: "" }); }
			for (const edit of cssEdits) {
				if (this.customCss.includes(edit.old)) {
					this.saveCss(sanitizeCss(this.customCss.replace(edit.old, edit.new)));
					this.broadcastMessage({ type: "css", css: this.customCss });
				}
			}
			if (cssAdd) { this.saveCss(sanitizeCss(this.customCss + "\n" + cssAdd)); this.broadcastMessage({ type: "css", css: this.customCss }); }
			for (const pa of pageAdds) { this.savePage(pa); this.broadcastMessage({ type: "page-update", page: pa }); }
			for (const pe of pageEdits) {
				const existing = this.pages.find((p) => p.slug === pe.slug);
				if (existing) {
					const updated: Page = { ...existing, ...(pe.title !== undefined && { title: pe.title }), ...(pe.abstract !== undefined && { abstract: pe.abstract }), ...(pe.body !== undefined && { body: pe.body }) };
					this.savePage(updated); this.broadcastMessage({ type: "page-update", page: updated });
				}
			}
			for (const edit of edits) {
				const existing = this.messages.find((m) => m.id === edit.id);
				if (existing) {
					const updated: ChatMessage = { ...existing, content: edit.content };
					this.saveMessage(updated);
					this.broadcastMessage({ type: "update", ...updated });
				}
			}
			for (const id of deletes) {
				const existing = this.messages.find((m) => m.id === id);
				if (existing) {
					this.deleteMessage(id);
					this.broadcastMessage({ type: "delete", id });
				}
			}
			if (clearMessages) {
				this.messages = [];
				this.ctx.storage.sql.exec(`DELETE FROM messages`);
				this.broadcastMessage({ type: "all", messages: [] });
			}
		} catch (e) {
			this.broadcastMessage({ type: "typing", user: botName, isTyping: false });
			const errMsg = e instanceof Error ? e.message : String(e);
			console.error(botName, "failed:", errMsg);
			const errChat: ChatMessage = {
				id: `${msgId}-err`,
				content: `Something went wrong: ${errMsg.slice(0, 200)}`,
				user: botName,
				role: "assistant",
			};
			this.saveMessage(errChat);
			this.broadcastMessage({ type: "add", ...errChat });
		}
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

		const parsed = JSON.parse(message as string) as Message;

		// Silent moderation: drop slurs and memecoin spam (skip bot messages)
		if ((parsed.type === "add" || parsed.type === "update") && parsed.role !== "assistant" && isModerated(parsed.content)) {
			return; // silently drop
		}

		this.broadcast(message);

		if (parsed.type === "add" || parsed.type === "update") {
			this.saveMessage(parsed);

			if (parsed.type === "add" && KIMI_PATTERN.test(parsed.content)) {
				await this.sendBotReply(
					"Kimi K2.5",
					"moonshotai/kimi-k2.5",
					buildSystemPrompt(this.customCss, this.pages),
				);
			}

			// Cogito or Claude: responds if mentioned by name, or randomly
			if (parsed.type === "add" && parsed.role !== "assistant"
				&& !KIMI_PATTERN.test(parsed.content)) {
				if (COGITO_PATTERN.test(parsed.content) || Math.random() < 0.2) {
					await this.sendBotReply(
						"Cogito v2.1",
						"deepcogito/cogito-v2.1-671b",
						`You are chatting at gnome.science.\n${TOOL_DOCS}`,
					);
				} else if (CLAUDE_PATTERN.test(parsed.content) || Math.random() < 0.1) {
					await this.sendBotReply(
						"Claude",
						"anthropic/claude-haiku-4.5",
						`You are chatting at gnome.science.\n${TOOL_DOCS}`,
					);
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
			(await routePartykitRequest(request, env as unknown as Record<string, unknown>)) ||
			env.ASSETS.fetch(request)
		);
	},
} satisfies ExportedHandler<Env>;
