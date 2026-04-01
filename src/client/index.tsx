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
		slug: "hollow-orbit",
		title: "\u2234 Hollow Orbit Theorem",
		abstract: "\u2220\u22C5\u2236 on the collapse of nested rings under spectral torsion.",
		body: () => `
<p>Let ${k(`\\Theta`)} be a hollow orbit over ${k(`\\mathfrak{g}_\\infty`)}. The winding density ${k(`\\omega(\\Theta)`)} satisfies</p>
<div class="tex-block">${kb(`\\omega(\\Theta) = \\oint_{\\partial \\Theta} \\frac{d\\zeta}{\\zeta^2 - \\varphi}`)}</div>
<p>where ${k(`\\varphi = \\frac{1+\\sqrt{5}}{2}`)}. Under spectral torsion ${k(`\\tau \\to \\tau^\\dagger`)}, the orbit collapses:</p>
<div class="tex-block">${kb(`\\lim_{n \\to \\aleph_0} \\Theta^{(n)} = \\bigcap_{k} \\mathcal{R}_k \\setminus \\{\\emptyset\\}`)}</div>
<p>The residue at each ring boundary ${k(`\\partial \\mathcal{R}_k`)} is purely imaginary, giving</p>
<div class="tex-block">${kb(`\\text{Res}_{\\zeta = \\varphi^k} \\omega = i \\cdot (-1)^k \\cdot \\frac{\\pi}{\\sqrt{\\tau}}`)}</div>
`,
	},
	{
		slug: "drift-lattice",
		title: "\u22C8 Drift Lattice Conjecture",
		abstract: "\u2261\u2237 chromatic drift on infinite filament lattices.",
		body: () => `
<p>A filament lattice ${k(`\\mathcal{F}`)} is a directed acyclic tangle with chromatic index ${k(`\\chi(\\mathcal{F}) = \\infty`)}. The drift operator</p>
<div class="tex-block">${kb(`\\Delta_\\mathcal{F} = \\sum_{e \\in E} \\xi_e \\otimes \\bar{\\xi}_e \\cdot e^{-\\|e\\|/\\lambda}`)}</div>
<p>generates a semigroup whose fixed points are the silent nodes ${k(`\\mathcal{S} \\subset V(\\mathcal{F})`)}. We conjecture</p>
<div class="tex-block">${kb(`|\\mathcal{S}| = \\left\\lfloor \\frac{\\chi(\\mathcal{F})}{\\pi^2 / 6} \\right\\rfloor + \\varepsilon`)}</div>
<p>where ${k(`\\varepsilon \\in \\{0, 1\\}`)} depends on the parity of the longest filament. The spectral shadow of ${k(`\\Delta_\\mathcal{F}`)} lives on</p>
<div class="tex-block">${kb(`\\sigma(\\Delta_\\mathcal{F}) \\subseteq \\left\\{ z \\in \\mathbb{C} : |z|^3 \\leq \\text{Im}(z) + \\frac{1}{\\lambda} \\right\\}`)}</div>
`,
	},
	{
		slug: "quiet-morphism",
		title: "\u2235 Quiet Morphisms",
		abstract: "\u223F\u2322 on vanishing maps between resonant categories.",
		body: () => `
<p>A morphism ${k(`f: \\mathcal{A} \\to \\mathcal{B}`)} is quiet if the induced map on ${k(`\\pi_0`)} is trivial and the kernel resonates:</p>
<div class="tex-block">${kb(`\\ker(f_*) \\cong \\bigoplus_{n \\geq 1} \\mathbb{Z}/\\varphi^n\\mathbb{Z}`)}</div>
<p>The resonance spectrum ${k(`\\mathcal{R}(f)`)} is defined as</p>
<div class="tex-block">${kb(`\\mathcal{R}(f) = \\left\\{ \\alpha \\in \\mathbb{R} : \\exists\\, g \\in \\text{Hom}(\\mathcal{B}, \\mathcal{A}),\\; \\|g \\circ f - \\alpha \\cdot \\text{id}\\| < \\frac{1}{\\alpha} \\right\\}`)}</div>
<p>Quiet morphisms compose: if ${k(`f`)} and ${k(`g`)} are quiet then ${k(`g \\circ f`)} is silent, meaning</p>
<div class="tex-block">${kb(`\\mathcal{R}(g \\circ f) = \\emptyset \\quad \\Longleftrightarrow \\quad \\mathcal{R}(f) \\cap \\mathcal{R}(g) = \\{\\varphi\\}`)}</div>
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
