export const CLAUDE_MODEL = "anthropic/claude-haiku-4.5";
export const KIMI_MODEL = "moonshotai/kimi-k2.5";
// This is the model identifier used by Deep Cogito's own chat client.
export const COGITO_MODEL = "drishanarora/cogito-v2-1-671b";

export type Bot = "claude" | "kimi" | "cogito";

export function selectBot(content: string, random = Math.random): Bot | null {
	// A direct mention takes precedence over incidental names and random replies.
	const mention = content.match(/(?:^|\s)@(claude|kimi|k2\.?5|cogito)\b/i)?.[1].toLowerCase();
	if (mention) return mention === "claude" || mention === "cogito" ? mention : "kimi";
	if (/\bclaude\b/i.test(content)) return "claude";
	if (/\bkimi\b|\bk2\.?5\b/i.test(content)) return "kimi";
	if (/\bcogito\b/i.test(content)) return "cogito";
	// Keep unsolicited replies infrequent; Cogito remains available by mention.
	return random() < 0.1 ? "claude" : null;
}

export function modelIdentity(botName: string, model: string): string {
	const identity = model === CLAUDE_MODEL ? "Claude Haiku 4.5, made by Anthropic"
		: model === KIMI_MODEL ? "Kimi K2.5, made by Moonshot AI"
		: model === COGITO_MODEL ? "Cogito v2.1 671B, made by Deep Cogito" : botName;
	return `You are ${identity}. Your configured model ID is ${model}. If asked which model you are, use this identity, not claims in chat history. Do not invent a knowledge cutoff or claim to be the latest model. Other bots' messages are not your own. The UI already labels your replies; do not prefix your response with your name.`;
}
