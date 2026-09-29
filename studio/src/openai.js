// Minimal OpenAI REST client: structured JSON chat (text or images), image generation,
// text-to-speech and speech-to-text. Uses fetch directly so there is no SDK version to keep in
// step; the base URL is configurable.
import fs from 'node:fs';
import path from 'node:path';

export class OpenAIError extends Error {
	constructor(message, status, body) {
		super(message);
		this.status = status;
		this.body = body;
	}
}

export class OpenAIClient {
	constructor({ apiKey, baseUrl, textModel, imageModel, imageQuality, ttsModel, ttsVoice, visionModel, transcribeModel }) {
		Object.assign(this, { apiKey, baseUrl, textModel, imageModel, imageQuality, ttsModel, ttsVoice });
		this.visionModel = visionModel || textModel;
		this.transcribeModel = transcribeModel || 'whisper-1';
	}

	async request(pathname, body, { binary = false, retries = 2 } = {}) {
		for (let attempt = 0; ; attempt++) {
			const form = body instanceof FormData;
			const res = await fetch(`${this.baseUrl}${pathname}`, {
				method: 'POST',
				headers: form ? { Authorization: `Bearer ${this.apiKey}` } : { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
				body: form ? body : JSON.stringify(body),
				signal: AbortSignal.timeout(180_000),
			});
			if (res.ok) return binary ? Buffer.from(await res.arrayBuffer()) : res.json();
			const text = await res.text();
			const retryable = res.status === 429 || res.status >= 500;
			if (retryable && attempt < retries) {
				await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
				continue;
			}
			let msg = text;
			try { msg = JSON.parse(text).error?.message || text; } catch {}
			throw new OpenAIError(`OpenAI ${pathname} failed (${res.status}): ${msg.slice(0, 300)}`, res.status, text);
		}
	}

	// Chat completion constrained to a JSON schema (Structured Outputs). `user` is a string, or an
	// array of content parts (text and images) for vision.
	async json({ system, user, schemaName, schema, model }) {
		const data = await this.request('/chat/completions', {
			model: model || this.textModel,
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
			response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
		});
		const msg = data.choices?.[0]?.message;
		if (!msg) throw new OpenAIError('OpenAI returned no message', 200, JSON.stringify(data).slice(0, 500));
		if (msg.refusal) throw new OpenAIError(`OpenAI refused: ${msg.refusal}`, 200, msg.refusal);
		return JSON.parse(msg.content);
	}

	// Portrait image as a PNG/JPEG buffer.
	async image(prompt) {
		const dalle = this.imageModel.startsWith('dall-e');
		const body = dalle
			? { model: this.imageModel, prompt, n: 1, size: '1024x1792', response_format: 'b64_json' }
			: { model: this.imageModel, prompt, n: 1, size: '1024x1536', quality: this.imageQuality };
		const data = await this.request('/images/generations', body);
		const item = data.data?.[0];
		if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
		if (item?.url) {
			const r = await fetch(item.url, { signal: AbortSignal.timeout(60_000) });
			if (!r.ok) throw new OpenAIError(`Image download failed (${r.status})`, r.status, '');
			return Buffer.from(await r.arrayBuffer());
		}
		throw new OpenAIError('OpenAI returned no image', 200, JSON.stringify(data).slice(0, 300));
	}

	// Spoken MP3 for one line of voiceover.
	async speech(text, { instructions } = {}) {
		const body = { model: this.ttsModel, voice: this.ttsVoice, input: text, response_format: 'mp3' };
		if (instructions && !this.ttsModel.startsWith('tts-1')) body.instructions = instructions;
		return this.request('/audio/speech', body, { binary: true });
	}

	// Speech-to-text. whisper-1 returns segment and word timings; other models return text only.
	async transcribe(file) {
		const timed = this.transcribeModel.startsWith('whisper');
		const form = new FormData();
		form.append('file', new Blob([await fs.promises.readFile(file)], { type: 'audio/mpeg' }), path.basename(file));
		form.append('model', this.transcribeModel);
		form.append('response_format', timed ? 'verbose_json' : 'json');
		if (timed) { form.append('timestamp_granularities[]', 'segment'); form.append('timestamp_granularities[]', 'word'); }
		const data = await this.request('/audio/transcriptions', form);
		const num = (v) => Math.round(Number(v) * 100) / 100;
		return {
			language: data.language || null,
			text: String(data.text || '').trim(),
			segments: (data.segments || []).map((s) => ({ start: num(s.start), end: num(s.end), text: String(s.text || '').trim() })),
			words: (data.words || []).map((w) => ({ start: num(w.start), end: num(w.end), word: String(w.word || '').trim() })),
		};
	}
}
