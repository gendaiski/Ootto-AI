// Claude (Anthropic) provider: request format, forced tool output, images, retries and errors,
// routing between OpenAI and Claude, and a full Claude-only reel (text cards, captions, no voice).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeServer, tmpDir } from './helpers.js';
import { AnthropicClient, toClaudePart } from '../src/anthropic.js';
import { createProvider, route } from '../src/providers.js';
import { planWeek } from '../src/planner.js';
import { analyzeReel } from '../src/analyze.js';
import { renderReel } from '../src/render.js';
import { probe, ffmpeg } from '../src/ffmpeg.js';
import { ROOT } from '../src/config.js';

const fontsDir = path.join(ROOT, 'assets', 'fonts');
const reel = (title) => ({
	title, format: 'tips', hook: 'Stop oiling your chain like this',
	scenes: [
		{ seconds: 3, visual: 'Close-up of a bike chain', on_screen_text: 'Stop oiling your chain like this', voiceover: 'Stop oiling your chain like this.' },
		{ seconds: 3, visual: 'Hands wiping a chain', on_screen_text: 'Wipe first', voiceover: 'Wipe it first, then one drop per link.' },
	],
	caption: 'Chain care.', hashtags: ['bikes'], cta: 'Book a tune-up', best_time: '17:00',
});
const toolReply = (name, input, extra = {}) => ({ json: { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Here you go.' }, { type: 'tool_use', id: 'tu_1', name, input }], stop_reason: 'tool_use', ...extra } });

test('Claude: plans a week through a forced tool call with the right headers', async () => {
	const srv = await fakeServer(({ path: p, body }) => {
		if (p === '/v1/messages') return toolReply(body.tool_choice.name, { reels: [reel('Chain care'), reel('Brake check')] });
		return { status: 404, json: {} };
	});
	try {
		const provider = createProvider({ openai: {}, anthropic: { apiKey: 'sk-ant-test', baseUrl: `${srv.url}/v1`, model: 'claude-opus-5-5' }, ai: {} });
		assert.equal(provider.name, 'anthropic');
		assert.deepEqual(provider.parts, { text: 'anthropic', vision: 'anthropic', image: 'cards', voice: 'none', transcribe: 'captions' });
		const week = await planWeek(provider, { name: 'Spoke & Chain', description: 'Bike repair', language: 'English' }, 2);
		assert.deepEqual(week.map((r) => r.title), ['Chain care', 'Brake check']);
		const c = srv.calls[0];
		assert.equal(c.headers['x-api-key'], 'sk-ant-test');
		assert.equal(c.headers['anthropic-version'], '2023-06-01');
		assert.equal(c.headers.authorization, undefined, 'no OpenAI-style bearer header');
		assert.equal(c.body.model, 'claude-opus-5-5');
		assert.ok(c.body.max_tokens >= 8000);
		assert.match(c.body.system, /short-form video strategist/);
		assert.deepEqual(c.body.tool_choice, { type: 'tool', name: 'reel_week' });
		assert.equal(c.body.tools[0].name, 'reel_week');
		assert.equal(c.body.tools[0].input_schema.type, 'object');
		assert.ok(c.body.tools[0].input_schema.properties.reels);
		assert.equal(c.body.messages[0].content[0].type, 'text');
		assert.match(c.body.messages[0].content[0].text, /Spoke & Chain/);
	} finally { await srv.close(); }
});

test('Claude: frames are sent as base64 image blocks for reel analysis', async () => {
	const dir = tmpDir();
	await ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=64x112:d=1', '-frames:v', '1', path.join(dir, 'f.jpg')]);
	const srv = await fakeServer(({ body }) => toolReply(body.tool_choice.name, {
		topic: 'chains', summary: 's', format: 'talking_head', hook: { type: 'question', seconds: 1, on_screen_text: 'Why?', spoken: '', visual: 'red', why_it_works: 'asks' },
		beats: [{ start: 0, end: 2, purpose: 'hook', shot: 'close_up', text_position: 'top', on_screen_text: 'Why?', spoken: '', visual: 'red' }],
		pacing: { notes: '' }, layout: { text_position: 'top', caption_style: '', framing: '', colors: '' }, audio: { voiceover: false, music: 'none', notes: '' }, cta: '', why_it_works: ['x'], template: 't',
	}));
	try {
		const provider = createProvider({ openai: {}, anthropic: { apiKey: 'sk-ant-test', baseUrl: `${srv.url}/v1`, model: 'claude-sonnet-5-5' }, ai: {} });
		const b = await analyzeReel(provider, { duration: 2, cuts: [], frames: [{ t: 0.1, file: 'f.jpg' }], transcript: null, meta: null }, dir);
		assert.equal(b.hook.type, 'question');
		const content = srv.calls[0].body.messages[0].content;
		const img = content.find((x) => x.type === 'image');
		assert.equal(img.source.type, 'base64');
		assert.equal(img.source.media_type, 'image/jpeg');
		assert.ok(img.source.data.length > 100);
		assert.ok(content.some((x) => x.type === 'text' && /Frame at 0\.10s/.test(x.text)));
		assert.equal(srv.calls[0].body.model, 'claude-sonnet-5-5');
		assert.throws(() => toClaudePart({ type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } }), /base64/);
	} finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Claude: 529 overloaded is retried; errors, max_tokens and refusals are explained', async () => {
	let n = 0;
	const srv = await fakeServer(({ path: p, body }) => {
		if (p === '/v1/models') return { status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } };
		const t = body.messages[0].content[0].text;
		if (t === 'busy') return ++n < 2 ? { status: 529, json: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } } : toolReply('x', { ok: true });
		if (t === 'long') return toolReply('x', { partial: true }, { stop_reason: 'max_tokens' });
		if (t === 'no') return { json: { content: [{ type: 'text', text: 'I cannot help with that.' }], stop_reason: 'refusal' } };
		return { json: { content: [{ type: 'text', text: 'plain text' }], stop_reason: 'end_turn' } };
	});
	try {
		const c = new AnthropicClient({ apiKey: 'sk-ant-bad', baseUrl: `${srv.url}/v1` });
		const schema = { type: 'object', properties: {}, additionalProperties: true };
		assert.deepEqual(await c.json({ system: 's', user: 'busy', schemaName: 'x', schema }), { ok: true });
		assert.equal(n, 2, 'retried once after 529');
		await assert.rejects(c.json({ system: 's', user: 'long', schemaName: 'x', schema }), /ran out of output space/);
		await assert.rejects(c.json({ system: 's', user: 'no', schemaName: 'x', schema }), /declined/);
		await assert.rejects(c.json({ system: 's', user: 'other', schemaName: 'x', schema }), /no structured answer/);
		await assert.rejects(c.check(), /401.*invalid x-api-key/);
	} finally { await srv.close(); }
});

