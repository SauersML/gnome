import { createRoot } from "react-dom/client";
import { usePartySocket } from "partysocket/react";
import React, { useState, useRef, useEffect } from "react";
import { nanoid } from "nanoid";
import { type ChatMessage, type Message, type Page } from "../shared";
import { initPixelCanvas } from "./pixels";
import DOMPurify from "dompurify";

declare const katex: { renderToString: (tex: string, opts?: Record<string, unknown>) => string };

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

const PURIFY_CONFIG = {
	ALLOWED_TAGS: ["p", "div", "span", "em", "strong", "b", "i", "br", "ul", "ol", "li", "h1", "h2", "h3", "h4", "a", "code", "pre", "blockquote", "sub", "sup", "hr", "table", "thead", "tbody", "tr", "th", "td"],
	ALLOWED_ATTR: ["class", "href", "target", "rel"],
};

function sanitize(html: string): string {
	return DOMPurify.sanitize(html, PURIFY_CONFIG);
}

function renderKatex(container: HTMLElement) {
	container.querySelectorAll("span.k, span.kb").forEach((el) => {
		const tex = el.textContent || "";
		const display = el.classList.contains("kb");
		el.innerHTML = katex.renderToString(tex, { throwOnError: false, displayMode: display });
		el.classList.remove("k", "kb");
	});
}

function ArticlePage({ page, onBack }: { page: Page; onBack: () => void }) {
	const bodyRef = useRef<HTMLDivElement>(null);
	const abstractRef = useRef<HTMLParagraphElement>(null);

	useEffect(() => {
		if (bodyRef.current) renderKatex(bodyRef.current);
		if (abstractRef.current) renderKatex(abstractRef.current);
	}, [page]);

	return (
		<div className="article-page">
			<button className="article-back" onClick={onBack}>&larr; back</button>
			<h1 className="article-title">{page.title}</h1>
			<p className="article-abstract" ref={abstractRef} dangerouslySetInnerHTML={{ __html: sanitize(page.abstract) }} />
			<div className="article-body" ref={bodyRef} dangerouslySetInnerHTML={{ __html: sanitize(page.body) }} />
		</div>
	);
}

