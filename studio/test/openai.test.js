// The OpenAI provider sends the expected requests and turns the responses into a rendered reel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeServer, tmpDir, samplePng, sampleMp3 } from './helpers.js';
import { createProvider } from '../src/providers.js';
import { planWeek, reviseReel } from '../src/planner.js';
import { renderReel } from '../src/render.js';
import { probe } from '../src/ffmpeg.js';
import { ROOT } from '../src/config.js';

const reel = (title) => ({
	title, format: 'how_to', hook: 'Proof your dough overnight',
	scenes: [
		{ seconds: 3, visual: 'Hands shaping sourdough on a floured bench', on_screen_text: 'Proof your dough overnight', voiceover: 'Want a better crust? Proof overnight.' },
		{ seconds: 3, visual: 'Golden loaf cooling on a rack', on_screen_text: 'Cold proof, better flavour', voiceover: 'The cold slows the yeast and builds flavour.' },
	],
	caption: 'Overnight proofing, explained.', hashtags: ['#sourdough', 'baking'], cta: 'Order ahead', best_time: '18:30',
});

test('OpenAI provider: planning, revision, images and voice', async () => {
	const dir = tmpDir();
	const png = await samplePng(dir), mp3 = await sampleMp3(dir);
	const srv = await fakeServer(({ path: p, body }) => {
		if (p === '/v1/chat/completions') {
			const schema = body.response_format.json_schema;
			const out = schema.name === 'reel_week' ? { reels: [reel('Overnight proof'), reel('Crust secrets')] } : reel('Overnight proof v2');
			return { json: { choices: [{ message: { role: 'assistant', content: JSON.stringify(out), refusal: null } }] } };
		}
		if (p === '/v1/images/generations') return { json: { data: [{ b64_json: png.toString('base64') }] } };
		if (p === '/v1/audio/speech') return { buffer: mp3, type: 'audio/mpeg' };
		return { status: 404, json: { error: { message: 'nope' } } };
	});
	try {
		const cfg = {
			mock: false, fontsDir: path.join(ROOT, 'assets', 'fonts'), accentColor: '#C8F53A',
			openai: { apiKey: 'sk-test', baseUrl: `${srv.url}/v1`, textModel: 'gpt-4o', imageModel: 'gpt-image-1', imageQuality: 'medium', ttsModel: 'gpt-4o-mini-tts', ttsVoice: 'alloy' },
		};
		const provider = createProvider(cfg);
		assert.equal(provider.name, 'openai');

		const week = await planWeek(provider, { name: 'Northside Bakery', description: 'Sourdough bakery', language: 'English' }, 2);
		assert.equal(week.length, 2);
		assert.deepEqual(week[0].hashtags, ['sourdough', 'baking'], 'hashtags are normalised without #');
		const chat = srv.calls.find((c) => c.path === '/v1/chat/completions');
		assert.equal(chat.headers.authorization, 'Bearer sk-test');
		assert.equal(chat.body.model, 'gpt-4o');
		assert.equal(chat.body.response_format.type, 'json_schema');
		assert.equal(chat.body.response_format.json_schema.strict, true);
		assert.match(chat.body.messages[1].content, /Northside Bakery/);

		const rev = await reviseReel(provider, { name: 'Northside Bakery' }, week[0], 'make it shorter');
		assert.equal(rev.title, 'Overnight proof v2');
		assert.match(srv.calls.at(-1).body.messages[1].content, /make it shorter/);

		const out = path.join(dir, 'reel');
		const media = await renderReel({ plan: week[0], dir: out, provider, cfg });
		const imgCalls = srv.calls.filter((c) => c.path === '/v1/images/generations');
		const ttsCalls = srv.calls.filter((c) => c.path === '/v1/audio/speech');
		assert.equal(imgCalls.length, 2);
		assert.equal(imgCalls[0].body.size, '1024x1536');
		assert.equal(imgCalls[0].body.model, 'gpt-image-1');
		assert.match(imgCalls[0].body.prompt, /No text, letters, logos/);
		assert.equal(ttsCalls.length, 2);
		assert.equal(ttsCalls[0].body.voice, 'alloy');
		assert.equal(ttsCalls[0].body.response_format, 'mp3');

		const info = await probe(path.join(out, media.video));
		assert.equal(info.video.width, 1080);
		assert.equal(info.video.height, 1920);
		assert.equal(info.audio, 'aac');
		assert.ok(info.duration >= 5.5 && info.duration <= 8, `duration ${info.duration}`);
		assert.ok(fs.existsSync(path.join(out, media.thumb)));

		// Re-rendering unchanged scenes reuses images and voice (no new API calls).
		const before = srv.calls.length;
		await renderReel({ plan: week[0], dir: out, provider, cfg });
		assert.equal(srv.calls.length, before, 'cached media reused');
		// Changing one scene regenerates only that scene.
		const changed = structuredClone(week[0]);
		changed.scenes[1].voiceover = 'Cold proofing builds a deeper, tangier flavour.';
		await renderReel({ plan: changed, dir: out, provider, cfg });
		assert.equal(srv.calls.length - before, 1, 'only the changed voice line is regenerated');
	} finally {
		await srv.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('OpenAI provider: API errors surface with the OpenAI message; 5xx is retried', async () => {
	let n = 0;
	const srv = await fakeServer(({ path: p }) => {
		if (p === '/v1/chat/completions') return { status: 401, json: { error: { message: 'Incorrect API key provided' } } };
		n++; return n < 2 ? { status: 503, json: { error: { message: 'busy' } } } : { json: { data: [{ b64_json: Buffer.from('x').toString('base64') }] } };
	});
	try {
		const provider = createProvider({ mock: false, openai: { apiKey: 'bad', baseUrl: `${srv.url}/v1`, textModel: 'gpt-4o', imageModel: 'gpt-image-1', imageQuality: 'low', ttsModel: 'tts-1', ttsVoice: 'alloy' } });
		await assert.rejects(planWeek(provider, { name: 'x' }, 1), /401.*Incorrect API key/);
		const dir = tmpDir();
		await provider.image('a loaf', path.join(dir, 'i.png'));
		assert.equal(n, 2, 'one retry after a 503');
		fs.rmSync(dir, { recursive: true, force: true });
	} finally { await srv.close(); }
});
