// Minimal Anthropic (Claude) REST client for structured JSON, with text and images.
// JSON comes back through a forced tool call: the schema is the tool's input_schema, and Claude
// must answer by calling that tool, so the reply is the tool input. Same request/response shape
// as OpenAIClient.json, so the planner and analyser do not care which one they talk to.

export class AnthropicError extends Error {
	constructor(message, status, body) {
		super(message);
		this.status = status;
		this.body = body;
	}
}

const VERSION = '2023-06-01';

export class AnthropicClient {
	constructor({ apiKey, baseUrl = 'https://api.anthropic.com/v1', model = 'claude-opus-5-5', timeoutMs = 300_000 }) {
		Object.assign(this, { apiKey, baseUrl, model, timeoutMs });
	}

	async request(pathname, body, { method = 'POST', retries = 2 } = {}) {
		for (let attempt = 0; ; attempt++) {
			const res = await fetch(`${this.baseUrl}${pathname}`, {
				method,
				headers: { 'x-api-key': this.apiKey, 'anthropic-version': VERSION, 'content-type': 'application/json' },
				body: body ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(this.timeoutMs),
			});
			if (res.ok) return res.json();
			const text = await res.text();
			// 429 rate limit, 529 overloaded, other 5xx: back off and retry.
			const retryable = res.status === 429 || res.status >= 500;
			if (retryable && attempt < retries) {
				const wait = Number(res.headers.get('retry-after')) * 1000 || 1500 * 2 ** attempt;
				await new Promise((r) => setTimeout(r, Math.min(wait, 20_000)));
				continue;
			}
			let msg = text;
			try { msg = JSON.parse(text).error?.message || text; } catch {}
			throw new AnthropicError(`Claude ${pathname} failed (${res.status}): ${String(msg).slice(0, 300)}`, res.status, text);
		}
	}

	// `user` is a string or an array of parts in the OpenAI shape ({type:'text'} and
	// {type:'image_url', image_url:{url:'data:…;base64,…'}}); images are converted for Claude.
	async json({ system, user, schemaName, schema, model, maxTokens = 16000 }) {
		const content = typeof user === 'string' ? [{ type: 'text', text: user }] : user.map(toClaudePart);
		const data = await this.request('/messages', {
			model: model || this.model,
			max_tokens: maxTokens,
			system,
			messages: [{ role: 'user', content }],
			tools: [{ name: schemaName, description: 'Return the result in exactly this structure.', input_schema: schema }],
			tool_choice: { type: 'tool', name: schemaName },
		});
		if (data.stop_reason === 'refusal') throw new AnthropicError('Claude declined this request.', 200, JSON.stringify(data).slice(0, 300));
		const call = (data.content || []).find((b) => b.type === 'tool_use' && b.name === schemaName);
		if (data.stop_reason === 'max_tokens') throw new AnthropicError('Claude ran out of output space before finishing. Ask for fewer reels at a time.', 200, '');
		if (!call?.input) throw new AnthropicError('Claude returned no structured answer.', 200, JSON.stringify(data).slice(0, 300));
		return call.input;
	}

	// Cheap key check: list models.
	async check() {
		const data = await this.request('/models?limit=5', null, { method: 'GET', retries: 0 });
		return (data.data || []).map((m) => m.id);
	}
}

export function toClaudePart(p) {
	if (p.type === 'image_url') {
		const m = /^data:([^;]+);base64,(.*)$/s.exec(p.image_url?.url || '');
		if (!m) throw new AnthropicError('Only inline (base64) images can be sent to Claude.', 0, '');
		return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
	}
	return { type: 'text', text: String(p.text ?? '') };
}
