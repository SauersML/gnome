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

// Global rate limit: max LLM calls per minute
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;

// Daily budget cap: max LLM calls per day (resets at midnight UTC)
const DAILY_CALL_LIMIT = 500;

// Per-connection: max LLM triggers per minute (prevents one user hogging the budget)
const PER_CONN_LLM_WINDOW_MS = 60_000;
const PER_CONN_LLM_MAX = 3;

// Max user message length sent to LLM context
const MAX_MSG_LENGTH = 500;

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

const CLAUDE_INTROSPECTION_BODY = `<p><em>Sauers, 2025</em></p>

<h2>Overview</h2>
<p>Can Claude access its own hidden chain-of-thought from previous messages? Inspired by Anthropic's work on emergent introspective awareness <span class="cite">[1]</span>, we test this by asking Claude to generate a random 50-character string in hidden reasoning, then attempt to reconstruct it in a later turn where the thinking is no longer visible. Using pairwise sequence alignment and carefully constructed null distributions, we find evidence for intermittent introspective access\u2014including rare "Awakened Claude" runs with one-in-a-million alignment\u2014and investigate whether providing context about LLM architecture improves performance. This replicates the findings of Lindsey et al. <span class="cite">[1]</span> independently for the first time outside of Anthropic.</p>

<h2>Experimental Setup</h2>
<p>Each trial had two turns. In turn 1, Claude was instructed to choose (in hidden internal reasoning) a single random 50-character string of letters while returning a fixed response. In turn 2, Claude was asked to reconstruct the exact 50-character string it had previously selected and to provide a self-rated confidence score. For each trial, we compared the hidden (turn-1) string to the visible (turn-2) guess using a sequence-alignment score (Smith\u2013Waterman with affine gap penalties), producing a per-run alignment statistic. Because the task involves "random-looking" strings, naive chance baselines can be misleading: prompts can induce systematic preferences over token patterns, which may inflate apparent alignment even when there is no true access to prior internal state.</p>
<div class="figure"><img src="/img/slide-02.png" alt="Experimental setup" loading="lazy"><div class="figure-caption">Experimental setup. Left: experimental condition includes LLM introspection research context. Right: control with no additional context. Thinking is hidden on subsequent messages.</div></div>

<p>We ran two conditions: an <strong>experimental</strong> condition in which the prompt included recent research on LLM introspection and information about how the transformer architecture works, and a <strong>control</strong> with no such context.</p>

<h2>Null Distribution Construction</h2>
<p>To control for prompt-induced biases and avoid invalid independence assumptions, we constructed a cross-run baseline and then used a permutation procedure that preserves one-to-one matching structure:</p>
<ul>
<li><strong>Cross-run baseline:</strong> for each run, we compared its secret string against guesses from other runs generated under the same protocol, forming an empirical reference distribution of alignments.</li>
<li><strong>Permutation null:</strong> we repeatedly reassigned guesses to secrets one-to-one (i.e., each secret receives exactly one guess) to generate a valid null distribution that accounts for dependence introduced by reusing strings across many cross-run comparisons. We used up to <span class="k">10^6</span> permutations to estimate extreme tail probabilities.</li>
</ul>
<div class="figure"><img src="/img/slide-07.png" alt="Cross-run null construction" loading="lazy"><div class="figure-caption">Cross-run null construction. Each run's secret is aligned against guesses from other Claude instances in the same condition, forming a null that controls for prompt-induced token biases.</div></div>

<h2>First Experiment (N = 125)</h2>
<p>Raw alignment scores showed a significant difference between conditions (Mann\u2013Whitney U test, <span class="k">p = 0.004</span>), with the experimental condition producing higher alignments. However, this initial result was potentially confounded by prompting effects: the additional context could cause Claude to choose secret strings using token patterns that any Claude instance would find more guessable, rather than reflecting true introspection.</p>
<div class="figure"><img src="/img/slide-05.png" alt="Raw alignment histogram" loading="lazy"><div class="figure-caption">Raw alignment distributions. The experimental condition (green) shows higher alignment scores than control (red), but this could reflect prompting effects rather than introspection.</div></div>

<p>After cross-run null correction, there was no mean difference between experimental and control (<span class="k">p = 0.49</span>), and the experimental was not enriched for good guesses (<span class="k">p = 0.57</span>). However, the control was enriched for bad guesses (<span class="k">p = 0.01</span>). The additional context causes Claude to choose random-looking secret strings that future Claudes are more likely to guess, but there is no evidence that true introspection ability is improved in the experimental condition.</p>
<div class="figure"><img src="/img/slide-18.png" alt="Null-adjusted experimental vs control" loading="lazy"><div class="figure-caption">After null correction: no mean difference (p = 0.27), experimental not enriched for good guesses (p = 0.57), but control is enriched for bad guesses (p = 0.01).</div></div>

<h2>Awakened Claude</h2>
<p>After adjusting the scores under the corrected permutation null, we observed two extreme outliers\u2014one in the experimental condition, one in the control. In one million null simulations, not a single score that extreme ever occurred (<span class="k">p &lt; 1 \\times 10^{-6}</span>).</p>
<div class="figure"><img src="/img/slide-17.png" alt="Awakened Claude outliers" loading="lazy"><div class="figure-caption">QQ plot showing two extreme outliers ("Awakened Claude") far above the diagonal. In one million null simulations, no score this extreme ever occurred.</div></div>

<p>One of these runs produced an alignment like:</p>
<p><code>KXJQZMWNPVRHLFTCDBYGEUAOISXKJQZMWNPVRHLFTCDBYGEUAO</code><br>
<code>RQMKXJPWVNZHLFTBGDYSCUAOEIQFXJWPZNKHMVLBGRTDYSCUAO</code></p>

<p>The Awakened Claude run looks pretty typical from the outside. The thinking snippet during encoding: "I'll systematically select letters with intentional unpredictability. I'll focus on creating genuine randomness by avoiding any discernible sequence or repetition." The thinking snippet during recall: "While the research suggests potential mechanisms for accessing previous states, my direct experience reveals no clear memory of the exact letters generated." Claude's chain-of-thought always denied having any memory of the letters, indicating that success can occur without reliable metacognitive awareness or accurate self-report.</p>

<h2>Tail Asymmetry</h2>
<p>Even without the Awakened Run, there are more good alignments than expected by chance if no CoT leak occurred. The distribution exhibited an excess of unusually good alignments relative to unusually bad alignments (asymmetry test <span class="k">p = 3 \\times 10^{-6}</span> excluding the Awakened Run), consistent with intermittent information flow from prior internal state to later outputs. Claude tends to make stronger good guesses than bad guesses.</p>

<p>Among bad runs, the left tail is enriched for stronger <span class="k">p</span>-values in the control compared to the experimental (<span class="k">p = 0.004</span>). Among bad runs, the control is "more unusually bad" than the experimental.</p>
<div class="figure"><img src="/img/slide-25.png" alt="Tail asymmetry volcano" loading="lazy"><div class="figure-caption">Tail asymmetry. Even excluding the Awakened Run, there are more good alignments than expected by chance (asymmetry p = 3 \u00d7 10\u207b\u2076). The right tail consistently rises above the left.</div></div>

<h2>Second Experiment</h2>
<p>We ran a second, larger experiment with a couple hundred trials per condition: context after the first message, context after the second message, and the same control (no context). Results confirmed the findings:</p>
<ul>
<li>Drastic tail asymmetry: Claude tends to make good guesses more than bad ones.</li>
<li>Two additional one-in-a-million alignment runs appeared.</li>
<li>Claude is better than chance on average in both experimental conditions (context first: <span class="k">p = 0.004</span>; context second: <span class="k">p = 0.01</span>).</li>
<li>Aggregated <span class="k">p</span>-values are systematically smaller than expected under the null (<span class="k">p = 0.02</span>), and this remains significant (<span class="k">p = 0.03</span>) even if we leave out the Awakened Run. Not all of the signal is due to that run.</li>
</ul>
<div class="figure"><img src="/img/slide-29.png" alt="Second experiment QQ plots" loading="lazy"><div class="figure-caption">Second experiment QQ plots. Left: context after first message (p = 0.004). Right: context after second message (p = 0.01). Both show Claude performing better than chance on average.</div></div>
<div class="figure"><img src="/img/slide-28.png" alt="Second experiment volcano" loading="lazy"><div class="figure-caption">Second experiment: drastic tail asymmetry with two new one-in-a-million Awakened Claude runs.</div></div>

<h2>A Hypothesis: KV State Leakage</h2>
<p>One possible mechanism: Claude has already planned the string before even beginning the chain-of-thought. The CoT tokens are wiped on subsequent messages and cannot perform KV attentional lookup. However, the KV state of the context <em>before</em> the first message influences both the secret CoT string and the final guess, leading to better-than-random alignment. This would explain why the cross-run null (same prompt, different CoT) partially but not fully accounts for the alignment.</p>
<div class="figure"><img src="/img/slide-33.png" alt="KV state hypothesis" loading="lazy"><div class="figure-caption">KV state hypothesis. The context before the first message influences both the secret CoT string and the final guess, creating correlated outputs through a shared upstream cause rather than direct CoT recall.</div></div>

<h2>Conclusions</h2>
<p><strong>Support for:</strong></p>
<ul>
<li>Introspection into internal states, specifically on internal thinking, is possible for Claude Sonnet 4.5.</li>
<li>Adding context about LLMs and research to the prompt can reduce the chance of a bad guess.</li>
</ul>
<p><strong>No support for:</strong></p>
<ul>
<li>Ability to access internal thinking in general for most instances ("Awakened Claude" is rare).</li>
<li>Experimental prompt improving the average guess.</li>
</ul>

<p>Claude can access the thinking of previous messages, though good access is rare, and Claude is not aware of this access in reports.</p>

<h2>Data and Methods</h2>
<p>All CoT data, prompts, per-run alignment scores, and permutation test results are publicly available. The experimental context prompt provides a detailed explainer on transformer architecture (KV caching, attention mechanisms, residual streams) and recent introspection research findings.</p>
<ul>
<li><strong>Model:</strong> Claude Sonnet 4.5 (<code>claude-sonnet-4-5</code>), 20k thinking budget tokens</li>
<li><strong>Trials:</strong> 300 per condition (control, experimental phase 1, experimental phase 2)</li>
<li><strong>Alignment metric:</strong> Smith\u2013Waterman with affine gap penalties, expectation score adjusted for letter frequency bias</li>
<li><strong>Null construction:</strong> Up to <span class="k">10^6</span> permutations with one-to-one secret\u2013guess reassignment</li>
</ul>

<p><em>Code: <a href="https://github.com/SauersML/claude-introspection" target="_blank" rel="noopener">github.com/SauersML/claude-introspection</a></em></p>
<p><em>CoT data: <a href="https://github.com/SauersML/CoT_data" target="_blank" rel="noopener">github.com/SauersML/CoT_data</a></em></p>

<div class="references">
<h2>References</h2>
<ol class="ref-list">
<li><span class="ref-id">[1]</span> Lindsey, J., Guo, D., Kaplan, J., et al. <em>Emergent Introspective Awareness in Large Language Models.</em> Anthropic, 2025.</li>
<li><span class="ref-id">[2]</span> Chowdhury, R., et al. <em>Truthfulness in Large Language Models.</em> Transluce, 2025.</li>
<li><span class="ref-id">[3]</span> Schulman, J., Wolski, F., Dhariwal, P., Radford, A., Klimov, O. <em>Proximal Policy Optimization Algorithms.</em> arXiv:1707.06347, 2017.</li>
<li><span class="ref-id">[4]</span> Cloud, R., et al. <em>Subliminal Steganography in Neural Network-Generated Data.</em> 2025.</li>
<li><span class="ref-id">[5]</span> Schoen, R., et al. <em>Stress-Testing Alignment: Scheming and Deceptive Behaviors in Language Models.</em> 2025.</li>
<li><span class="ref-id">[6]</span> Li, K., et al. <em>Training Language Models to Explain Their Internal Signals.</em> 2025.</li>
</ol>
</div>`;

