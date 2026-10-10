// AI settings saved from the Settings page: API keys, which AI does which job, and monthly caps.
// Stored in data/settings.json (file mode 0600), separate from db.json so the library can be
// shared or backed up without secrets. Keys saved here win over the ones in .env; they are never
// sent back to the browser, only a masked hint.
import fs from 'node:fs';
import path from 'node:path';

export const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'];
const CHOICES = ['auto', 'openai', 'anthropic'];

export const mask = (k) => (k ? `…${k.slice(-4)}` : null);

export class Settings {
	constructor(dataDir) {
		this.file = path.join(dataDir, 'settings.json');
		fs.mkdirSync(dataDir, { recursive: true });
		try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = {}; }
	}

	save() {
		const tmp = `${this.file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
		fs.renameSync(tmp, this.file);
		fs.chmodSync(this.file, 0o600);
	}

	// The config the providers should use: .env values with saved settings on top.
	apply(cfg) {
		const d = this.data;
		const openai = { ...cfg.openai, apiKey: d.openaiKey || cfg.openai?.apiKey || '' };
		const anthropic = { ...cfg.anthropic, apiKey: d.anthropicKey || cfg.anthropic?.apiKey || '', model: d.anthropicModel || cfg.anthropic?.model };
		const ai = { text: d.text || cfg.ai?.text || 'auto', vision: d.vision || cfg.ai?.vision || 'auto' };
		const mock = Boolean(cfg.forceMock) || (cfg.mock && !d.openaiKey && !d.anthropicKey) || (!openai.apiKey && !anthropic.apiKey);
		return { ...cfg, openai, anthropic, ai, mock };
	}

	limits() {
		return { imagesPerMonth: Number(this.data.imagesPerMonth) || 0, watchesPerMonth: Number(this.data.watchesPerMonth) || 0 };
	}

	// Validated partial update. Empty strings leave a key unchanged; clear* removes it.
	update(body = {}) {
		const d = this.data;
		const key = (v, prefix, label) => {
			const k = String(v || '').trim();
			if (!k) return undefined;
			if (/\s/.test(k) || k.length < 20 || k.length > 300) throw new Error(`That does not look like a ${label} key.`);
			if (prefix && !k.startsWith(prefix)) throw new Error(`${label} keys start with "${prefix}".`);
			return k;
		};
		const oa = key(body.openaiKey, 'sk-', 'OpenAI');
		const cl = key(body.anthropicKey, 'sk-ant-', 'Claude');
		if (oa) d.openaiKey = oa;
		if (cl) d.anthropicKey = cl;
		if (body.clearOpenaiKey) delete d.openaiKey;
		if (body.clearAnthropicKey) delete d.anthropicKey;
		if (body.text !== undefined) { if (!CHOICES.includes(body.text)) throw new Error('Unknown choice for scripts.'); d.text = body.text; }
		if (body.vision !== undefined) { if (!CHOICES.includes(body.vision)) throw new Error('Unknown choice for reel analysis.'); d.vision = body.vision; }
		if (body.anthropicModel !== undefined) {
			const m = String(body.anthropicModel).trim();
			if (!/^claude-[a-z0-9.-]{3,60}$/.test(m)) throw new Error('That is not a Claude model name.');
			d.anthropicModel = m;
		}
		for (const k of ['imagesPerMonth', 'watchesPerMonth']) {
			if (body[k] === undefined) continue;
			const n = Number(body[k]);
			if (!Number.isInteger(n) || n < 0 || n > 100000) throw new Error('Limits are whole numbers from 0 (no limit) up.');
			d[k] = n;
		}
		this.save();
	}

	// What the browser may see about keys: whether one is set, where it comes from, last 4 chars.
	keyView(cfg) {
		const one = (saved, env) => ({ configured: Boolean(saved || env), source: saved ? 'studio' : env ? 'env' : null, hint: mask(saved || env) });
		return {
			openai: one(this.data.openaiKey, cfg.openai?.apiKey),
			anthropic: one(this.data.anthropicKey, cfg.anthropic?.apiKey),
		};
	}
}

// ---------- usage ----------
// Wraps a provider so every paid call is counted in the store, and image generation stops at the
// monthly cap. Only real (non-mock) calls count.
export function meter(provider, store, getLimits) {
	if (provider.mode !== 'live') return provider;
	const { parts } = provider;
	const count = (kind, service) => store.bumpUsage(`${kind}.${service}`);
	return {
		...provider,
		json: async (req) => { const out = await provider.json(req); count('text', parts.text); return out; },
		vision: async (req) => { const out = await provider.vision(req); count('vision', parts.vision); return out; },
		image: async (prompt, outFile, opts) => {
			if (parts.image === 'openai') {
				const { imagesPerMonth } = getLimits();
				if (imagesPerMonth && store.usage().images >= imagesPerMonth) {
					throw new Error(`Monthly image limit reached (${imagesPerMonth}). Raise it in Settings.`);
				}
			}
			await provider.image(prompt, outFile, opts);
			if (parts.image === 'openai') count('images', 'openai');
		},
		speech: async (line, outFile, opts) => { await provider.speech(line, outFile, opts); if (parts.voice === 'openai') count('voice', 'openai'); },
		transcribe: provider.transcribe ? async (file) => { const out = await provider.transcribe(file); count('transcribe', 'openai'); return out; } : null,
	};
}
