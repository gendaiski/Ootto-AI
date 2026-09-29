// Runs: the single start point. A reel link or an uploaded video goes through the whole chain
// (get → watch → listen → analyse → write → render → review) with the AI chosen for the run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, waitFor, fakeServer, samplePng, sampleMp3 } from './helpers.js';
import { ffmpeg } from '../src/ffmpeg.js';
import { createApp } from '../src/server.js';
import { ROOT } from '../src/config.js';

let work, video, ytdlp;
const fontsDir = path.join(ROOT, 'assets', 'fonts');

before(async () => {
	work = tmpDir('ootto-runs-');
	video = path.join(work, 'clip.mp4');
	await ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=360x640:r=30:d=2', '-f', 'lavfi', '-i', 'color=c=blue:s=360x640:r=30:d=2', '-f', 'lavfi', '-i', 'color=c=green:s=360x640:r=30:d=2',
		'-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100:duration=6',
		'-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-map', '3:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
	ytdlp = path.join(work, 'yt-dlp.mjs');
	fs.writeFileSync(ytdlp, `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('2099.01.01'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(path.join(work, 'downloads.log'))}, a.at(-1) + '\\n');
const url = a.at(-1), dir = path.dirname(a[a.indexOf('-o') + 1]);
if (url.includes('private')) { console.error('ERROR: [Instagram] x: login required'); process.exit(1); }
fs.copyFileSync(${JSON.stringify(video)}, path.join(dir, 'video.mp4'));
fs.writeFileSync(path.join(dir, 'video.info.json'), JSON.stringify({ webpage_url: url, extractor_key: 'Instagram', uploader: 'bakerbob', description: 'Bread tips #bread', view_count: 5000 }));
fs.writeFileSync(path.join(dir, 'video.en.vtt'), 'WEBVTT\\n\\n00:00:00.000 --> 00:00:02.000\\nStop making this mistake\\n\\n00:00:02.000 --> 00:00:04.000\\nProof it overnight\\n\\n00:00:04.000 --> 00:00:06.000\\nOrder yours today\\n');
`, { mode: 0o755 });
});
after(() => fs.rmSync(work, { recursive: true, force: true }));

const downloads = () => (fs.existsSync(path.join(work, 'downloads.log')) ? fs.readFileSync(path.join(work, 'downloads.log'), 'utf8').trim().split('\n').filter(Boolean).length : 0);

