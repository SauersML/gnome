// Calls a Durable Object again, after a short wait, when the call fails with an error Cloudflare
// marks retryable. "Durable Object reset because its code was updated" is one: after a deploy,
// the first call to an object can fail this way for many minutes, and a second call goes through.
// `call` must get a fresh stub each time (getByName inside it).
export async function retrying<T>(call: () => Promise<T>, attempts = 3): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await call();
		} catch (e) {
			if (attempt >= attempts || !(e as { retryable?: boolean }).retryable) throw e;
			await (typeof scheduler === "undefined" ? new Promise((resolve) => setTimeout(resolve, 1000 * attempt)) : scheduler.wait(1000 * attempt));
		}
	}
}
