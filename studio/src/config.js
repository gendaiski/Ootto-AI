// Runtime configuration from environment variables and an optional .env file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv(file) {
	if (!fs.existsSync(file)) return;
	for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
		if (!m || process.env[m[1]] !== undefined) continue;
		process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
	}
}
loadDotEnv(path.join(ROOT, '.env'));

const env = (k, d = '') => (process.env[k] ?? d).trim();

export function getConfig() {
	const openaiKey = env('OPENAI_API_KEY');
	const mock = env('MOCK') === '1' || !openaiKey;
	return {
		port: Number(env('PORT', '3000')),
		dataDir: path.resolve(ROOT, env('DATA_DIR', 'data')),
		fontsDir: path.join(ROOT, 'assets', 'fonts'),
		mock,
		openai: {
			apiKey: openaiKey,
			baseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1').replace(/\/$/, ''),
			textModel: env('OPENAI_TEXT_MODEL', 'gpt-4o'),
			imageModel: env('OPENAI_IMAGE_MODEL', 'gpt-image-1'),
			imageQuality: env('OPENAI_IMAGE_QUALITY', 'medium'),
			ttsModel: env('OPENAI_TTS_MODEL', 'gpt-4o-mini-tts'),
			ttsVoice: env('OPENAI_TTS_VOICE', 'alloy'),
		},
		instagram: {
			userId: env('IG_USER_ID'),
			accessToken: env('IG_ACCESS_TOKEN'),
			graphBaseUrl: env('GRAPH_BASE_URL', 'https://graph.facebook.com').replace(/\/$/, ''),
			graphVersion: env('GRAPH_API_VERSION', 'v21.0'),
			publicBaseUrl: env('PUBLIC_BASE_URL').replace(/\/$/, ''),
			pollIntervalMs: Number(env('IG_POLL_INTERVAL_MS', '5000')),
			pollTimeoutMs: Number(env('IG_POLL_TIMEOUT_MS', '600000')),
		},
		schedulerIntervalMs: Number(env('SCHEDULER_INTERVAL_MS', '60000')),
		accentColor: env('ACCENT_COLOR', '#C8F53A'),
	};
}

export function instagramReady(cfg) {
	const ig = cfg.instagram;
	return Boolean(ig.userId && ig.accessToken && ig.publicBaseUrl);
}
