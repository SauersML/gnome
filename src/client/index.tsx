import { createRoot } from "react-dom/client";
import { usePartySocket } from "partysocket/react";
import React, { useState, useRef, useEffect } from "react";
import { nanoid } from "nanoid";
import { type ChatMessage, type Message } from "../shared";
import { initPixelCanvas } from "./pixels";

declare const katex: { renderToString: (tex: string, opts?: Record<string, unknown>) => string };

type Article = {
	slug: string;
	title: string;
	abstract: string;
	body: () => string;
};

function k(tex: string): string {
	return katex.renderToString(tex, { throwOnError: false });
}
function kb(tex: string): string {
	return katex.renderToString(tex, { throwOnError: false, displayMode: true });
}

const articles: Article[] = [
	{
		slug: "golden-contour",
		title: "\u2234 Golden Contour Integrals",
		abstract: "\u2220\u22C5\u2236 residues of rational functions at powers of the golden ratio.",
		body: () => `
<p>Let ${k(`\\varphi = \\frac{1+\\sqrt{5}}{2}`)} and consider the rational function ${k(`f(z) = \\frac{1}{z^2 - z - 1}`)}. Its poles are at ${k(`z = \\varphi`)} and ${k(`z = 1 - \\varphi = -1/\\varphi`)}. We compute</p>
<div class="tex-block">${kb(`\\text{Res}_{z=\\varphi}\\, f = \\lim_{z \\to \\varphi} (z - \\varphi) \\cdot \\frac{1}{z^2 - z - 1} = \\frac{1}{2\\varphi - 1} = \\frac{1}{\\sqrt{5}}`)}</div>
<p>Let ${k(`\\gamma`)} be a positively oriented circle of radius ${k(`2`)} centered at the origin. Both poles lie inside ${k(`\\gamma`)}, so by the residue theorem</p>
<div class="tex-block">${kb(`\\oint_\\gamma \\frac{dz}{z^2 - z - 1} = 2\\pi i \\left( \\frac{1}{\\sqrt{5}} + \\frac{-1}{\\sqrt{5}} \\right) = 0`)}</div>
<p>This vanishing is not a coincidence. For any monic quadratic ${k(`z^2 + bz + c`)} with distinct roots, the sum of residues of ${k(`1/(z^2 + bz + c)`)} is always zero, since the partial fractions ${k(`\\frac{1}{r_1 - r_2} + \\frac{1}{r_2 - r_1} = 0`)}.</p>
<p>Now consider the generating function for Fibonacci numbers. The ${k(`n`)}-th Fibonacci number satisfies ${k(`F_n = \\frac{\\varphi^n - \\psi^n}{\\sqrt{5}}`)} where ${k(`\\psi = -1/\\varphi`)}. We can recover this via</p>
<div class="tex-block">${kb(`F_n = \\frac{1}{2\\pi i} \\oint_\\gamma \\frac{z^n}{z^2 - z - 1}\\, dz = \\frac{\\varphi^n - \\psi^n}{\\sqrt{5}}`)}</div>
<p>The contour integral picks out the residues, each contributing a geometric sequence. The identity ${k(`\\varphi^2 = \\varphi + 1`)} gives the recurrence ${k(`F_{n+2} = F_{n+1} + F_n`)} directly from the pole structure.</p>
<p>For the sum ${k(`\\sum_{n=0}^{\\infty} F_n x^n`)}, convergence requires ${k(`|x| < 1/\\varphi`)}. The closed form is</p>
<div class="tex-block">${kb(`\\sum_{n=0}^{\\infty} F_n x^n = \\frac{x}{1 - x - x^2}`)}</div>
<p>Setting ${k(`x = 1/10`)} gives the curious decimal ${k(`\\sum F_n / 10^n = 10/89`)}.</p>
`,
	},
	{
		slug: "random-walk-torus",
		title: "\u22C8 Random Walks on a Torus",
		abstract: "\u2261\u2237 mixing times for the discrete random walk on ${k(`\\mathbb{Z}_n \\times \\mathbb{Z}_n`)}.",
		body: () => `
<p>Consider the simple random walk on the discrete torus ${k(`\\mathbb{Z}_n \\times \\mathbb{Z}_n`)}: at each step, move to one of the 4 neighbors uniformly at random. The stationary distribution is uniform: ${k(`\\pi(x) = 1/n^2`)} for all ${k(`x`)}.</p>
<p>The transition matrix ${k(`P`)} has eigenvalues indexed by ${k(`(j,k) \\in \\mathbb{Z}_n^2`)}:</p>
<div class="tex-block">${kb(`\\lambda_{j,k} = \\frac{1}{2}\\left(\\cos\\frac{2\\pi j}{n} + \\cos\\frac{2\\pi k}{n}\\right)`)}</div>
<p>The spectral gap is ${k(`\\gamma = 1 - \\lambda_{1,0} = 1 - \\cos(2\\pi/n)`)}. For large ${k(`n`)},</p>
<div class="tex-block">${kb(`\\gamma = 1 - \\cos\\frac{2\\pi}{n} = \\frac{2\\pi^2}{n^2} + O(n^{-4})`)}</div>
<p>The mixing time satisfies the standard bounds</p>
<div class="tex-block">${kb(`\\frac{1}{\\gamma} \\ln\\frac{1}{2\\varepsilon} \\leq t_{\\text{mix}}(\\varepsilon) \\leq \\frac{1}{\\gamma} \\ln\\frac{1}{\\varepsilon\\, \\pi_{\\min}}`)}</div>
<p>Substituting ${k(`\\pi_{\\min} = 1/n^2`)} and ${k(`\\gamma \\sim 2\\pi^2/n^2`)}:</p>
<div class="tex-block">${kb(`t_{\\text{mix}}(\\varepsilon) = \\Theta\\!\\left( \\frac{n^2}{2\\pi^2} \\cdot \\ln n \\right) = \\Theta(n^2 \\log n)`)}</div>
<p>Compare with the 1D cycle ${k(`\\mathbb{Z}_n`)}, where ${k(`\\gamma \\sim 2\\pi^2/n^2`)} as well, but ${k(`\\pi_{\\min} = 1/n`)}, giving ${k(`t_{\\text{mix}} = \\Theta(n^2 \\log n)`)} in both cases. The torus is not faster despite having more edges; the bottleneck is the same Cheeger constant.</p>
<p>However, a lazy walk (stay put with probability ${k(`1/2`)}) on an expander graph with ${k(`n^2`)} vertices and spectral gap ${k(`\\gamma = \\Omega(1)`)} mixes in ${k(`O(\\log n)`)} time. The torus is far from an expander.</p>
`,
	},
	{
		slug: "thin-categories",
		title: "\u2235 Thin Categories & Preorders",
		abstract: "\u223F\u2322 profunctors on posets and paraconsistent negation.",
		body: () => `
<p>A thin category (or preorder) is a category ${k(`\\mathcal{C}`)} in which every hom-set has at most one morphism: for all ${k(`a, b \\in \\text{Ob}(\\mathcal{C})`)}, ${k(`|\\text{Hom}(a,b)| \\leq 1`)}. Writing ${k(`a \\leq b`)} when ${k(`\\text{Hom}(a,b) \\neq \\emptyset`)}:</p>
<div class="tex-block">${kb(`\\text{id}_a : a \\leq a \\quad\\text{(reflexivity)}`)}</div>
<div class="tex-block">${kb(`a \\leq b,\\; b \\leq c \\;\\Longrightarrow\\; a \\leq c \\quad\\text{(transitivity)}`)}</div>
<p>An isomorphism in a thin category is a pair of morphisms ${k(`a \\leq b`)} and ${k(`b \\leq a`)}, which forces ${k(`a \\cong b`)}. If antisymmetry holds (${k(`a \\cong b \\Rightarrow a = b`)}), the thin category is a poset.</p>
<p>A profunctor ${k(`P : \\mathcal{C}^{\\text{op}} \\times \\mathcal{C} \\to \\textbf{Bool}`)} on a thin category is equivalently a relation ${k(`R \\subseteq \\text{Ob} \\times \\text{Ob}`)} satisfying</p>
<div class="tex-block">${kb(`a' \\leq a,\\; R(a,b),\\; b \\leq b' \\;\\Longrightarrow\\; R(a', b')`)}</div>
<p>This is an order ideal condition: ${k(`R`)} is downward-closed on the left and upward-closed on the right.</p>
<p>A presheaf on ${k(`\\mathcal{C}`)} is a functor ${k(`F : \\mathcal{C}^{\\text{op}} \\to \\textbf{Bool}`)}, equivalently a downward-closed subset ${k(`S \\subseteq \\text{Ob}`)}:</p>
<div class="tex-block">${kb(`a' \\leq a,\\; a \\in S \\;\\Longrightarrow\\; a' \\in S`)}</div>
<p>Given a thin category ${k(`\\mathcal{C}`)} with relation ${k(`\\leq`)}, we can independently define a second relation ${k(`\\not\\sim`)} on the same objects. The pair ${k(`(\\leq, \\not\\sim)`)} is paraconsistent if we permit ${k(`a \\leq b`)} and ${k(`a \\not\\sim b`)} simultaneously without deriving ${k(`\\bot`)}. This is modeled by keeping ${k(`\\not\\sim`)} as a separate profunctor rather than defining it as ${k(`\\neg(a \\leq b)`)}:</p>
<div class="tex-block">${kb(`\\text{NotIs} : \\mathcal{C}^{\\text{op}} \\times \\mathcal{C} \\to \\textbf{Bool}, \\quad \\text{independent of } \\leq`)}</div>
<p>The resulting structure is a <em>presented theory</em>: a thin category equipped with a family of profunctors (positive and negative relations) and a family of presheaves (unary modal predicates):</p>
<div class="tex-block">${kb(`\\mathcal{T} = \\left(\\mathcal{C},\\; \\{P_v\\}_{v \\in V},\\; \\{N_v\\}_{v \\in V},\\; \\{F_u\\}_{u \\in U}\\right)`)}</div>
<p>where each ${k(`P_v, N_v`)} is a profunctor on ${k(`\\mathcal{C}`)} and each ${k(`F_u`)} is a presheaf on ${k(`\\mathcal{C}`)}.</p>
`,
	},
	{
		slug: "bing-bong",
		title: "\u22A2 Bing/Bong",
		abstract: "\u22A8\u22A3 a categorical formalization of copular discourse.",
		body: () => `
<p>We model the Bing/Bong discourse as a presented theory over a thin category. The objects are discourse entities:</p>
<div class="tex-block">${kb(`\\text{Ob} = \\{\\xi, \\bar\\xi, \\mu, \\nu, \\omega, \\phi, \\psi, g, b, \\beta^+, \\beta^-, \\beta^*, \\tau\\}`)}</div>
<p>The generating morphisms of the preorder ${k(`\\leq`)} (read: "is") include</p>
<div class="tex-block">${kb(`\\phi \\leq \\psi, \\quad \\psi \\leq \\xi, \\quad \\xi \\leq \\psi, \\quad \\bar\\xi \\leq b, \\quad \\xi \\leq g, \\quad \\beta^* \\leq \\xi`)}</div>
<div class="tex-block">${kb(`\\mu \\leq \\xi, \\quad \\xi \\leq \\mu, \\quad \\nu \\leq \\mu, \\quad \\omega \\leq \\phi`)}</div>
<p>Since ${k(`\\xi \\leq \\psi`)} and ${k(`\\psi \\leq \\xi`)}, we get ${k(`\\xi \\cong \\psi`)}. Similarly ${k(`\\xi \\cong \\mu`)}. By transitivity, ${k(`\\nu \\leq \\mu \\leq \\xi`)} and ${k(`\\omega \\leq \\phi \\leq \\psi \\cong \\xi`)}, so all of ${k(`\\{\\xi, \\psi, \\mu, \\nu, \\omega, \\phi, \\beta^*\\}`)} collapse to a single equivalence class. Call it ${k(`[\\xi]`)}.</p>
<p>The positive profunctor ${k(`P_{\\text{friend}} : \\mathcal{C}^{\\text{op}} \\times \\mathcal{C} \\to \\textbf{Bool}`)} has generators</p>
<div class="tex-block">${kb(`P_{\\text{friend}}(\\xi, \\mu), \\quad P_{\\text{friend}}(\\mu, \\nu), \\quad P_{\\text{friend}}(\\nu, \\mu)`)}</div>
<p>By the profunctor transport law ${k(`a' \\leq a,\\; P(a,b),\\; b \\leq b' \\Rightarrow P(a',b')`)}, and since everything in ${k(`[\\xi]`)} is isomorphic, ${k(`P_{\\text{friend}}`)} is constant on ${k(`[\\xi] \\times [\\xi]`)}.</p>
<p>The negative copula profunctor has generators including</p>
<div class="tex-block">${kb(`\\text{NotIs}(\\xi, \\bar\\xi), \\quad \\text{NotIs}(\\psi, \\bar\\xi), \\quad \\text{NotIs}(b, g), \\quad \\text{NotIs}(g, b)`)}</div>
<p>This coexists with ${k(`\\xi \\leq g`)} and ${k(`\\bar\\xi \\leq b`)} without contradiction, because ${k(`\\text{NotIs}`)} is a separate profunctor, not the negation of ${k(`\\leq`)}.</p>
<p>The one unary presheaf is ${k(`W : \\mathcal{C}^{\\text{op}} \\to \\textbf{Bool}`)} ("always wins"), generated by ${k(`W(\\xi)`)}. By the presheaf condition, ${k(`a' \\leq \\xi \\Rightarrow W(a')`)}, so ${k(`W`)} holds on all of ${k(`[\\xi]`)}:</p>
<div class="tex-block">${kb(`W(\\mu) \\;\\checkmark, \\quad W(\\nu) \\;\\checkmark, \\quad W(\\omega) \\;\\checkmark, \\quad W(\\beta^*) \\;\\checkmark`)}</div>
<p>The full presented theory is</p>
<div class="tex-block">${kb(`\\mathcal{T} = \\left(\\mathcal{C},\\; \\text{NotIs},\\; \\{P_v\\}_{v \\in V},\\; \\{N_v\\}_{v \\in V},\\; W\\right)`)}</div>
<p>with ${k(`|[\\xi]| = 7`)}, ${k(`|[\\bar\\xi]| = 2`)}, and ${k(`|\\{\\tau\\}| = 1`)}. The quotient category ${k(`\\mathcal{C}/\\!\\cong`)} has exactly 3 objects.</p>
`,
	},
];