async function start(extra = {}) {
	const dataDir = tmpDir();
	const cfg = {
		port: 0, dataDir, fontsDir, mock: true, accentColor: '#C8F53A', schedulerIntervalMs: 60000, host: '127.0.0.1',
		openai: {}, anthropic: {}, watch: { ytdlpPath: ytdlp },
		instagram: { userId: '', accessToken: '', graphBaseUrl: '', graphVersion: 'v21.0', publicBaseUrl: '', pollIntervalMs: 10, pollTimeoutMs: 2000 },
		...extra,
	};
	const ctx = createApp(cfg, { log: { error() {}, log() {} } });
	const server = await new Promise((r) => { const s = ctx.app.listen(0, '127.0.0.1', () => r(s)); });
	const base = `http://127.0.0.1:${server.address().port}`;
	const call = async (method, p, body, headers = { 'Content-Type': 'application/json' }) => {
		const res = await fetch(base + p, { method, headers, body: Buffer.isBuffer(body) ? body : body ? JSON.stringify(body) : undefined });
		return { status: res.status, body: await res.json() };
	};
	const until = (id, states) => waitFor(async () => { const r = (await call('GET', `/api/runs/${id}`)).body; return states.includes(r.state) && r; }, { timeoutMs: 180000 });
	return { ctx, call, until, close: async () => { await new Promise((r) => server.close(r)); ctx.jobs.stop(); await ctx.store.flush(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test('a pasted link runs the whole chain to a reel ready for review', async () => {
	const s = await start();
	try {
		const brand = (await s.call('POST', '/api/brands', { name: 'Spoke & Chain', description: 'Bike repair shop', offer: 'Book a tune-up' })).body;
		assert.match((await s.call('POST', '/api/runs', { brandId: brand.id })).body.error, /Paste a reel link/);
		assert.match((await s.call('POST', '/api/runs', { url: 'not a link', brandId: brand.id })).body.error, /Copy the reel link/);
		assert.match((await s.call('POST', '/api/runs', { url: 'https://www.instagram.com/reel/abc/' })).body.error, /Pick your business/);
		assert.match((await s.call('POST', '/api/runs', { url: 'https://www.instagram.com/reel/abc/', brandId: brand.id, mode: 'exact' })).body.error, /own reel|rights/);

		const started = await s.call('POST', '/api/runs', { url: 'https://www.instagram.com/reel/abc/', brandId: brand.id });
		assert.equal(started.status, 201);
		assert.equal(started.body.state, 'working');
		assert.deepEqual(started.body.steps.map((x) => x.id), ['get', 'watch', 'listen', 'analyse', 'script', 'render', 'review']);
		assert.equal(started.body.steps[0].label, 'Download the reel');

		const done = await s.until(started.body.id, ['review', 'failed']);
		assert.equal(done.state, 'review', done.error);
		assert.deepEqual(done.steps.map((x) => x.state), ['done', 'done', 'done', 'done', 'done', 'done', 'active']);
		assert.equal(done.reel.status, 'ready');
		assert.equal(done.reel.plan.timing, 'exact');
		assert.deepEqual(done.reel.origin, { type: 'remake', mode: 'format', sourceId: started.body.id, label: '@bakerbob', run: true });
		assert.ok(done.reel.videoUrl);
		assert.equal(done.beats, 3);
		assert.equal(downloads(), 1);

		// The same link again: no second download, straight to writing a new reel.
		const again = await s.call('POST', '/api/runs', { url: 'https://www.instagram.com/reel/abc/', brandId: brand.id, mode: 'exact', rightsConfirmed: true });
		assert.equal(again.status, 201);
		const done2 = await s.until(again.body.id, ['review', 'failed']);
		assert.equal(done2.state, 'review', done2.error);
		assert.notEqual(done2.reel.id, done.reel.id);
		assert.deepEqual(done2.reel.plan.scenes.map((x) => x.voiceover), ['Stop making this mistake', 'Proof it overnight', 'Order yours today']);
		assert.equal(downloads(), 1, 'not downloaded again');

		const list = (await s.call('GET', '/api/runs')).body;
		assert.equal(list.length, 1, 'one run per reel source; the latest options win');
	} finally { await s.close(); }
});

test('an uploaded video takes the same path; auto-approve schedules it', async () => {
	const s = await start();
	try {
		const brand = (await s.call('POST', '/api/brands', { description: 'Bakery' })).body;
		const q = new URLSearchParams({ name: 'my reel.mp4', brandId: brand.id, autoApprove: '1', scheduledAt: '2030-01-02T18:00:00.000Z' });
		const up = await s.call('POST', `/api/runs/upload?${q}`, fs.readFileSync(video), { 'Content-Type': 'video/mp4' });
		assert.equal(up.status, 201);
		assert.equal(up.body.steps[0].label, 'Upload the video');
		assert.equal(up.body.steps[0].state, 'done');
		const done = await s.until(up.body.id, ['done', 'failed']);
		assert.equal(done.state, 'done', done.error);
		assert.equal(done.reel.status, 'approved');
		assert.equal(done.reel.scheduledAt, '2030-01-02T18:00:00.000Z');
		assert.equal(done.steps.at(-1).label, 'Approved and scheduled');
		assert.equal((await s.call('POST', `/api/runs/upload?brandId=${brand.id}`, Buffer.from('x'), { 'Content-Type': 'video/mp4' })).status, 400);
	} finally { await s.close(); }
});

test('a failed download says why, and Retry picks the run up again', async () => {
	const s = await start();
	try {
		const brand = (await s.call('POST', '/api/brands', { description: 'Bakery' })).body;
		const r = await s.call('POST', '/api/runs', { url: 'https://www.instagram.com/reel/private1/', brandId: brand.id });
		const failed = await s.until(r.body.id, ['failed']);
		assert.equal(failed.steps[0].state, 'failed');
		assert.match(failed.error, /YTDLP_COOKIES_FROM_BROWSER|upload the video/);
		const again = await s.call('POST', `/api/runs/${r.body.id}/retry`);
		assert.equal(again.status, 200);
		assert.equal((await s.until(r.body.id, ['failed'])).state, 'failed');
		assert.equal((await s.call('POST', '/api/runs/src_missing/retry')).status, 404);
	} finally { await s.close(); }
});

test('the AI chosen for a run does the analysis and the script; OpenAI still makes images and voice', async () => {
	const dir = tmpDir();
	const png = await samplePng(dir), mp3 = await sampleMp3(dir);
	const beats = [
		{ start: 0, end: 2, purpose: 'hook', shot: 'close_up', text_position: 'top', on_screen_text: 'Stop making this mistake', spoken: 'Stop making this mistake', visual: 'red' },
		{ start: 2, end: 4, purpose: 'point', shot: 'hands', text_position: 'top', on_screen_text: 'Proof it overnight', spoken: 'Proof it overnight', visual: 'blue' },
		{ start: 4, end: 6, purpose: 'cta', shot: 'wide', text_position: 'top', on_screen_text: 'Order today', spoken: 'Order yours today', visual: 'green' },
	];
	const breakdown = { topic: 'bread', summary: 's', format: 'text_on_screen', hook: { type: 'mistake_warning', seconds: 2, on_screen_text: 'Stop making this mistake', spoken: '', visual: '', why_it_works: '' }, beats, pacing: { notes: '' }, layout: { text_position: 'top', caption_style: '', framing: '', colors: '' }, audio: { voiceover: true, music: 'none', notes: '' }, cta: 'Order', why_it_works: ['x'], template: 't' };
	const reel = { title: 'Chain mistake', format: 'tips', hook: 'Stop oiling like this', scenes: beats.map((b) => ({ seconds: 2, visual: 'bike chain', on_screen_text: 'Stop oiling like this', voiceover: 'Wipe first.' })), caption: 'c', hashtags: ['bikes'], cta: 'Book', best_time: '17:00' };
	const claude = await fakeServer(({ body }) => ({ json: { content: [{ type: 'tool_use', id: 't', name: body.tool_choice.name, input: body.tool_choice.name === 'reel_breakdown' ? breakdown : reel }], stop_reason: 'tool_use' } }));
	const openai = await fakeServer(({ path: p }) => {
		if (p === '/v1/audio/transcriptions') return { json: { text: 'Stop making this mistake.', segments: [{ start: 0, end: 2, text: 'Stop making this mistake.' }], words: [] } };
		if (p === '/v1/images/generations') return { json: { data: [{ b64_json: png.toString('base64') }] } };
		if (p === '/v1/audio/speech') return { buffer: mp3, type: 'audio/mpeg' };
		return { status: 500, json: { error: { message: `OpenAI ${p} should not be called in this run` } } };
	});
	const s = await start({
		mock: false,
		openai: { apiKey: 'sk-test-aaaaaaaaaaaaaaaaaaaa', baseUrl: `${openai.url}/v1`, textModel: 'gpt-4o', imageModel: 'gpt-image-1', imageQuality: 'low', ttsModel: 'gpt-4o-mini-tts', ttsVoice: 'alloy', transcribeModel: 'whisper-1' },
		anthropic: { apiKey: 'sk-ant-test-aaaaaaaaaaaaaaaa', baseUrl: `${claude.url}/v1`, model: 'claude-opus-5-5' },
	});
	try {
		const brand = (await s.call('POST', '/api/brands', { name: 'Spoke & Chain', description: 'Bike repair' })).body;
		const r = await s.call('POST', '/api/runs', { url: 'https://www.instagram.com/reel/claude1/', brandId: brand.id, ai: 'anthropic' });
		assert.equal(r.body.aiName, 'Claude');
		const done = await s.until(r.body.id, ['review', 'failed']);
		assert.equal(done.state, 'review', done.error);
		assert.deepEqual(claude.calls.map((c) => c.body.tool_choice.name), ['reel_breakdown', 'reel'], 'Claude analysed and wrote');
		assert.ok(claude.calls[0].body.messages[0].content.some((x) => x.type === 'image'), 'Claude saw the frames');
		const oaPaths = openai.calls.map((c) => c.path);
		assert.ok(oaPaths.includes('/v1/audio/transcriptions'));
		assert.ok(oaPaths.includes('/v1/images/generations'));
		assert.ok(oaPaths.includes('/v1/audio/speech'));
		assert.ok(!oaPaths.includes('/v1/chat/completions'), 'OpenAI wrote nothing in a Claude run');
		assert.equal(done.reel.plan.title, 'Chain mistake');
	} finally { await s.close(); await claude.close(); await openai.close(); fs.rmSync(dir, { recursive: true, force: true }); }

	const s2 = await start({ mock: false, openai: { apiKey: 'sk-test-aaaaaaaaaaaaaaaaaaaa', baseUrl: 'http://127.0.0.1:9/v1', textModel: 'gpt-4o' }, anthropic: {} });
	try {
		const brand = (await s2.call('POST', '/api/brands', { description: 'Bakery' })).body;
		const r = await s2.call('POST', '/api/runs', { url: 'https://www.instagram.com/reel/x/', brandId: brand.id, ai: 'anthropic' });
		assert.equal(r.status, 400);
		assert.match(r.body.error, /Add a Claude key in Settings/);
	} finally { await s2.close(); }
});