function App() {
	const [name, setName] = useState<string | null>(() => localStorage.getItem("gnome_username"));
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [pages, setPages] = useState<Page[]>([]);
	const [activePage, setActivePage] = useState<Page | null>(null);
	const [mobileTab, setMobileTab] = useState<"chat" | "pages">("chat");
	const [pendingMessage, setPendingMessage] = useState<string | null>(null);
	const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());
	const [visitorCount, setVisitorCount] = useState(0);
	const messagesEnd = useRef<HTMLDivElement>(null);
	const typingTimeout = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
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
			if (message.type === "presence") {
				setVisitorCount(message.count);
			} else if (message.type === "typing") {
				if (message.user === name) return;
				if (message.isTyping) {
					setTypingUsers((prev) => new Set(prev).add(message.user));
					clearTimeout(typingTimeout.current[message.user]);
					typingTimeout.current[message.user] = setTimeout(() => {
						setTypingUsers((prev) => { const s = new Set(prev); s.delete(message.user); return s; });
					}, 5000);
				} else {
					clearTimeout(typingTimeout.current[message.user]);
					setTypingUsers((prev) => { const s = new Set(prev); s.delete(message.user); return s; });
				}
			} else if (message.type === "css") {
				applyCss(message.css);
			} else if (message.type === "pages") {
				setPages(message.pages);
			} else if (message.type === "page-update") {
				const p = message.page;
				setPages((prev) => {
					const exists = prev.some((x) => x.slug === p.slug);
					if (!exists) return [...prev, p];
					return prev.map((x) => (x.slug === p.slug ? p : x));
				});
				setActivePage(p);
			} else if (message.type === "stream") {
				// Streaming delta — append to existing streaming message or create one
				setMessages((prev) => {
					const existing = prev.find((m) => m.id === message.id);
					if (existing) {
						return prev.map((m) => m.id === message.id ? { ...m, content: m.content + message.delta } : m);
					}
					return [...prev, { id: message.id, content: message.delta, user: message.user, role: "assistant" as const }];
				});
			} else if (message.type === "stream-end") {
				// Finalize streaming message with parsed content
				if (message.content) {
					setMessages((prev) => prev.map((m) => m.id === message.id ? { ...m, content: message.content } : m));
				} else {
					// Empty response — remove the streaming placeholder
					setMessages((prev) => prev.filter((m) => m.id !== message.id));
				}
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
				if (msg.role === "assistant") {
					setActivePage(null);
					setMobileTab("chat");
				}
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

	const lastTypingSent = useRef(0);

	if (activePage) {
		return (
			<>
				<PixelBackground />
				<ArticlePage page={activePage} onBack={() => setActivePage(null)} />
			</>
		);
	}
	function sendTyping() {
		if (!name) return;
		const now = Date.now();
		if (now - lastTypingSent.current < 2000) return;
		lastTypingSent.current = now;
		socket.send(JSON.stringify({ type: "typing", user: name, isTyping: true }));
	}

	function sendMessage(content: string, userName: string) {
		const chatMessage: ChatMessage = {
			id: nanoid(8),
			content,
			user: userName,
			role: "user",
		};
		setMessages((prev) => [...prev, chatMessage]);
		socket.send(JSON.stringify({ type: "typing", user: userName, isTyping: false }));
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
				<div className={`app ${mobileTab !== "chat" ? "mobile-hidden" : ""}`}>
					<header className="header">
						<div className="brand">
							gnome<span className="dot">.</span>science
						</div>
						<div className="header-right">{visitorCount > 0 && <span className="visitor-count">{visitorCount}</span>}Live</div>
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
									<span className="msg-body" dangerouslySetInnerHTML={{ __html: msg.role === "assistant" ? msg.content.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/_(.*?)_/g, "<em>$1</em>").replace(/\n/g, "<br>") : msg.content.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;") }} />
								</div>
							))}
							<div ref={messagesEnd} />
						</div>
					)}

					{typingUsers.size > 0 && (() => {
					const users = [...typingUsers];
					const hasKimi = typingUsers.has("Kimi K2.5");
					const humans = users.filter((u) => u !== "Kimi K2.5");
					const parts: string[] = [];
					if (humans.length > 0) parts.push(`${humans.join(", ")} ${humans.length === 1 ? "is typing" : "are typing"}`);
					if (hasKimi) parts.push("Kimi K2.5 is responding");
					return <div className="typing-indicator">{parts.join(" · ")}...</div>;
				})()}
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
								onInput={sendTyping}
							/>
							<button type="submit" className="compose-send">{pendingMessage && !name ? "Join" : "Send"}</button>
						</form>
						{name && <div className="compose-meta">as {name}</div>}
					</div>
				</div>

				<aside className={`sidebar ${mobileTab === "pages" ? "mobile-visible" : ""}`}>
					<div className="sidebar-label">Kimi's Creations</div>
					{pages.map((p) => (
						<button key={p.slug} className="sidebar-item" onClick={() => setActivePage(p)}>
							<span className="sidebar-item-title">{p.title}</span>
							<span className="sidebar-item-desc">{p.abstract}</span>
						</button>
					))}
				</aside>
			</div>
			<div className="mobile-tabs">
				<button className={`mobile-tab ${mobileTab === "chat" ? "active" : ""}`} onClick={() => setMobileTab("chat")}>Chat</button>
				<button className={`mobile-tab ${mobileTab === "pages" ? "active" : ""}`} onClick={() => setMobileTab("pages")}>Pages</button>
			</div>
		</>
	);
}

createRoot(document.getElementById("root")!).render(<App />);