const USERNAME_COLORS = [
	"#e2b84a", // gold (default)
	"#6aec78", // green
	"#ec6a8b", // rose
	"#6ab8ec", // sky
	"#c46aec", // purple
	"#ec9f6a", // orange
	"#6aecd4", // teal
	"#ecdb6a", // yellow
	"#8b9fec", // periwinkle
	"#ec6a6a", // coral
];

function getUserColor(username: string): string {
	let hash = 0;
	for (let i = 0; i < username.length; i++) {
		hash = ((hash << 5) - hash + username.charCodeAt(i)) | 0;
	}
	return USERNAME_COLORS[Math.abs(hash) % USERNAME_COLORS.length];
}

function useKimiCss() {
	const styleRef = useRef<HTMLStyleElement | null>(null);

	useEffect(() => {
		const style = document.createElement("style");
		style.id = "kimi-css";
		document.head.appendChild(style);
		styleRef.current = style;
		return () => { style.remove(); };
	}, []);

	return (css: string) => {
		if (styleRef.current) {
			styleRef.current.textContent = css;
		}
	};
}

function PixelBackground() {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		if (!canvasRef.current) return;
		return initPixelCanvas(canvasRef.current);
	}, []);

	return <canvas ref={canvasRef} className="pixel-bg" />;
}

