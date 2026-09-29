// Settings page API: keys are saved server-side only, providers switch live, keys can be tested,
// remote edits are refused without a password, usage is counted and caps are enforced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, fakeServer, waitFor } from './helpers.js';
import { createApp } from '../src/server.js';
import { ROOT } from '../src/config.js';

const cfgFor = (dataDir, extra = {}) => ({
	port: 0, dataDir, fontsDir: path.join(ROOT, 'assets', 'fonts'), mock: true, accentColor: '#C8F53A', schedulerIntervalMs: 60000,
	openai: { apiKey: '', baseUrl: 'http://127.0.0.1:9/v1', textModel: 'gpt-4o', imageModel: 'gpt-image-1', imageQuality: 'low', ttsModel: 'gpt-4o-mini-tts', ttsVoice: 'alloy' },
	anthropic: { apiKey: '', baseUrl: 'http://127.0.0.1:9/v1', model: 'claude-opus-5-5' },
	instagram: { userId: '', accessToken: '', graphBaseUrl: '', graphVersion: 'v21.0', publicBaseUrl: '', pollIntervalMs: 10, pollTimeoutMs: 2000 },
	...extra,
});

async function start(cfg) {
	const ctx = createApp(cfg, { log: { error() {}, log() {} } });
	const server = await new Promise((r) => { const s = ctx.app.listen(0, '127.0.0.1', () => r(s)); });
	const base = `http://127.0.0.1:${server.address().port}`;
	const call = async (method, p, body, headers = {}) => {
		const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
		const text = await res.text();
		let json = null; try { json = JSON.parse(text); } catch {}
		return { status: res.status, body: json ?? text };
	};
	return { ctx, call, close: async () => { await new Promise((r) => server.close(r)); ctx.jobs.stop(); await ctx.store.flush(); } };
}

