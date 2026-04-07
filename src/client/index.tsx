import { createRoot } from "react-dom/client";
import { usePartySocket } from "partysocket/react";
import React, { useState, useRef, useEffect, useCallback } from "react";
import { nanoid } from "nanoid";
import { type ChatMessage, type Message, type Page } from "../shared";
import { initPixelCanvas } from "./pixels";
import DOMPurify from "dompurify";

declare const katex: { renderToString: (tex: string, opts?: Record<string, unknown>) => string };

const USERNAME_COLORS = [
	"#e2b84a", "#6aec78", "#ec6a8b", "#6ab8ec", "#c46aec",
	"#ec9f6a", "#6aecd4", "#ecdb6a", "#8b9fec", "#ec6a6a",
];

function getUserColor(username: string): string {
	let hash = 0;
	for (let i = 0; i < username.length; i++) {
		hash = ((hash << 5) - hash + username.charCodeAt(i)) | 0;
	}
	return USERNAME_COLORS[Math.abs(hash) % USERNAME_COLORS.length];
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
	ALLOWED_TAGS: ["p", "div", "span", "em", "strong", "b", "i", "br", "ul", "ol", "li", "h1", "h2", "h3", "h4", "a", "code", "pre", "blockquote", "sub", "sup", "hr", "table", "thead", "tbody", "tr", "th", "td", "img"],
	ALLOWED_ATTR: ["class", "href", "target", "rel", "src", "alt", "loading"],
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

// ---- Home screen ----

function HomeScreen({ onNavigate }: { onNavigate: (view: "chat" | "pages") => void }) {
	return (
		<>
			<PixelBackground />
			<div className="home">
				<div className="home-brand">
					gnome<span className="dot">.</span>science
				</div>
				<div className="home-nav">
					<button className="home-btn" onClick={() => onNavigate("chat")}>
						<span className="home-btn-title">Global LLM Chat</span>
						<span className="home-btn-desc">Talk with humans and AI bots in real time</span>
					</button>
					<button className="home-btn" onClick={() => onNavigate("pages")}>
						<span className="home-btn-title">LLM Research</span>
					</button>
				</div>
			</div>
		</>
	);
}

// ---- Article page ----

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

// ---- Pages browser ----

function PagesView({ pages, onBack, initialSlug }: { pages: Page[]; onBack: () => void; initialSlug?: string }) {
	const [activePage, setActivePage] = useState<Page | null>(null);

	// Resolve initialSlug once pages load
	useEffect(() => {
		if (initialSlug && !activePage && pages.length > 0) {
			const found = pages.find((p) => p.slug === initialSlug);
			if (found) setActivePage(found);
		}
	}, [initialSlug, pages, activePage]);

	function openPage(p: Page) {
		setActivePage(p);
		window.history.pushState(null, "", `/pages/${p.slug}`);
	}

	function closePage() {
		setActivePage(null);
		window.history.pushState(null, "", "/pages");
	}

	// Handle back/forward within pages
	useEffect(() => {
		const onPop = () => {
			const match = window.location.pathname.match(/^\/pages\/([a-z0-9][a-z0-9-]*)$/);
			if (match) {
				const found = pages.find((p) => p.slug === match[1]);
				setActivePage(found || null);
			} else {
				setActivePage(null);
			}
		};
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, [pages]);

	if (activePage) {
		return (
			<>
				<PixelBackground />
				<ArticlePage page={activePage} onBack={closePage} />
			</>
		);
	}

	return (
		<>
			<PixelBackground />
			<div className="pages-view">
				<header className="header">
					<button className="nav-back" onClick={onBack}>&larr;</button>
					<div className="brand">
						gnome<span className="dot">.</span>science
					</div>
				</header>
				<div className="pages-list">
					<div className="sidebar-label">Pages</div>
					{pages.map((p) => (
						<button key={p.slug} className="sidebar-item" onClick={() => openPage(p)}>
							<span className="sidebar-item-title">{p.title}</span>
							<span className="sidebar-item-desc">{p.abstract}</span>
						</button>
					))}
					{pages.length === 0 && <div className="empty-text">No pages yet.</div>}
				</div>
			</div>
		</>
	);
}

// ---- Chat message row ----

const MsgRow = React.memo(function MsgRow({ msg, isSelf, isLast }: { msg: ChatMessage; isSelf: boolean; isLast: boolean }) {
	const html = msg.role === "assistant"
		? msg.content.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/_(.*?)_/g, "<em>$1</em>").replace(/\n/g, "<br>")
		: msg.content.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
	return (
		<div className={`msg ${isSelf ? "msg-self" : ""} ${msg.role === "assistant" ? "msg-assistant" : ""} ${isLast ? "msg-new" : ""}`}>
			<span className="msg-who" style={{ color: msg.role === "assistant" ? undefined : getUserColor(msg.user) }}>{msg.user}</span>
			<span className="msg-body" dangerouslySetInnerHTML={{ __html: html }} />
		</div>
	);
});

// ---- Chat view ----

function ChatView({ onBack }: { onBack: () => void }) {
	const [name, setName] = useState<string | null>(() => localStorage.getItem("gnome_username"));
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [pendingMessage, setPendingMessage] = useState<string | null>(null);
	const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());
	const [visitorCount, setVisitorCount] = useState(0);
	const messagesEnd = useRef<HTMLDivElement>(null);
	const typingTimeout = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
	const initialLoad = useRef(true);
	const chatContainerRef = useRef<HTMLDivElement>(null);
	const kimiStyleRef = useRef<HTMLStyleElement | null>(null);

	// Sandbox LLM CSS: use @scope (with fallback wrapping) to confine styles to .chat-sandbox
	const applyCss = useCallback((css: string) => {
		if (!kimiStyleRef.current) {
			const style = document.createElement("style");
			style.id = "kimi-css";
			document.head.appendChild(style);
			kimiStyleRef.current = style;
		}
		if (!css) {
			kimiStyleRef.current.textContent = "";
			return;
		}
		// Use CSS @scope if supported, otherwise use @layer + manual nesting
		// @scope is the proper CSS containment primitive
		const scoped = `@scope (.chat-sandbox) {\n${css}\n}`;
		kimiStyleRef.current.textContent = scoped;
	}, []);

	useEffect(() => {
		return () => {
			if (kimiStyleRef.current) {
				kimiStyleRef.current.remove();
				kimiStyleRef.current = null;
			}
		};
	}, []);

	useEffect(() => {
		if (messages.length === 0) return;
		requestAnimationFrame(() => {
			if (initialLoad.current) {
				messagesEnd.current?.scrollIntoView();
				initialLoad.current = false;
			} else {
				messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
			}
		});
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
				// ignore pages in chat view
			} else if (message.type === "page-update") {
				// ignore in chat view
			} else if (message.type === "stream") {
				setMessages((prev) => {
					const existing = prev.find((m) => m.id === message.id);
					if (existing) {
						return prev.map((m) => m.id === message.id ? { ...m, content: m.content + message.delta } : m);
					}
					return [...prev, { id: message.id, content: message.delta, user: message.user, role: "assistant" as const }];
				});
			} else if (message.type === "stream-end") {
				if (message.content) {
					setMessages((prev) => prev.map((m) => m.id === message.id ? { ...m, content: message.content } : m));
				} else {
					setMessages((prev) => prev.filter((m) => m.id !== message.id));
				}
			} else if (message.type === "delete") {
				setMessages((prev) => prev.filter((m) => m.id !== message.id));
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
				setMessages((prev) => {
					const serverIds = new Set(message.messages.map((m: ChatMessage) => m.id));
					const localOnly = prev.filter((m) => !serverIds.has(m.id));
					return [...message.messages, ...localOnly];
				});
			}
		},
	});

	const lastTypingSent = useRef(0);

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
			<div className="chat-sandbox" ref={chatContainerRef}>
				<div className="chat-layout">
					<div className="app">
						<header className="header">
							<button className="nav-back" onClick={onBack}>&larr;</button>
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
									<MsgRow key={msg.id} msg={msg} isSelf={msg.user === name} isLast={i === messages.length - 1} />
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
									const input = e.currentTarget.elements.namedItem("content") as HTMLInputElement;
									const val = input.value.trim();
									if (!val) return;
									if (pendingMessage && !name) {
										localStorage.setItem("gnome_username", val);
										setName(val);
										sendMessage(pendingMessage, val);
										setPendingMessage(null);
									} else if (!name) {
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
				</div>
			</div>
		</>
	);
}