function ArticlePage({ article, onBack }: { article: Article; onBack: () => void }) {
	return (
		<div className="article-page">
			<button className="article-back" onClick={onBack}>&larr; back</button>
			<h1 className="article-title">{article.title}</h1>
			<p className="article-abstract">{article.abstract}</p>
			<div className="article-body" dangerouslySetInnerHTML={{ __html: article.body() }} />
		</div>
	);
}

function App() {
	const [name, setName] = useState<string | null>(() => localStorage.getItem("gnome_username"));
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [activeArticle, setActiveArticle] = useState<Article | null>(null);
	const [pendingMessage, setPendingMessage] = useState<string | null>(null);
	const messagesEnd = useRef<HTMLDivElement>(null);
	const initialLoad = useRef(true);
	const applyCss = useKimiCss();

	useEffect(() => {
		if (initialLoad.current && messages.length > 0) {
			messagesEnd.current?.scrollIntoView();
			initialLoad.current = false;
		} else {
			messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
		}
	}, [messages]);

	const socket = usePartySocket({
		party: "chat",
		room: "global",
		onMessage: (evt) => {
			const message = JSON.parse(evt.data as string) as Message;
			if (message.type === "css") {
				applyCss(message.css);
			} else if (message.type === "add") {
				const msg: ChatMessage = { id: message.id, content: message.content, user: message.user, role: message.role };
				setMessages((prev) => {
					const exists = prev.some((m) => m.id === msg.id);
					if (!exists) return [...prev, msg];
					return prev.map((m) => (m.id === msg.id ? msg : m));
				});
			} else if (message.type === "update") {
				const msg: ChatMessage = { id: message.id, content: message.content, user: message.user, role: message.role };
				setMessages((prev) =>
					prev.map((m) => (m.id === msg.id ? msg : m)),
				);
			} else {
				// merge server history with local state to avoid dropping optimistic messages
				setMessages((prev) => {
					const serverIds = new Set(message.messages.map((m: ChatMessage) => m.id));
					const localOnly = prev.filter((m) => !serverIds.has(m.id));
					return [...message.messages, ...localOnly];
				});
			}
		},
	});

	if (activeArticle) {
		return (
			<>
				<PixelBackground />
				<ArticlePage article={activeArticle} onBack={() => setActiveArticle(null)} />
			</>
		);
	}

	function sendMessage(content: string, userName: string) {
		const chatMessage: ChatMessage = {
			id: nanoid(8),
			content,
			user: userName,
			role: "user",
		};
		setMessages((prev) => [...prev, chatMessage]);
		socket.send(
			JSON.stringify({
				type: "add",
				...chatMessage,
			} satisfies Message),
		);
	}

	return (
		<>
			<PixelBackground />
			<div className="layout">
				<div className="app">
					<header className="header">
						<div className="brand">
							gnome<span className="dot">.</span>science
						</div>
						<div className="header-right">Live</div>
					</header>


					{messages.length === 0 ? (
						<div className="empty">
							<div className="empty-text">Nothing here yet.</div>
						</div>
					) : (
						<div className="messages">
							{messages.map((msg, i) => (
								<div
									key={msg.id}
									className={`msg ${msg.user === name ? "msg-self" : ""} ${msg.role === "assistant" ? "msg-assistant" : ""} ${i === messages.length - 1 ? "msg-new" : ""}`}
								>
									<span className="msg-who" style={{ color: msg.role === "assistant" ? undefined : getUserColor(msg.user) }}>{msg.user}</span>
									<span className="msg-body">{msg.content}</span>
								</div>
							))}
							<div ref={messagesEnd} />
						</div>
					)}

					<div className="compose">
						<form
							className="compose-form"
							onSubmit={(e) => {
								e.preventDefault();
								const input = e.currentTarget.elements.namedItem(
									"content",
								) as HTMLInputElement;
								const val = input.value.trim();
								if (!val) return;
								if (pendingMessage && !name) {
									// Second submit: this is the username
									localStorage.setItem("gnome_username", val);
									setName(val);
									sendMessage(pendingMessage, val);
									setPendingMessage(null);
								} else if (!name) {
									// First submit without a name: stash the message, ask for name
									setPendingMessage(val);
								} else {
									sendMessage(val, name);
								}
								input.value = "";
							}}
						>
							<input
								type="text"
								name="content"
								className="compose-input"
								placeholder={pendingMessage && !name ? "Enter your name..." : "Write something..."}
								autoComplete="off"
							/>
							<button type="submit" className="compose-send">{pendingMessage && !name ? "Join" : "Send"}</button>
						</form>
						{name && <div className="compose-meta">as {name}</div>}
					</div>
				</div>

				<aside className="sidebar">
					<div className="sidebar-label">&Xi;</div>
					{articles.map((a) => (
						<button key={a.slug} className="sidebar-item" onClick={() => setActiveArticle(a)}>
							<span className="sidebar-item-title">{a.title}</span>
							<span className="sidebar-item-desc">{a.abstract}</span>
						</button>
					))}
				</aside>
			</div>
		</>
	);
}

createRoot(document.getElementById("root")!).render(<App />);
