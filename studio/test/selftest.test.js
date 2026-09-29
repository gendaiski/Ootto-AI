// System check: every part reports ok / warn / fail / skip with a clear next step, and no call
// spends credits (keys: list models; Instagram: read the account name).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeServer, tmpDir } from './helpers.js';
import { runSelfTest } from '../src/selftest.js';
import { createApp } from '../src/server.js';
import { ROOT, WATCH_DEFAULTS } from '../src/config.js';

const fontsDir = path.join(ROOT, 'assets', 'fonts');
const byId = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c]));

test('all parts: working OpenAI key, rejected Claude key, Instagram and the public address', async () => {
	const dir = tmpDir();
	const srv = await fakeServer(({ path: p, headers, query }) => {
		if (p === '/v1/models' && headers.authorization) return { json: { data: [{ id: 'gpt-4o' }] } };
		if (p === '/v1/models') return { status: 401, json: { error: { message: 'invalid x-api-key' } } };
		if (p === '/v21.0/1784') return query.access_token === 'tok' ? { json: { username: 'northsidebakery', id: '1784' } } : { status: 400, json: { error: { message: 'Invalid OAuth access token' } } };
		if (p === '/api/status') return { status: 401, json: {} };
		return { status: 404, json: {} };
	});
	try {
		const eff = {
			dataDir: dir, fontsDir, host: '127.0.0.1', password: 'pw', watch: { ...WATCH_DEFAULTS, ytdlpPath: path.join(dir, 'no-yt-dlp') },
			openai: { apiKey: 'sk-x', baseUrl: `${srv.url}/v1` }, anthropic: { apiKey: 'sk-ant-bad', baseUrl: `${srv.url}/v1` },
			instagram: { userId: '1784', accessToken: 'tok', graphBaseUrl: srv.url, graphVersion: 'v21.0', publicBaseUrl: srv.url.replace('http://', 'https://') },
		};
		// The public address must be https; point the check at the fake server through fetchImpl.
		const fetchImpl = (u, o) => fetch(String(u).replace(/^https:/, 'http:'), o);
		const r = await runSelfTest(eff, { fetchImpl });
		const c = byId(r);
		assert.equal(c.node.status, 'ok');
		assert.equal(c.data.status, 'ok');
		assert.equal(c.ffmpeg.status, 'ok', c.ffmpeg.detail);
		assert.equal(c.ytdlp.status, 'warn');
		assert.match(c.ytdlp.detail, /pip install yt-dlp/);
		assert.equal(c.openai.status, 'ok');
		assert.equal(c.anthropic.status, 'fail');
		assert.match(c.anthropic.detail, /invalid x-api-key/);
		assert.equal(c.ai.status, 'ok');
		assert.equal(c.instagram.status, 'ok');
		assert.match(c.instagram.detail, /@northsidebakery/);
		assert.equal(c.public.status, 'ok', c.public.detail);
		assert.equal(c.password.status, 'ok');
		assert.equal(r.ok, false, 'a failed check makes the whole result not ok');
		assert.ok(srv.calls.every((x) => x.method === 'GET'), 'only read-only calls');
	} finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('warnings: no keys (mock), http public address, exposed without a password', async () => {
	const dir = tmpDir();
	try {
		const r = await runSelfTest({
			dataDir: dir, fontsDir, host: '0.0.0.0', password: '', watch: { ...WATCH_DEFAULTS, ytdlpPath: path.join(dir, 'none') },
			openai: {}, anthropic: {}, instagram: { publicBaseUrl: 'http://example.com' },
		});
		const c = byId(r);
		assert.equal(c.openai.status, 'skip');
		assert.equal(c.anthropic.status, 'skip');
		assert.equal(c.ai.status, 'warn');
		assert.match(c.ai.detail, /mock mode/);
		assert.equal(c.instagram.status, 'skip');
		assert.equal(c.public.status, 'fail');
		assert.match(c.public.detail, /https/);
		assert.equal(c.password.status, 'warn');
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('API: POST /api/selftest runs the check', async () => {
	const dir = tmpDir();
	const ctx = createApp({
		port: 0, dataDir: dir, fontsDir, mock: true, accentColor: '#C8F53A', schedulerIntervalMs: 60000, host: '127.0.0.1',
		openai: {}, anthropic: {}, instagram: { userId: '', accessToken: '', graphBaseUrl: '', graphVersion: 'v21.0', publicBaseUrl: '', pollIntervalMs: 10, pollTimeoutMs: 2000 },
		watch: { ytdlpPath: path.join(dir, 'none') },
	}, { log: { error() {}, log() {} } });
	const server = await new Promise((r) => { const s = ctx.app.listen(0, '127.0.0.1', () => r(s)); });
	try {
		const res = await fetch(`http://127.0.0.1:${server.address().port}/api/selftest`, { method: 'POST' });
		const body = await res.json();
		assert.equal(res.status, 200);
		assert.equal(body.ok, true);
		assert.equal(byId(body).ffmpeg.status, 'ok');
	} finally { await new Promise((r) => server.close(r)); ctx.jobs.stop(); await ctx.store.flush(); fs.rmSync(dir, { recursive: true, force: true }); }
});