test('routing: each job goes to the chosen service when its key exists', () => {
	assert.equal(route('auto', { openai: true, anthropic: true }), 'openai');
	assert.equal(route('anthropic', { openai: true, anthropic: true }), 'anthropic');
	assert.equal(route('anthropic', { openai: true, anthropic: false }), 'openai');
	assert.equal(route('openai', { openai: false, anthropic: true }), 'anthropic');
	const both = createProvider({
		openai: { apiKey: 'sk-x', baseUrl: 'http://127.0.0.1:9', textModel: 'gpt-4o', imageModel: 'gpt-image-1', ttsModel: 'gpt-4o-mini-tts', ttsVoice: 'alloy' },
		anthropic: { apiKey: 'sk-ant-x', model: 'claude-opus-5-5' }, ai: { text: 'anthropic', vision: 'openai' },
	});
	assert.deepEqual(both.parts, { text: 'anthropic', vision: 'openai', image: 'openai', voice: 'openai', transcribe: 'openai' });
	assert.equal(both.models.text, 'claude-opus-5-5');
	assert.equal(createProvider({ mock: true, openai: {}, anthropic: {} }).mode, 'mock');
});

test('Claude only: a reel renders with text-card visuals, captions and a silent track', async () => {
	const dir = tmpDir();
	try {
		const provider = createProvider({ accentColor: '#C8F53A', openai: {}, anthropic: { apiKey: 'sk-ant-x', model: 'claude-opus-5-5' }, ai: {} });
		const media = await renderReel({ plan: reel('Chain care'), dir, provider, cfg: { fontsDir, accentColor: '#C8F53A' } });
		const info = await probe(path.join(dir, media.video));
		assert.equal(info.video.width, 1080);
		assert.equal(info.audio, 'aac');
		assert.ok(media.duration >= 5.5, `duration ${media.duration}`);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