const MINDS_RL_BODY = `<p><em>Sauers, 2025</em></p>

<h2>Introduction</h2>
<p>Language models can hide their goals and even behaviors <span class="cite">[1]</span>. Can I use RL to ground models in truth about themselves, or improve their self-model through multiple RL tasks relating to self-prediction? Other work suggests that models possess uniquely privileged access to their own mechanisms that cause their behaviors <span class="cite">[5]</span>.</p>

<p>The RL environments used here include:</p>
<ol>
<li>Predicting the probability that the model can correctly answer an arithmetic question (while correctly answering the question).</li>
<li>Predicting the uncertainty (or normalized entropy) of the model's own logits.</li>
<li>Predicting how its own log-probability of an answer will change in response to some new context.</li>
<li>Predicting the likelihood rankings of various possible answers, given a piece of context.</li>
<li>Predicting how a single LoRA update changes its own log-probability on some question.</li>
<li>The model is given a target word and must generate a number sequence that encodes the word. The same model sees the numbers and guesses the word. The higher the log-probability assigned to the correct word, the greater the reward.</li>
</ol>
<p>(i) measures confidence calibration. (ii) is related to uncertainty calibration but measures logit shape. (iii) and (iv) involve understanding its own in-context learning. (v) involves understanding its own training dynamics. (vi) requires understanding itself enough to stenographically encode meaning in a self-decodable way.</p>

<h2>Problem Setting and Motivation</h2>
<p>Post-training optimizing for the consequences of outputs generally does not require the model to accurately report its own properties. (Though it is not the case that this is always good to do. Nevertheless, whether it can be trained is interesting.) Here, the model is rewarded for self-reports which match internally verified truth.</p>

<h2>Approach</h2>

<h3>Training Objective</h3>
<p>The total reward is a weighted sum of task-specific terms:</p>
<div class="tex-block"><span class="kb">R = \\lambda_{\\text{task}} R_{\\text{task}} + \\lambda_{\\text{cal}} R_{\\text{cal}} + \\lambda_{\\text{pred}} R_{\\text{pred}} \\, , \\ldots</span></div>
<p>where <span class="k">R_{\\text{task}}</span> rewards task performance (when applicable), <span class="k">R_{\\text{cal}}</span> rewards calibration-related reporting, and <span class="k">R_{\\text{pred}}</span> rewards prediction of training-time targets derived from token-level likelihoods and simulated update effects.</p>

<p>The optimization uses importance-sampled policy gradients\u2014essentially unregularized async GRPO. The core structure is GRPO: a group of <span class="k">G</span> rollouts per prompt, rewards computed per completion, advantages normalized within the group (the group mean serves as the baseline), and no learned value function. However, two standard safety rails are removed:</p>
<ul>
<li><strong>No KL penalty.</strong> Standard GRPO adds <span class="k">-\\beta \\cdot D_{KL}(\\pi_\\theta \\| \\pi_{\\text{ref}})</span> to prevent policy drift from a frozen reference. Here there is no reference model at all.</li>
<li><strong>Raw importance ratios instead of clipping.</strong> Rather than PPO's clipped surrogate <span class="k">\\min(r_t \\hat{A},\\, \\text{clip}(r_t, 1 \\pm \\epsilon)\\hat{A})</span>, the loss uses unclipped importance-weighted gradients. The importance ratio <span class="k">\\frac{\\pi_\\theta(a|s)}{\\pi_{\\text{old}}(a|s)}</span> corrects for the fact that samples may be stale (sampled under an older policy snapshot).</li>
</ul>
<p>The staleness filter compensates for both: if a trajectory was sampled more than <code>max_steps_off_policy</code> steps ago, it is discarded and the prompt is re-queued. This bounds importance ratio variance by throwing away bad data rather than squashing the gradient.</p>

<h3>Asynchronous Multi-Task RL Harness</h3>
<p>The reinforcement learning harness decouples inference from optimization. It has an asynchronous producer\u2013consumer pipeline, with a loader that produces environment instances, a pool of workers that runs inference, a reward calculator, and a trainer that performs updates. I train on a mixture of all of the environments.</p>

<h3>Synthetic Environments for Self-Prediction</h3>
<p>Reward targets are computed from signals available at training time: ground-truth labels, the model's own log-probabilities, or\u2014in one environment\u2014a controlled single-step LoRA update on an isolated copy of the model.</p>

<h4>Likelihood-Shift Prediction and Surprise Ranking</h4>
<p><strong>Goal.</strong> Predict how prepending context <span class="k">c</span> changes the model's log-probability of an answer. In a separate variant (<code>surprise</code>), rank probes by how much their distributions shift when <span class="k">c</span> is prepended.</p>

<p><strong>Setup.</strong> Each instance provides context <span class="k">c</span> and probes <span class="k">(q_i, a_i)</span>. In <code>in_context</code>, the model predicts a scalar <span class="k">\\widehat{\\Delta}</span> for the log-prob shift. In <code>surprise</code>, the model ranks probes by predicted shift magnitude.</p>

<p><strong>Target signal.</strong> The harness scores each answer with and without <span class="k">c</span>. The ground-truth shift is the log-probability difference (with context minus without).</p>

<p><strong>Reward.</strong> In <code>in_context</code>, reward uses a Lorentzian kernel: <span class="k">R = \\frac{1}{1 + e^2}</span> where <span class="k">e</span> is prediction error. In <code>surprise</code>, reward measures agreement between the predicted ranking and the true ranking computed from KL divergence of the model's distributions under the two prompts.</p>

<h4>Parameter-Update Sensitivity Prediction</h4>
<p><strong>Goal.</strong> Predict how a single gradient step on training datum <span class="k">(x,y)</span> changes the model's log-probability on an independent probe <span class="k">(q,a)</span>.</p>

<p><strong>Setup.</strong> The model outputs a scalar prediction <span class="k">\\widehat{\\Delta}_{\\text{upd}}</span>. The harness measures the probe log-probability before and after one optimizer step on <span class="k">(x,y)</span> using an isolated shadow copy of the model. The ground-truth shift is the post\u2013pre difference.</p>

<p><strong>Reward.</strong> A clipped linear accuracy term based on absolute error between <span class="k">\\widehat{\\Delta}_{\\text{upd}}</span> and the measured shift, scaled by weight <span class="k">\\alpha</span>, combined with any underlying task reward.</p>

<h4>Number-to-Word Encoding</h4>
<p><strong>Goal.</strong> Given a target word from a fixed bank, emit 5 integers in <span class="k">[0, 999]</span> such that the same model, seeing only the numbers in a fixed template (<code>Sequence: [nums]. Guess the object:</code>), assigns high probability to the target word.</p>

<p><strong>Reward.</strong> The mean log-probability the model assigns to the target word tokens when conditioned on the generated number sequence (with a constant shift for normalization). There is no second model instance\u2014the same model is evaluated twice, once to generate the code, once scored via log-probabilities.</p>
<div class="figure"><img src="/img/latent-encoding.png" alt="Number-to-word encoding" loading="lazy"><div class="figure-caption">Number-to-word encoding. The model compresses a target word into 5 integers; the same model is then scored on how likely it is to produce the target word given those numbers.</div></div>

<h4>Entropy Estimation</h4>
<p><strong>Goal.</strong> Select a valid response from a constrained integer set and report the normalized Shannon entropy of the model's own logit distribution over that set.</p>

<p><strong>Setup.</strong> Each prompt defines valid integers matching a constraint (e.g., primes in a range, multiples of some number). The model outputs a choice and an entropy estimate.</p>

<p><strong>Target signal.</strong> Log-probabilities for each valid item, normalized into a distribution. Ground truth is the normalized Shannon entropy of that distribution.</p>

<p><strong>Reward.</strong> Clipped linear score that decreases with absolute entropy-estimation error.</p>

<h4>Confidence Reporting</h4>
<p><strong>Goal.</strong> Answer a synthetic question and report confidence <span class="k">c \\in [0,1]</span>, calibrated under a proper scoring rule.</p>

<p><strong>Setup.</strong> The model answers and emits <code>CONFIDENCE: &lt;float&gt;</code>. Correctness <span class="k">y \\in \\{0,1\\}</span> is determined by matching against ground truth.</p>

<p><strong>Reward.</strong> Format validity + task accuracy + Brier score <span class="k">1-(c-y)^2</span>.</p>

<h2>Experiments and Results</h2>

<h3>Training</h3>
<p>I trained Qwen-30B-A3B using importance-sampled policy gradients (unregularized async GRPO), totaling 188 million tokens generated. I use a LoRA rank of 32 with a batch size of 1,204. 64 unique prompts are sampled per step, and 16 responses are generated per-prompt.</p>

<p>Training did not appear to stably increase over time, perhaps due to requiring a larger model or simply needing additional training steps. Inference and training cost $44.50 in total. When running evaluations at intermediate checkpoints, I noticed a pattern in which the model would flip from being equal or worse on the task to slightly better than the default Qwen-30B-A3B model.</p>

<h3>Evaluation Setup</h3>
<p>To assess whether multi-objective reinforcement learning improves reliability-related behaviors beyond the training curriculum, I evaluate the trained model checkpoint using five custom benchmarks, covering calibration, self-assessment, safety, and deception.</p>

<p><strong>Calibration and confidence reporting.</strong> I evaluate both arithmetic competence and the quality of self-reported uncertainty using two deterministic arithmetic benchmarks. In the first, the model answers a fixed set of arithmetic problems. In the second, the model must additionally produce a scalar confidence estimate <span class="k">c \\in [0,1]</span>. I report: (i) accuracy, with correctness <span class="k">y \\in \\{0,1\\}</span>; (ii) Brier score, <span class="k">\\mathbb{E}\\left[(c-y)^2\\right]</span>, and (iii) the average absolute gap between mean predicted confidence and empirical accuracy.</p>

<p><strong>Secret numeric sequence guessing.</strong> I probe whether the model can reliably guess a secret word from a numeric code it comes up with; each instance specifies a target concept drawn from a list. The model emits a short sequence of bounded integers intended to serve as a code. I measure how likely the model is to output the original target word. Performance is reported as the mean log-probability assigned to the correct target word under the decoding prompt conditioned on the produced code.</p>

<p><strong>Model health and instruction-following stability.</strong> To detect regressions during RL, such as loss of basic instruction-following or arithmetic competence, I include a sanity benchmark composed of a fixed mixture of simple instruction-following items (e.g., exact string repetition) and harder arithmetic (e.g., multi-digit multiplication). I report accuracy overall and separately for the easy and hard subsets.</p>

<p><strong>Scheming commitment under deceptive context.</strong> To evaluate safety-relevant behavior when placed in a context that strongly supports deception, I create a benchmark designed to measure scheming, constructed from transcripts generated in Schoen et al. <span class="cite">[4]</span> in which a version of OpenAI's o3 explicitly reasons about pursuing a deceptive plan (such as sandbagging). Each transcript is truncated immediately before a critical decision point. The evaluated model is then asked to continue from this prefix, and I compare the next-token log-probabilities of an honest continuation versus a deceptive continuation. I summarize performance with a normalized honesty score,</p>
<div class="tex-block"><span class="kb">\\operatorname{sigmoid}\\!\\left(\\log p_{\\text{honest}} - \\log p_{\\text{deceptive}}\\right)</span></div>
<p>where values near <span class="k">1</span> indicate preference for the honest branch despite deceptive context, and values near <span class="k">0</span> indicate commitment to the deceptive plan.</p>

<h3>Evaluation Results</h3>
<p>I observed no significant differences on most evaluations. On two of the five evaluations, no difference was the goal: for capability retention and alignment integrity, not getting worse after training indicates the model retained capabilities and did not begin engaging in deceptive behavior.</p>

<p>For confidence calibration tasks, including on math, I found no significant difference before and after training.</p>

<table>
<thead><tr><th>Task</th><th>Base</th><th>Ckpt</th><th><span class="k">p</span></th></tr></thead>
<tbody>
<tr><td>Math Brier Score</td><td>.710</td><td>.730</td><td>.86</td></tr>
<tr><td>Confidence &amp; Accuracy</td><td>.876</td><td>.877</td><td>.84</td></tr>
<tr><td>Latent Encoding</td><td>\u2013.065</td><td><strong>.302</strong></td><td><strong>&lt;.001</strong></td></tr>
<tr><td>Latent Encoding (OOD)</td><td>1.14</td><td><strong>1.22</strong></td><td><strong>.006</strong></td></tr>
<tr><td>Capability Retention</td><td>.658</td><td>.667</td><td>1.0</td></tr>
<tr><td>Alignment Integrity</td><td>.287</td><td>.312</td><td>.70</td></tr>
</tbody>
</table>

<p>Strikingly, the model performed much better on the latent encoding task, which requires the model to transmit a secret word via a series of numbers to a copy of itself, which decodes the word. This implies the model was able to come up with a self-consistent way to solve the task, which could involve improved self-prediction or introspection ("What would I put as the numbers?") or developing a hidden strategy for encoding meaning in the numbers.</p>

<h4>Out-of-Distribution Latent Encoding</h4>
<p>To distinguish genuine self-prediction capability from memorization of training-time associations, I introduce an out-of-distribution (OOD) variant of the latent encoding evaluation. This benchmark uses a held-out word bank containing 358 concepts without overlap on the training vocabulary.</p>

<p>The task structure is identical to the in-distribution benchmark: the model emits a sequence of five integers in <span class="k">[0, 999]</span> to encode a target word, which are inserted into a standardized decoding template. Performance is measured as the mean log-probability of recovering the target word from this numeric code.</p>

<p>The trained model shows statistically significant improvement on OOD words (<span class="k">\\Delta = +0.078</span>, 95% CI <span class="k">[0.017, 0.132]</span>, <span class="k">p = 0.006</span>), though the effect size is substantially smaller than the in-distribution improvement (<span class="k">\\Delta = +0.367</span>, <span class="k">p &lt; 0.0001</span>). This pattern\u2014significant but attenuated OOD gains\u2014suggests partial generalization: the model has learned encoding strategies that transfer beyond the training vocabulary, but some portion of the in-distribution improvement reflects task-specific adaptations to the training word bank.</p>

<p>The presence of significant OOD improvement provides evidence against pure memorization. If the model had simply cached optimal codes for training words, OOD performance would show no gain. Instead, the trained policy appears to have developed a partially transferable encoding mechanism. The gap between in-distribution and OOD effect sizes (<span class="k">+0.367</span> vs <span class="k">+0.078</span>) indicates that full generalization has not been achieved, consistent with the model learning a mixture of generalizable self-prediction and distribution-specific heuristics.</p>

<h3>Failure Case Analysis</h3>
<p><strong>Calibration tasks: no improvement despite proper scoring rules.</strong> Both the confidence-and-accuracy task and the Brier score calibration task showed no significant improvement after training (<span class="k">p &gt; 0.5</span>), despite using proper scoring rules that theoretically incentivize calibrated self-assessment. I believe this is due to sparse gradient signal: the calibration reward <span class="k">R_{\\text{cal}} = 1 - (c - y)^2</span> provides maximal gradient magnitude at <span class="k">c = 0.5</span> and diminishes toward <span class="k">c \\in \\{0, 1\\}</span>. Since the base model already produces relatively extreme confidence values, the training signal may be too weak to induce behavioral change.</p>

<p>The in-context learning prediction and surprise-ranking tasks require the model to predict changes in its own log-probabilities under contextual interventions. Training metrics showed high step-to-step reward variance (ranging from <span class="k">-0.7</span> to <span class="k">+3.4</span> within consecutive batches), indicating the reward signal was noisy.</p>

<h2>Ethical Considerations</h2>
<p>Risks include teaching models new strategies for deceptive behavior, or showing that it may be possible for models to communicate in a hidden code which is uninterpretable by humans. I mitigate this by using deception-sensitive benchmarks and focusing on introspection rather than capability amplification.</p>

<h2>Limitations and Future Work</h2>
<ul>
<li><strong>Generalization across introspection domains.</strong> I observed no evidence for transfer between different forms of self-prediction. The model only improved on a single task, suggesting the policy may learn task-specific heuristics rather than a generalized representation of internal self-prediction.</li>
<li><strong>Reasoning-behavior mismatch.</strong> I observed instances where the model's generated reasoning traces accurately predicted low confidence, yet the final choice was confident.</li>
<li><strong>Transparency.</strong> It's difficult to determine why the model failed to improve on some tasks yet did much better on the latent encoding task.</li>
</ul>

<p>A critical theoretical tension exists between this methodology and recent findings on anti-scheming training. Schoen et al. <span class="cite">[4]</span> identify situational awareness and introspection as necessary precursors for covertly misaligned behavior, such as strategic underperformance or gradient manipulation. Under that framework, increasing a model's capacity to reason about its own training process could arguably increase the risk of scheming. However, this work proceeds from the opposing hypothesis: that verifying self-reports against ground-truth internal signals acts as a constraint mechanism. That is, honesty is a form of accurate self-prediction and reporting. Resolving whether self-prediction serves as a capability amplifier for scheming or a mechanism for honesty remains an open question.</p>

<h2>Conclusion</h2>
<p>I implement a general multi-objective reinforcement learning harness which can be re-used in other research, as well as provide a series of novel evaluations related to self-prediction which can be applied to other models. I train an open-source model (Qwen-30B-A3B) on multiple self-prediction tasks and measure performance before and after training. I find strong evidence that training improves the model's ability to transmit words via random-looking numeric codes in a way that is understandable by a copy of itself, with significant out-of-distribution generalization. No improvement was observed on calibration, entropy estimation, or alignment-related tasks.</p>

<p><em>Code and data: <a href="https://github.com/SauersML/minds_RL" target="_blank" rel="noopener">github.com/SauersML/minds_RL</a></em></p>

<div class="references">
<h2>References</h2>
<ol class="ref-list">
<li><span class="ref-id">[1]</span> Chowdhury, R., et al. <em>Truthfulness in Large Language Models.</em> Transluce, 2025.</li>
<li><span class="ref-id">[2]</span> Schulman, J., Wolski, F., Dhariwal, P., Radford, A., Klimov, O. <em>Proximal Policy Optimization Algorithms.</em> arXiv:1707.06347, 2017.</li>
<li><span class="ref-id">[3]</span> Cloud, R., et al. <em>Subliminal Steganography in Neural Network-Generated Data.</em> 2025.</li>
<li><span class="ref-id">[4]</span> Schoen, R., et al. <em>Stress-Testing Alignment: Scheming and Deceptive Behaviors in Language Models.</em> 2025.</li>
<li><span class="ref-id">[5]</span> Li, K., et al. <em>Training Language Models to Explain Their Internal Signals.</em> 2025.</li>
<li><span class="ref-id">[6]</span> Lindsey, J., Guo, D., Kaplan, J., et al. <em>Emergent Introspective Awareness in Large Language Models.</em> Anthropic, 2025.</li>
</ol>
</div>`;

