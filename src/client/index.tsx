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
		slug: "entropy-bounds",
		title: "Entropy Bounds in Finite Systems",
		abstract: "Upper bounds on von Neumann entropy for finite-dimensional quantum systems under locality constraints.",
		body: () => `
<p>Consider a finite-dimensional Hilbert space ${k(`\\mathcal{H} = \\mathbb{C}^d`)}. The von Neumann entropy of a state ${k(`\\rho`)} is</p>
<div class="tex-block">${kb(`S(\\rho) = -\\text{Tr}(\\rho \\ln \\rho)`)}</div>
<p>For a bipartite system ${k(`\\mathcal{H} = \\mathcal{H}_A \\otimes \\mathcal{H}_B`)}, the mutual information is bounded by</p>
<div class="tex-block">${kb(`I(A:B) = S(\\rho_A) + S(\\rho_B) - S(\\rho_{AB}) \\leq 2 \\min\\{\\ln d_A, \\ln d_B\\}`)}</div>
<p>We establish a tighter bound under the assumption that interactions are geometrically local. Let ${k(`H = \\sum_{\\langle i,j \\rangle} h_{ij}`)} be a local Hamiltonian on a lattice ${k(`\\Lambda`)} with ${k(`|\\Lambda| = n`)} sites. Then for thermal states ${k(`\\rho_\\beta = e^{-\\beta H} / Z`)},</p>
<div class="tex-block">${kb(`S(\\rho_\\beta) \\leq n \\ln d - \\beta \\langle H \\rangle + \\ln Z`)}</div>
<p>The key insight is that locality constrains correlations. For any region ${k(`A \\subset \\Lambda`)} with boundary ${k(`\\partial A`)},</p>
<div class="tex-block">${kb(`S(\\rho_A) \\leq |A| \\ln d - \\alpha |\\partial A| + O(\\ln |A|)`)}</div>
<p>where ${k(`\\alpha > 0`)} depends on ${k(`\\beta`)} and the interaction strength. This area-law correction refines the naive volume-law upper bound.</p>
`,
	},
	{
		slug: "spectral-gaps",
		title: "Spectral Gaps and Mixing Times",
		abstract: "Relating the spectral gap of reversible Markov chains to mixing behavior on expander graphs.",
		body: () => `
<p>Let ${k(`P`)} be the transition matrix of an irreducible, reversible Markov chain on state space ${k(`\\Omega`)} with stationary distribution ${k(`\\pi`)}. The spectral gap is</p>
<div class="tex-block">${kb(`\\gamma = 1 - \\lambda_2`)}</div>
<p>where ${k(`\\lambda_2`)} is the second-largest eigenvalue of ${k(`P`)}. The mixing time satisfies</p>
<div class="tex-block">${kb(`t_{\\text{mix}}(\\varepsilon) = \\min\\left\\{t : \\max_{x \\in \\Omega} \\| P^t(x, \\cdot) - \\pi \\|_{TV} \\leq \\varepsilon \\right\\}`)}</div>
<p>The classical bound relates these quantities:</p>
<div class="tex-block">${kb(`\\frac{1}{\\gamma}\\left(\\ln \\frac{1}{2\\varepsilon}\\right) \\leq t_{\\text{mix}}(\\varepsilon) \\leq \\frac{1}{\\gamma} \\ln\\left(\\frac{1}{\\varepsilon \\, \\pi_{\\min}}\\right)`)}</div>
<p>On a ${k(`d`)}-regular expander graph with second eigenvalue ${k(`\\lambda`)}, the simple random walk has gap ${k(`\\gamma = 1 - \\lambda/d`)}. By the Alon–Boppana bound, ${k(`\\lambda \\geq 2\\sqrt{d-1} - o(1)`)}, so the best achievable gap on a ${k(`d`)}-regular graph is</p>
<div class="tex-block">${kb(`\\gamma^* \\leq 1 - \\frac{2\\sqrt{d-1}}{d}`)}</div>
<p>Ramanujan graphs achieve this bound, giving ${k(`t_{\\text{mix}} = \\Theta(\\log |\\Omega|)`)}.</p>
`,
	},
	{
		slug: "variational-inference",
		title: "Variational Inference with Rényi Divergences",
		abstract: "Tightening the evidence lower bound using Rényi-α divergences for latent variable models.",
		body: () => `
<p>In variational inference, we approximate a posterior ${k(`p(z|x)`)} with a tractable family ${k(`q_\\phi(z)`)} by maximizing the ELBO:</p>
<div class="tex-block">${kb(`\\mathcal{L}(\\phi) = \\mathbb{E}_{q_\\phi}[\\ln p(x,z) - \\ln q_\\phi(z)] \\leq \\ln p(x)`)}</div>
<p>The gap equals ${k(`D_{KL}(q_\\phi \\| p(z|x))`)}. We can tighten this using the Rényi divergence of order ${k(`\\alpha \\in (0,1)`)}:</p>
<div class="tex-block">${kb(`D_\\alpha(q \\| p) = \\frac{1}{\\alpha - 1} \\ln \\int q(z)^\\alpha \\, p(z|x)^{1-\\alpha} \\, dz`)}</div>
<p>The corresponding Rényi ELBO is</p>
<div class="tex-block">${kb(`\\mathcal{L}_\\alpha(\\phi) = \\frac{1}{1-\\alpha} \\ln \\mathbb{E}_{q_\\phi}\\left[\\left(\\frac{p(x,z)}{q_\\phi(z)}\\right)^{1-\\alpha}\\right]`)}</div>
<p>As ${k(`\\alpha \\to 1`)}, this recovers the standard ELBO. For ${k(`\\alpha < 1`)}, the bound is tighter: ${k(`\\mathcal{L}_\\alpha \\geq \\mathcal{L}`)}. The gradient estimator uses importance weights ${k(`w_i = p(x, z_i) / q_\\phi(z_i)`)}:</p>
<div class="tex-block">${kb(`\\nabla_\\phi \\mathcal{L}_\\alpha \\approx \\sum_{i=1}^{K} \\bar{w}_i^{1-\\alpha} \\nabla_\\phi \\ln q_\\phi(z_i)`)}</div>
<p>where ${k(`\\bar{w}_i`)} are self-normalized weights. This yields lower-variance gradients than the standard ELBO at the cost of a biased but consistent estimator.</p>
`,
	},
];

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
	const [askingName, setAskingName] = useState(false);
	const [pendingContent, setPendingContent] = useState("");
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
				setMessages((prev) => {
					const exists = prev.some((m) => m.id === message.id);
					if (!exists) return [...prev, message];
					return prev.map((m) => (m.id === message.id ? message : m));
				});
			} else if (message.type === "update") {
				setMessages((prev) =>
					prev.map((m) => (m.id === message.id ? message : m)),
				);
			} else {
				setMessages(message.messages);
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

					<div className="divider" />

					{messages.length === 0 ? (
						<div className="empty">
							<div className="empty-text">
								{askingName ? "What should we call you?" : "Nothing here yet."}
							</div>
						</div>
					) : (
						<div className="messages">
							{messages.map((msg, i) => (
								<div
									key={msg.id}
									className={`msg ${msg.user === name ? "msg-self" : ""} ${msg.role === "assistant" ? "msg-assistant" : ""} ${i === messages.length - 1 ? "msg-new" : ""}`}
								>
									<span className="msg-who">{msg.user}</span>
									<span className="msg-body">{msg.content}</span>
								</div>
							))}
							<div ref={messagesEnd} />
						</div>
					)}

					<div className="compose">
						{askingName ? (
							<form
								className="compose-form"
								onSubmit={(e) => {
									e.preventDefault();
									const input = e.currentTarget.elements.namedItem(
										"name",
									) as HTMLInputElement;
									const trimmed = input.value.trim();
									if (!trimmed) return;
									localStorage.setItem("gnome_username", trimmed);
									setName(trimmed);
									setAskingName(false);
									if (pendingContent) {
										sendMessage(pendingContent, trimmed);
										setPendingContent("");
									}
								}}
							>
								<input
									type="text"
									name="name"
									className="compose-input"
									placeholder="Enter your name..."
									autoComplete="off"
									autoFocus
								/>
								<button type="submit" className="compose-send">Join</button>
							</form>
						) : (
							<form
								className="compose-form"
								onSubmit={(e) => {
									e.preventDefault();
									const input = e.currentTarget.elements.namedItem(
										"content",
									) as HTMLInputElement;
									if (!input.value.trim()) return;
									if (!name) {
										setPendingContent(input.value.trim());
										setAskingName(true);
										input.value = "";
										return;
									}
									sendMessage(input.value, name);
									input.value = "";
								}}
							>
								<input
									type="text"
									name="content"
									className="compose-input"
									placeholder="Write something..."
									autoComplete="off"
								/>
								<button type="submit" className="compose-send">Send</button>
							</form>
						)}
						{name && <div className="compose-meta">as {name}</div>}
					</div>
				</div>

				<aside className="sidebar">
					<div className="sidebar-label">Papers</div>
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
