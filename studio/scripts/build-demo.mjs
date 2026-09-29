// Builds a static, server-free demo of the studio into demo-dist/:
// renders a sample week with the real pipeline in mock mode, then writes one self-contained
// page (styles and scripts inlined) plus the rendered videos and thumbnails.
// usage: node scripts/build-demo.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/server.js';
import { ROOT } from '../src/config.js';
import { ffmpeg } from '../src/ffmpeg.js';

const out = path.join(ROOT, 'demo-dist');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ootto-demo-'));
const cfg = {
	port: 0, dataDir, fontsDir: path.join(ROOT, 'assets', 'fonts'), mock: true, accentColor: '#C8F53A', schedulerIntervalMs: 3600000,
	openai: {}, instagram: { userId: '', accessToken: '', graphBaseUrl: '', graphVersion: 'v21.0', publicBaseUrl: '', pollIntervalMs: 1000, pollTimeoutMs: 1000 },
};
const { app, store, jobs } = createApp(cfg, { log: { error: console.error, log() {} } });
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, p, body) => (await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
const until = async (fn) => { for (;;) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 500)); } };

const start = new Date(Date.now() + 86400000);
const startDate = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
const brand = await call('POST', '/api/brands', {
	name: 'Northside Bakery', description: 'Neighbourhood sourdough bakery. Fresh bread daily, pastries at weekends, celebration cakes to order.',
	audience: 'Locals aged 25-45 who care about real ingredients', offer: 'Order ahead on our website', tone: 'friendly and expert',
});
console.log('rendering 7 reels in mock mode…');
await call('POST', `/api/brands/${brand.id}/week`, { count: 7, startDate });
let reels = await until(async () => { const l = await call('GET', `/api/reels?brandId=${brand.id}`); return l.every((r) => r.status === 'ready') && l; });
await call('POST', `/api/reels/${reels[0].id}/approve`, {});
await call('POST', `/api/reels/${reels[1].id}/approve`, {});
await call('POST', `/api/reels/${reels[2].id}/revise`, { feedback: 'Make the hook stronger' });
await until(async () => (await call('GET', `/api/reels/${reels[2].id}`)).status === 'ready');
reels = await call('GET', `/api/reels?brandId=${brand.id}`);
server.close(); jobs.stop(); await store.flush();

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'media'), { recursive: true });
for (const r of reels) {
	const dst = path.join(out, 'media', r.id);
	fs.mkdirSync(dst, { recursive: true });
	for (const f of [r.media.video, r.media.thumb]) fs.copyFileSync(path.join(dataDir, 'media', r.id, f), path.join(dst, f));
	r.videoUrl = `media/${r.id}/${r.media.video}`;
	r.thumbUrl = `media/${r.id}/${r.media.thumb}`;
	r.videoWebmUrl = `media/${r.id}/reel.webm`;
}
// WebM copies so the demo also plays in browsers built without H.264 (e.g. open-source Chromium).
console.log('adding WebM copies…');
const todo = [...reels];
await Promise.all(Array.from({ length: 3 }, async () => {
	for (let r; (r = todo.shift()); ) {
		const dst = path.join(out, 'media', r.id);
		await ffmpeg(['-i', path.join(dst, r.media.video), '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '38', '-deadline', 'good', '-cpu-used', '5', '-row-mt', '1', '-c:a', 'libopus', '-b:a', '64k', path.join(dst, 'reel.webm')]);
	}
}));
const pub = (f) => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
const demoJs = fs.readFileSync(path.join(ROOT, 'scripts', 'demo-shim.js'), 'utf8');
const seed = JSON.stringify({ brand: store.brand(brand.id), reels }).replace(/</g, '\\u003c');
let html = pub('index.html')
	.replace('<link rel="stylesheet" href="studio.css" />', () => `<style>${pub('studio.css')}</style>`)
	.replace('<script src="studio.js" type="module"></script>', () => `<script>window.__OOTTO_DEMO__ = ${seed};</script>\n<script>${demoJs}</script>\n<script type="module">${pub('studio.js')}</script>`)
	.replace('<title>Ootto Studio</title>', '<title>Ootto Studio Demo</title>');
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.rmSync(dataDir, { recursive: true, force: true });
const size = fs.readdirSync(path.join(out, 'media')).reduce((a, d) => a + fs.readdirSync(path.join(out, 'media', d)).reduce((b, f) => b + fs.statSync(path.join(out, 'media', d, f)).size, 0), 0);
console.log(`demo written to ${out} (${reels.length} reels, media ${(size / 1e6).toFixed(1)} MB)`);