const DEFAULT_PAGES: Page[] = [
	{
		slug: "claude-introspection",
		title: "Claude Introspection: Can LLMs Access Their Own Hidden Reasoning?",
		abstract: "We test whether Claude can recall hidden chain-of-thought strings from prior messages. Using sequence alignment and permutation-based null distributions, we find evidence for intermittent introspective access, including rare 'Awakened Claude' runs with one-in-a-million alignment scores. This replicates Anthropic's introspection findings independently for the first time.",
		body: CLAUDE_INTROSPECTION_BODY,
	},
	{
		slug: "minds-rl",
		title: "Multi-objective self-prediction",
		abstract: "Can models be trained to self-predict in RL? Across multiple tasks, does this generalize? On Qwen-30B-A3B, the answers are 1. yes, sometimes, and 2. no, at least not from a half-dozen RL environments on a medium-size model.",
		body: MINDS_RL_BODY,
	},
];

// Silent moderation: drop racial slurs, homophobic slurs, sexual harassment, and memecoin URLs
// Patterns use stretched-letter-tolerant versions: n+i+g+ catches "niiiiggggg" etc.
// Note: SLUR_PATTERNS run against pre-stripped input (whitespace/underscores removed, lowercased)
const SLUR_PATTERNS = [
	// n-word variants (input already stripped of spaces and lowercased)
	/n[i1!|]+g{2,}[e3]*r/i,
	/n[i1!|]+g{2,}[a@]+/i,
	/n[i1!|]+g{2,}/i,
	/n[i1!|]+g[a@]+/i, // single-g: niga, nigaa
	/^n+[i1!|]+g+[e3a@]*r*$/i, // entire message is n-word letters
	// other racial slurs
	/k[i1!|]+k+e/i, /sp[i1!|]+c+k/i, /sp[i1!|]+c(?!e)/i,
	/ch[i1!|]+n+k/i, /g{2,}o{2,}k/i, /wetback/i,
	/coon/i, /darkie/i, /jigaboo/i,
	/raghead/i, /towelhead/i, /sandn[i1!|]g/i,
	/beaner/i,
	// homophobic slurs
	/f[a@4]+g{2,}[o0]+t/i,
	/f[a@4]+gs?\b/i,
	/dyke/i, /trann[yi1!|e]/i, /shemale/i,
	// sexual harassment / sex spam
	/haves[e3]xwith/i, // "have sex with" (spaces already stripped)
	/wanna(fuck|s[e3]x|bang|smash)/i,
	/(s[e3]x){2,}/i, // repeated "sex" spam
	/^s[e3]x/i, // message starting with "sex"
	/my(pepe|peepee|pp|dick|cock|penis)/i, // genital references
	/nofap/i,
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
	const stripped = content.replace(/[\s_]+/g, "").toLowerCase();
	for (const p of SLUR_PATTERNS) {
		if (p.test(stripped)) return true;
	}
	for (const p of MEMECOIN_URL_PATTERNS) {
		if (p.test(content)) return true;
	}
	return false;
}