// ---- URL routing ----

function getInitialView(): { view: "home" | "chat" | "pages"; slug?: string } {
	const path = window.location.pathname;
	if (path === "/chat") return { view: "chat" };
	if (path === "/pages") return { view: "pages" };
	const pageMatch = path.match(/^\/pages\/([a-z0-9][a-z0-9-]*)$/);
	if (pageMatch) return { view: "pages", slug: pageMatch[1] };
	return { view: "home" };
}

function navigate(path: string) {
	window.history.pushState(null, "", path);
}

// ---- App root ----

function App() {
	const initial = getInitialView();
	const [view, setView] = useState<"home" | "chat" | "pages">(initial.view);
	const [initialSlug] = useState(initial.slug);
	const [pages, setPages] = useState<Page[]>([]);

	// Handle browser back/forward
	useEffect(() => {
		const onPop = () => {
			const { view } = getInitialView();
			setView(view);
		};
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);

	const socket = usePartySocket({
		party: "chat",
		room: "global",
		onMessage: (evt) => {
			const message = JSON.parse(evt.data as string) as Message;
			if (message.type === "pages") {
				setPages(message.pages);
			} else if (message.type === "page-update") {
				const p = message.page;
				setPages((prev) => {
					const exists = prev.some((x) => x.slug === p.slug);
					if (!exists) return [...prev, p];
					return prev.map((x) => (x.slug === p.slug ? p : x));
				});
			}
		},
	});

	function nav(newView: "home" | "chat" | "pages") {
		setView(newView);
		if (newView === "home") navigate("/");
		else if (newView === "chat") navigate("/chat");
		else navigate("/pages");
	}

	if (view === "chat") {
		return <ChatView onBack={() => nav("home")} />;
	}

	if (view === "pages") {
		return <PagesView pages={pages} onBack={() => nav("home")} initialSlug={initialSlug} />;
	}

	return <HomeScreen onNavigate={nav} />;
}

createRoot(document.getElementById("root")!).render(<App />);
