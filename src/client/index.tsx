import { createRoot } from "react-dom/client";
import { usePartySocket } from "partysocket/react";
import React, { useState, useRef, useEffect } from "react";
import { nanoid } from "nanoid";
import { names, type ChatMessage, type Message } from "../shared";

function App() {
	const [name] = useState(names[Math.floor(Math.random() * names.length)]);
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const messagesEnd = useRef<HTMLDivElement>(null);

	useEffect(() => {
		messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	const socket = usePartySocket({
		party: "chat",
		room: "global",
		onMessage: (evt) => {
			const message = JSON.parse(evt.data as string) as Message;
			if (message.type === "add") {
				const foundIndex = messages.findIndex((m) => m.id === message.id);
				if (foundIndex === -1) {
					setMessages((messages) => [
						...messages,
						{
							id: message.id,
							content: message.content,
							user: message.user,
							role: message.role,
						},
					]);
				} else {
					setMessages((messages) => {
						return messages
							.slice(0, foundIndex)
							.concat({
								id: message.id,
								content: message.content,
								user: message.user,
								role: message.role,
							})
							.concat(messages.slice(foundIndex + 1));
					});
				}
			} else if (message.type === "update") {
				setMessages((messages) =>
					messages.map((m) =>
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

	return (
		<div className="app">
			<div className="header">
				<h1>
					gnome<span>.</span>science
				</h1>
				<div className="status">
					<span className="status-dot" />
					global chatroom
				</div>
			</div>

			{messages.length === 0 ? (
				<div className="empty">No messages yet. Say something.</div>
			) : (
				<div className="messages">
					{messages.map((message) => (
						<div
							key={message.id}
							className={`message ${message.user === name ? "message-self" : ""}`}
						>
							<div className="message-user">{message.user}</div>
							<div className="message-content">{message.content}</div>
						</div>
					))}
					<div ref={messagesEnd} />
				</div>
			)}

			<div className="input-area">
				<form
					className="input-row"
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
						setMessages((messages) => [...messages, chatMessage]);
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
						placeholder="Type a message..."
						autoComplete="off"
					/>
					<button type="submit">Send</button>
				</form>
				<div className="your-name">chatting as {name}</div>
			</div>
		</div>
	);
}

createRoot(document.getElementById("root")!).render(<App />);