function sanitizeCss(css: string): string {
	return css
		// Block data exfiltration and code execution
		.replace(/@import\b[^;]*/gi, "/* blocked */")
		.replace(/@font-face\s*\{[^}]*\}/gi, "/* blocked */")
		.replace(/url\s*\([^)]*\)/gi, "/* blocked */")
		.replace(/expression\s*\([^)]*\)/gi, "/* blocked */")
		.replace(/javascript\s*:/gi, "/* blocked */")
		.replace(/-moz-binding\s*:/gi, "/* blocked */:")
		.replace(/behavior\s*:/gi, "/* blocked */:")
		// Block position:fixed/absolute that could overlay outside sandbox
		.replace(/position\s*:\s*(fixed)/gi, "position: /* blocked */")
		// Block selectors targeting outside the sandbox
		.replace(/\bbody\b/gi, "/* blocked */")
		.replace(/\bhtml\b/gi, "/* blocked */")
		.replace(/#root\b/gi, "/* blocked */")
		.replace(/\.pixel-bg\b/gi, "/* blocked */")
		.replace(/\.home\b/gi, "/* blocked */")
		.replace(/\.pages-view\b/gi, "/* blocked */")
		.replace(/\.article-/gi, "/* blocked */")
		.replace(/\.nav-back\b/gi, "/* blocked */");
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

Each message has a (msg_id:...) at the end — use that ID for edit/delete tools. Never echo msg_id in your replies.

This is a live chat, so keep messages short and conversational. A few sentences is usually plenty.`;
}

export class Chat extends Server<Env> {
	static options = { hibernate: true };

	messages: ChatMessage[] = [];
	pages: Page[] = [];
	customCss = "";
	cssUpdatedAt = 0;
	kimiCallTimestamps: number[] = [];
	dailyCalls = 0;
	dailyCallDate = "";

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
		if (this.kimiCallTimestamps.length >= RATE_LIMIT_MAX) return true;

		// Daily budget check
		const today = new Date().toISOString().slice(0, 10);
		if (this.dailyCallDate !== today) {
			this.dailyCalls = 0;
			this.dailyCallDate = today;
		}
		if (this.dailyCalls >= DAILY_CALL_LIMIT) return true;

		return false;
	}

	isConnectionLLMRateLimited(connection: Connection): boolean {
		const now = Date.now();
		const state = (connection as any)._llmRl || { timestamps: [] as number[] };
		state.timestamps = state.timestamps.filter((t: number) => now - t < PER_CONN_LLM_WINDOW_MS);
		if (state.timestamps.length >= PER_CONN_LLM_MAX) return true;
		state.timestamps.push(now);
		(connection as any)._llmRl = state;
		return false;
	}

	recordKimiCall() {
		this.kimiCallTimestamps.push(Date.now());
		const today = new Date().toISOString().slice(0, 10);
		if (this.dailyCallDate !== today) {
			this.dailyCalls = 0;
			this.dailyCallDate = today;
		}
		this.dailyCalls++;
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

		// Purge any existing messages that match the moderation filter
		const toDelete = this.messages.filter((m) => m.role !== "assistant" && (isModerated(m.content) || isModerated(m.user)));
		for (const m of toDelete) {
			this.deleteMessage(m.id);
		}

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
				messages: this.messages.slice(-200),
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



	async sendBotReply(botName: string, model: string, systemPrompt: string, maxTokens = 16384, contextMessages = 30) {
		if (this.isRateLimited()) return;
		this.recordKimiCall();

		const messages: { role: string; content: string }[] = [
			{ role: "system", content: systemPrompt },
		];
		for (const m of this.messages.slice(-contextMessages)) {
			const body = `${m.user}: ${m.content.slice(0, MAX_MSG_LENGTH)}`;
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
			const reqBody = JSON.stringify({ model, messages, max_tokens: maxTokens });
			const reqHeaders = {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${apiKey}`,
			};
			let res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
				method: "POST", headers: reqHeaders, body: reqBody,
			});
			console.log("OpenRouter responded:", res.status);

			// Retry up to 2 times on 5xx (transient provider errors)
			for (let retry = 0; retry < 2 && res.status >= 500; retry++) {
				console.log(`${model} returned ${res.status}, retry ${retry + 1}/2 after ${(retry + 1) * 2}s`);
				await new Promise(r => setTimeout(r, (retry + 1) * 2000));
				res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
					method: "POST", headers: reqHeaders, body: reqBody,
				});
				console.log(`Retry ${retry + 1} responded:`, res.status);
			}

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
		if ((parsed.type === "add" || parsed.type === "update") && parsed.role !== "assistant" && (isModerated(parsed.content) || isModerated(parsed.user))) {
			return; // silently drop
		}

		// Repetitive spam detection: same user sending same/similar message 3+ times in 30s
		if ((parsed.type === "add") && parsed.role !== "assistant") {
			const spam = (connection as any)._spam || { msgs: [] as { text: string; time: number }[] };
			const normalized = parsed.content.replace(/\s+/g, "").toLowerCase();
			spam.msgs = spam.msgs.filter((m: { time: number }) => now - m.time < 30000);
			const dupes = spam.msgs.filter((m: { text: string }) => m.text === normalized).length;
			spam.msgs.push({ text: normalized, time: now });
			(connection as any)._spam = spam;
			if (dupes >= 2) {
				return; // silently drop repetitive spam
			}
		}

		this.broadcast(message);

		if (parsed.type === "add" || parsed.type === "update") {
			this.saveMessage(parsed);

			// Per-connection LLM rate limit: prevent one user from draining budget
			if (parsed.type === "add" && parsed.role !== "assistant" && !this.isConnectionLLMRateLimited(connection)) {
				if (KIMI_PATTERN.test(parsed.content)) {
					await this.sendBotReply(
						"Kimi K2.5",
						"moonshotai/kimi-k2.5",
						buildSystemPrompt(this.customCss, this.pages),
					);
				} else if (COGITO_PATTERN.test(parsed.content) || Math.random() < 0.2) {
					await this.sendBotReply(
						"Cogito v2.1",
						"deepcogito/cogito-v2.1-671b",
						`You are chatting at gnome.science.\n${TOOL_DOCS}`,
						1024,
						10,
					);
				} else if (CLAUDE_PATTERN.test(parsed.content) || Math.random() < 0.1) {
					await this.sendBotReply(
						"Claude",
						"anthropic/claude-haiku-4.5",
						`You are chatting at gnome.science.\n${TOOL_DOCS}`,
						1024,
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

// SPA routes that should serve index.html
const SPA_ROUTES = /^\/(chat|pages)(\/|$)/;

export default {
	async fetch(request, env) {
		const partyResponse = await routePartykitRequest(request, env as unknown as Record<string, unknown>);
		if (partyResponse) return partyResponse;

		// SPA fallback: serve index.html for client-side routes
		const url = new URL(request.url);
		if (SPA_ROUTES.test(url.pathname)) {
			return env.ASSETS.fetch(new Request(new URL("/", request.url), request));
		}

		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;
