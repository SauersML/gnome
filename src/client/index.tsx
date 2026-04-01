import { createRoot } from "react-dom/client";
import { usePartySocket } from "partysocket/react";
import React, { useState, useRef, useEffect } from "react";
import { nanoid } from "nanoid";
import { type ChatMessage, type Message } from "../shared";
import { initPixelCanvas } from "./pixels";

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

function App() {
	const [name, setName] = useState<string | null>(() => localStorage.getItem("gnome_username"));
	const [nameInput, setNameInput] = useState("");
	const [messages, setMessages] = useState<ChatMessage[]>([]);
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
				const foundIndex = messages.findIndex((m) => m.id === message.id);
				if (foundIndex === -1) {
					setMessages((prev) => [
						...prev,
						{
							id: message.id,
							content: message.content,
							user: message.user,
							role: message.role,
						},
					]);
				} else {
					setMessages((prev) => {
						return prev
							.slice(0, foundIndex)
							.concat({
								id: message.id,
								content: message.content,
								user: message.user,
								role: message.role,
							})
							.concat(prev.slice(foundIndex + 1));
					});
				}
			} else if (message.type === "update") {
				setMessages((prev) =>
					prev.map((m) =>
						m.id === message.id
							? {
									id: message.id,
									content: message.content,
									user: message.user,
									role: message.role,
								}
							: m,
					),
				);
			} else {
				setMessages(message.messages);
			}
		},
	});

	if (!name) {
		return (
			<>
				<PixelBackground />
				<div className="app">
					<header className="header">
						<div className="brand">
							gnome<span className="dot">.</span>science
						</div>
					</header>

					<div className="divider" />

					<div className="empty">
						<div className="empty-text">
							What should we call you?
						</div>
					</div>

					<div className="compose">
						<form
							className="compose-form"
							onSubmit={(e) => {
								e.preventDefault();
								const trimmed = nameInput.trim();
								if (!trimmed) return;
								localStorage.setItem("gnome_username", trimmed);
								setName(trimmed);
							}}
						>
							<input
								type="text"
								className="compose-input"
								placeholder="Enter your name..."
								autoComplete="off"
								value={nameInput}
								onChange={(e) => setNameInput(e.target.value)}
							/>
							<button type="submit" className="compose-send">Join</button>
						</form>
					</div>
				</div>
			</>
		);
	}

	return (
		<>
			<PixelBackground />
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
							Nothing here yet.
						</div>
					</div>
				) : (
					<div className="messages">
						{messages.map((msg, i) => (
							<div
								key={msg.id}
								className={`msg ${msg.user === name ? "msg-self" : ""} ${msg.role === "assistant" ? "msg-assistant" : ""} ${i >= messages.length - 1 ? "msg-new" : ""}`}
							>
								<span className="msg-who">{msg.user}</span>
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
							if (!input.value.trim()) return;
							const chatMessage: ChatMessage = {
								id: nanoid(8),
								content: input.value,
								user: name,
								role: "user",
							};
							setMessages((prev) => [...prev, chatMessage]);
							socket.send(
								JSON.stringify({
									type: "add",
									...chatMessage,
								} satisfies Message),
							);
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
					<div className="compose-meta">as {name}</div>
				</div>
			</div>
		</>
	);
}

createRoot(document.getElementById("root")!).render(<App />);
