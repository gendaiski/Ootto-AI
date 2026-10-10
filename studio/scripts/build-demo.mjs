// Builds a static, server-free demo of the studio into demo-dist/:
// renders a sample week with the real pipeline in mock mode, watches three of those reels back
// through Watch & remake, finds their patterns, and makes a remake and a pattern-based reel.
// Writes one self-contained page (styles and scripts inlined) plus videos, thumbnails and frames.
// usage: node scripts/build-demo.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/server.js';
import { ROOT } from '../src/config.js';
import { ffmpeg } from '../src/ffmpeg.js';
import { normalizeBreakdown } from '../src/analyze.js';

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

// Watch three of the rendered reels back in, as uploads (they are the bakery's own reels).
console.log('watching 3 reels…');
const watched = [];
for (const r of reels.slice(3, 6)) {
	const file = fs.readFileSync(path.join(dataDir, 'media', r.id, r.media.video));
	const res = await fetch(`${base}/api/sources/upload?name=${encodeURIComponent(`${r.plan.title}.mp4`)}`, { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: file });
	watched.push({ reel: r, source: await res.json() });
}
for (const w of watched) w.source = await until(async () => { const x = await call('GET', `/api/sources/${w.source.id}`); return x.status === 'ready' && x; });
// Mock mode measures cuts and frames but cannot read text or hear speech. For the demo, fill those
// from each reel's own script (a real OpenAI analysis reads them from the frames and audio).
const HOOKS = { tips: 'list_promise', myth_vs_fact: 'contrarian', how_to: 'how_to_promise', faq: 'question', customer_story: 'story_open', behind_the_scenes: 'curiosity_gap', offer: 'bold_claim' };
for (const { reel, source } of watched) {
	const p = reel.plan;
	const shots = ['close_up', 'wide', 'product', 'face_to_camera'];
	const beats = reel.media.scenes.map((sc, i) => ({
		start: sc.start, end: sc.start + sc.duration, purpose: i === 0 ? 'hook' : i === p.scenes.length - 1 ? 'cta' : i === 1 ? 'problem' : 'point',
		shot: shots[i % shots.length], text_position: 'top', on_screen_text: p.scenes[i].on_screen_text, spoken: p.scenes[i].voiceover, visual: p.scenes[i].visual,
	}));
	const breakdown = normalizeBreakdown({
		topic: p.title, summary: `${{ tips: 'A tips', myth_vs_fact: 'A myth-versus-fact', how_to: 'A how-to', faq: 'An FAQ', customer_story: 'A customer story', behind_the_scenes: 'A behind-the-scenes', offer: 'An offer' }[p.format] || 'A'} reel for a neighbourhood bakery: a text hook, a quick explanation, then a call to order ahead.`,
		format: 'faceless_voiceover',
		hook: { type: HOOKS[p.format] || 'other', seconds: beats[0].end, on_screen_text: p.hook, spoken: p.scenes[0].voiceover, visual: p.scenes[0].visual, why_it_works: 'The first frame states the promise in big text, so the viewer knows what they get before the first cut.' },
		beats, pacing: { notes: 'Steady 3 to 4 second beats, one idea per cut, with the call to action held on the last shot.' },
		layout: { text_position: 'top', caption_style: 'Boxed white headline at the top; word-by-word captions with a lime highlight near the bottom.', framing: 'Vertical, close and medium shots, slow push-ins and pans.', colors: 'Warm, natural light.' },
		audio: { voiceover: true, music: 'none', notes: '' },
		cta: p.cta, why_it_works: ['Hook text lands in the first second', 'One idea per beat keeps attention', 'Same call to action every time builds recall'],
		template: '[Hook: promise or warning] → [Problem the viewer has] → [The fix, 1 to 2 beats] → [Call to action]',
	}, { duration: source.video.duration, cuts: source.cuts });
	const transcript = { source: 'script', language: 'en', text: p.scenes.map((x) => x.voiceover).join(' '), segments: beats.map((b) => ({ start: b.start, end: b.end, text: b.spoken })), words: [] };
	store.updateSource(source.id, { breakdown, transcript, warnings: [], analyzedWith: "demo: text and speech filled from the reel's own script (mock mode cannot read video)" });
}
console.log('finding patterns, remaking, planning from patterns…');
const profile = await call('POST', '/api/patterns', { sourceIds: watched.map((w) => w.source.id), name: 'Bakery tips that work' });
const remake = await call('POST', `/api/sources/${watched[0].source.id}/remake`, { brandId: brand.id, mode: 'format' });
await call('POST', `/api/brands/${brand.id}/week`, { count: 1, startDate, profileId: profile.id });
reels = await until(async () => { const l = await call('GET', `/api/reels?brandId=${brand.id}`); return l.every((r) => ['ready', 'approved'].includes(r.status)) && l; });
const sources = await call('GET', '/api/sources');
const profiles = await call('GET', '/api/patterns');
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
// Watched reels: frames are copied; the video is the reel it came from (same file).
for (const x of sources) {
	const w = watched.find((v) => v.source.id === x.id);
	const from = reels.find((r) => r.id === w.reel.id);
	fs.mkdirSync(path.join(out, 'media', x.id, 'frames'), { recursive: true });
	for (const f of x.frames) fs.copyFileSync(path.join(dataDir, 'media', x.id, f.file), path.join(out, 'media', x.id, f.file));
	x.frames = x.frames.map((f) => ({ ...f, url: `media/${x.id}/${f.file}` }));
	x.thumbUrl = x.frames[0]?.url || null;
	x.videoUrl = from.videoUrl;
	x.videoWebmUrl = from.videoWebmUrl;
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
const seed = JSON.stringify({ brand: store.brand(brand.id), reels, sources, profiles, remakeId: remake.id }).replace(/</g, '\\u003c');
let html = pub('index.html')
	.replace('<link rel="stylesheet" href="studio.css" />', () => `<style>${pub('studio.css')}</style>`)
	.replace('<script src="studio.js" type="module"></script>', () => `<script>window.__OOTTO_DEMO__ = ${seed};</script>\n<script>${demoJs}</script>\n<script type="module">${pub('studio.js')}</script>`)
	.replace('<title>Ootto Studio</title>', '<title>Ootto Studio Demo</title>');
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.rmSync(dataDir, { recursive: true, force: true });
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const files = walk(path.join(out, 'media'));
const size = files.reduce((a, f) => a + fs.statSync(f).size, 0);
console.log(`demo written to ${out} (${reels.length} reels, ${sources.length} watched, ${files.length} media files, ${(size / 1e6).toFixed(1)} MB)`);
