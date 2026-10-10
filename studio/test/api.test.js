// End to end through the HTTP API in mock mode: brand -> week -> render -> approve / revise -> post.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, waitFor, fakeServer } from './helpers.js';
import { createApp } from '../src/server.js';
import { ROOT } from '../src/config.js';

const baseCfg = (dataDir, ig = {}) => ({
	port: 0, dataDir, fontsDir: path.join(ROOT, 'assets', 'fonts'), mock: true, accentColor: '#C8F53A', schedulerIntervalMs: 60000,
	openai: {}, instagram: { userId: '', accessToken: '', graphBaseUrl: '', graphVersion: 'v21.0', publicBaseUrl: '', pollIntervalMs: 10, pollTimeoutMs: 2000, ...ig },
});

async function start(cfg) {
	const ctx = createApp(cfg, { log: { error() {}, log() {} } });
	const server = await new Promise((r) => { const s = ctx.app.listen(0, '127.0.0.1', () => r(s)); });
	const base = `http://127.0.0.1:${server.address().port}`;
	const call = async (method, p, body) => {
		const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
		return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.arrayBuffer() };
	};
	return { ctx, base, call, close: async () => { await new Promise((r) => server.close(r)); ctx.jobs.stop(); await ctx.store.flush(); } };
}

test('plan, render, approve and revise a week in mock mode', async () => {
	const dir = tmpDir();
	const s = await start(baseCfg(dir));
	try {
		assert.equal((await s.call('POST', '/api/brands', {})).status, 400, 'needs website or description');
		const brand = (await s.call('POST', '/api/brands', { name: 'Northside Bakery', description: 'Sourdough bakery', offer: 'Order ahead' })).body;
		const week = await s.call('POST', `/api/brands/${brand.id}/week`, { count: 2, startDate: '2026-10-05' });
		assert.equal(week.status, 201);
		assert.equal(week.body.length, 2);
		assert.ok(new Date(week.body[1].scheduledAt) > new Date(week.body[0].scheduledAt));

		const ready = await waitFor(async () => {
			const list = (await s.call('GET', `/api/reels?brandId=${brand.id}`)).body;
			return list.every((r) => r.status === 'ready') && list;
		});
		const [a, b] = ready;
		assert.ok(a.videoUrl && a.thumbUrl);
		const mp4 = await s.call('GET', `/api/reels/${a.id}/download`);
		assert.equal(mp4.status, 200);
		assert.ok(mp4.body.byteLength > 50_000);

		const approved = await s.call('POST', `/api/reels/${a.id}/approve`, {});
		assert.equal(approved.body.status, 'approved');

		assert.equal((await s.call('POST', `/api/reels/${b.id}/revise`, {})).status, 400, 'feedback required');
		const revised = await s.call('POST', `/api/reels/${b.id}/revise`, { feedback: 'Stronger hook' });
		assert.equal(revised.status, 200);
		assert.match(revised.body.plan.hook, /revised: Stronger hook/);
		const after = await waitFor(async () => { const r = (await s.call('GET', `/api/reels/${b.id}`)).body; return r.status === 'ready' && r; });
		assert.equal(after.history.length, 1);

		// Posting is refused without Instagram settings, and the scheduler does nothing.
		const post = await s.call('POST', `/api/reels/${a.id}/publish`);
		assert.equal(post.status, 500);
		assert.match(post.body.error, /Instagram is not connected/);
		assert.deepEqual(await s.ctx.jobs.tick(new Date('2030-01-01')), []);
	} finally {
		await s.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('scheduler posts approved reels that are due', async () => {
	const dir = tmpDir();
	const graph = await fakeServer(({ method, path: p }) => {
		if (method === 'POST' && p.endsWith('/media')) return { json: { id: 'cont' } };
		if (method === 'GET') return { json: { status_code: 'FINISHED' } };
		return { json: { id: 'posted-1' } };
	});
	const s = await start(baseCfg(dir, { userId: '1784', accessToken: 'tok', graphBaseUrl: graph.url, publicBaseUrl: 'https://studio.example.com' }));
	try {
		const brand = (await s.call('POST', '/api/brands', { description: 'Bike repair shop' })).body;
		const [reel] = (await s.call('POST', `/api/brands/${brand.id}/week`, { count: 1, startDate: '2026-10-05' })).body;
		await waitFor(async () => (await s.call('GET', `/api/reels/${reel.id}`)).body.status === 'ready');
		await s.call('POST', `/api/reels/${reel.id}/approve`, {});
		assert.deepEqual(await s.ctx.jobs.tick(new Date('2026-10-01')), [], 'not due yet');
		const posted = await s.ctx.jobs.tick(new Date('2026-10-06'));
		assert.equal(posted.length, 1);
		const r = (await s.call('GET', `/api/reels/${reel.id}`)).body;
		assert.equal(r.status, 'posted');
		assert.equal(r.ig.mediaId, 'posted-1');
		assert.match(graph.calls[0].body.video_url, /^https:\/\/studio\.example\.com\/media\/reel_[0-9a-f]+\/reel\.mp4\?v=/);
	} finally {
		await s.close(); await graph.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