test('keys: saved on disk only, masked in the API, and switch providers without a restart', async () => {
	const dir = tmpDir();
	const s = await start(cfgFor(dir));
	try {
		let v = (await s.call('GET', '/api/settings')).body;
		assert.equal(v.active.mode, 'mock');
		assert.equal(v.keys.openai.configured, false);
		assert.equal(v.canEdit, true);

		assert.equal((await s.call('PUT', '/api/settings', { anthropicKey: 'sk-123' })).status, 400, 'too short');
		assert.match((await s.call('PUT', '/api/settings', { anthropicKey: 'sk-proj-aaaaaaaaaaaaaaaaaaaaaaaa' })).body.error, /start with "sk-ant-"/);
		const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz-WXYZ';
		v = (await s.call('PUT', '/api/settings', { anthropicKey: key, anthropicModel: 'claude-sonnet-5-5' })).body;
		assert.equal(v.active.mode, 'live');
		assert.equal(v.active.parts.text, 'anthropic');
		assert.equal(v.active.models.text, 'claude-sonnet-5-5');
		assert.deepEqual(v.keys.anthropic, { configured: true, source: 'studio', hint: '…WXYZ' });
		assert.ok(!JSON.stringify(v).includes(key), 'the key never comes back');
		assert.ok(!JSON.stringify((await s.call('GET', '/api/status')).body).includes(key));
		const file = path.join(dir, 'settings.json');
		assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).anthropicKey, key);
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		await s.ctx.store.save();
		assert.ok(!fs.readFileSync(path.join(dir, 'db.json'), 'utf8').includes(key), 'not in the main database');

		const oaKey = 'sk-proj-abcdefghijklmnopqrstuvwxyz1234';
		v = (await s.call('PUT', '/api/settings', { openaiKey: oaKey, text: 'anthropic', vision: 'openai' })).body;
		assert.deepEqual(v.active.parts, { text: 'anthropic', vision: 'openai', image: 'openai', voice: 'openai', transcribe: 'openai' });
		assert.equal((await s.call('PUT', '/api/settings', { text: 'gemini' })).status, 400);

		v = (await s.call('PUT', '/api/settings', { clearAnthropicKey: true, clearOpenaiKey: true })).body;
		assert.equal(v.active.mode, 'mock');
		assert.equal(v.keys.anthropic.configured, false);
		assert.equal((await s.call('GET', '/api/status')).body.mode, 'mock');
	} finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('keys from .env show as such; Test checks a key against the service', async () => {
	const dir = tmpDir();
	const oa = await fakeServer(({ path: p, headers }) => (p === '/v1/models' && headers.authorization === 'Bearer sk-good-aaaaaaaaaaaaaaaaaaaa' ? { json: { data: [{ id: 'gpt-4o' }] } } : { status: 401, json: { error: { message: 'Incorrect API key provided' } } }));
	const cl = await fakeServer(({ path: p, headers }) => (p === '/v1/models' && headers['x-api-key'] === 'sk-ant-envkey-aaaaaaaaaaaaaaaa' ? { json: { data: [{ id: 'claude-opus-5-5' }] } } : { status: 401, json: { error: { message: 'invalid x-api-key' } } }));
	const cfg = cfgFor(dir, { mock: false });
	cfg.openai.baseUrl = `${oa.url}/v1`;
	cfg.anthropic = { ...cfg.anthropic, apiKey: 'sk-ant-envkey-aaaaaaaaaaaaaaaa', baseUrl: `${cl.url}/v1` };
	const s = await start(cfg);
	try {
		const v = (await s.call('GET', '/api/settings')).body;
		assert.deepEqual(v.keys.anthropic, { configured: true, source: 'env', hint: '…aaaa' });
		assert.equal(v.active.parts.text, 'anthropic');
		const good = (await s.call('POST', '/api/settings/test', { service: 'anthropic' })).body;
		assert.deepEqual(good, { ok: true, service: 'anthropic', models: ['claude-opus-5-5'] });
		const bad = (await s.call('POST', '/api/settings/test', { service: 'openai', key: 'sk-wrong-aaaaaaaaaaaaaaaaaaaa' })).body;
		assert.equal(bad.ok, false);
		assert.match(bad.error, /Incorrect API key/);
		assert.equal((await s.call('POST', '/api/settings/test', { service: 'openai', key: 'sk-good-aaaaaaaaaaaaaaaaaaaa' })).body.ok, true);
		assert.equal((await s.call('POST', '/api/settings/test', { service: 'openai' })).status, 400, 'nothing to test');
	} finally { await s.close(); await oa.close(); await cl.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('remote requests cannot change settings unless a password is set; the password guards everything but /media', async () => {
	const dir = tmpDir();
	const s = await start(cfgFor(dir));
	try {
		const via = { 'X-Forwarded-For': '203.0.113.9' };
		assert.equal((await s.call('GET', '/api/settings', null, via)).body.canEdit, false);
		const r = await s.call('PUT', '/api/settings', { text: 'openai' }, via);
		assert.equal(r.status, 403);
		assert.match(r.body.error, /STUDIO_PASSWORD/);
		assert.equal((await s.call('POST', '/api/settings/test', { service: 'openai' }, { 'CF-Connecting-IP': '203.0.113.9' })).status, 403);
	} finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }

	const dir2 = tmpDir();
	const p = await start(cfgFor(dir2, { password: 'correct horse' }));
	try {
		assert.equal((await p.call('GET', '/api/status')).status, 401);
		assert.equal((await p.call('GET', '/')).status, 401);
		const wrong = { Authorization: `Basic ${Buffer.from('me:nope').toString('base64')}` };
		assert.equal((await p.call('GET', '/api/status', null, wrong)).status, 401);
		const auth = { Authorization: `Basic ${Buffer.from('anyone:correct horse').toString('base64')}` };
		assert.equal((await p.call('GET', '/api/status', null, auth)).status, 200);
		const v = (await p.call('GET', '/api/settings', null, { ...auth, 'X-Forwarded-For': '203.0.113.9' })).body;
		assert.equal(v.canEdit, true, 'with a password, remote edits are allowed after sign-in');
		assert.notEqual((await p.call('GET', '/media/nothing.mp4')).status, 401, 'media stays reachable for Instagram');
	} finally { await p.close(); fs.rmSync(dir2, { recursive: true, force: true }); }
});

test('usage is counted per month and the monthly caps stop new work', async () => {
	const dir = tmpDir();
	const oa = await fakeServer(async ({ path: p, body }) => {
		if (p === '/v1/chat/completions') {
			const one = { title: 'T', format: 'tips', hook: 'H', scenes: [{ seconds: 2, visual: 'v', on_screen_text: 'H', voiceover: 'Hi.' }], caption: 'c', hashtags: [], cta: 'x', best_time: '18:00' };
			return { json: { choices: [{ message: { content: JSON.stringify({ reels: [one] }) } }] } };
		}
		return { status: 500, json: { error: { message: 'images are not part of this test' } } };
	});
	const cfg = cfgFor(dir, { mock: false });
	cfg.openai = { ...cfg.openai, apiKey: 'sk-test-aaaaaaaaaaaaaaaaaaaaaaaa', baseUrl: `${oa.url}/v1` };
	const s = await start(cfg);
	try {
		// Pretend 5 images were made this month and cap images at 5: the render stops with a clear error.
		s.ctx.store.bumpUsage('images.openai', 5);
		await s.call('PUT', '/api/settings', { imagesPerMonth: 5, watchesPerMonth: 1 });
		const brand = (await s.call('POST', '/api/brands', { description: 'Bike shop' })).body;
		const [r] = (await s.call('POST', `/api/brands/${brand.id}/week`, { count: 1, startDate: '2026-10-05' })).body;
		const u = (await s.call('GET', '/api/settings')).body.usage;
		assert.equal(u.counts['text.openai'], 1);
		assert.equal(u.images, 5);
		assert.match(u.month, /^\d{4}-\d{2}$/);
		const failed = await waitFor(async () => { const x = (await s.call('GET', `/api/reels/${r.id}`)).body; return x.status === 'failed' && x; });
		assert.match(failed.error, /Monthly image limit reached \(5\)/);
		assert.equal(oa.calls.filter((c) => c.path === '/v1/images/generations').length, 0, 'no image was requested');

		const add = await s.call('POST', '/api/sources', { urls: ['https://example.com/a', 'https://example.com/b'] });
		assert.equal(add.status, 400);
		assert.match(add.body.error, /monthly limit of 1 watched reels/);
		assert.equal((await s.call('PUT', '/api/settings', { imagesPerMonth: -1 })).status, 400);
	} finally { await s.close(); await oa.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
