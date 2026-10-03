import { DurableObject } from "cloudflare:workers";

type Completion = { status: number; contentType: string; text: string };
const unavailable = (): Completion => ({ status: 503, contentType: "text/plain", text: "" });

// The authenticated bridge uses ordinary Chrome and Deep Cogito's own endpoint.
// This object coordinates requests; it never selects or substitutes another model.
export class CogitoRelay extends DurableObject<Env> {
	private pending = new Map<string, { resolve: (value: Completion) => void; timer: ReturnType<typeof setTimeout> }>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	async fetch(request: Request): Promise<Response> {
		const key = (this.env as Env & { COGITO_BRIDGE_KEY?: string }).COGITO_BRIDGE_KEY;
		if (!key || request.headers.get("Authorization") !== `Bearer ${key}`) {
			return new Response("Unauthorized", { status: 401 });
		}
		const path = new URL(request.url).pathname;
		if (path === "/__cogito/status") {
			return Response.json({ connected: this.ctx.getWebSockets("bridge").length > 0, pending: this.pending.size });
		}
		if (path !== "/__cogito/connect" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Not found", { status: 404 });
		}
		for (const old of this.ctx.getWebSockets("bridge")) old.close(1000, "Bridge reconnected");
		this.failPending();
		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1], ["bridge"]);
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	async complete(body: string): Promise<Completion> {
		const bridge = this.ctx.getWebSockets("bridge")[0];
		if (!bridge) return unavailable();
		if (this.pending.size >= 2) return { status: 429, contentType: "text/plain", text: "" };
		if (body.length > 128_000) return { status: 413, contentType: "text/plain", text: "" };
		const id = crypto.randomUUID();
		return new Promise<Completion>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve({ status: 504, contentType: "text/plain", text: "" });
			}, 180_000);
			this.pending.set(id, { resolve, timer });
			try { bridge.send(JSON.stringify({ type: "completion", id, body })); }
			catch { this.finish(id, unavailable()); }
		});
	}

	webSocketMessage(_socket: WebSocket, message: string | ArrayBuffer) {
		if (typeof message !== "string" || message.length > 300_000) return;
		try {
			const reply = JSON.parse(message);
			if (reply.type !== "result" || typeof reply.id !== "string") return;
			if (!Number.isInteger(reply.status) || reply.status < 200 || reply.status > 599) return;
			this.finish(reply.id, {
				status: reply.status,
				contentType: typeof reply.contentType === "string" ? reply.contentType : "text/plain",
				text: typeof reply.text === "string" ? reply.text : "",
			});
		} catch { /* Ignore malformed bridge frames. */ }
	}

	webSocketClose(socket: WebSocket, code: number, reason: string) {
		if (![1005, 1006, 1015].includes(code)) socket.close(code, reason);
		if (!this.ctx.getWebSockets("bridge").some((ws) => ws !== socket)) this.failPending();
	}

	webSocketError() { this.failPending(); }

	private finish(id: string, result: Completion) {
		const job = this.pending.get(id);
		if (!job) return;
		clearTimeout(job.timer);
		this.pending.delete(id);
		job.resolve(result);
	}

	private failPending() {
		for (const id of this.pending.keys()) this.finish(id, unavailable());
	}
}

export async function requestCogito(binding: DurableObjectNamespace<CogitoRelay>, body: string): Promise<Response> {
	const result = await binding.getByName("cogito").complete(body);
	return new Response(result.text, { status: result.status, headers: { "Content-Type": result.contentType } });
}
