// Watch & remake: measuring a real video with ffmpeg, a stand-in yt-dlp, the OpenAI vision and
// transcription requests, remakes with exact timing, and patterns across reels.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, waitFor, fakeServer } from './helpers.js';
import { ffmpeg, probe } from '../src/ffmpeg.js';
import { detectCuts, frameTimes, extractFrames, extractAudio, parseCaptions } from '../src/measure.js';
import { normalizeBreakdown } from '../src/analyze.js';
import { createProvider } from '../src/providers.js';
import { watchSource } from '../src/watch.js';
import { remakePlan, compactBeats } from '../src/remake.js';
import { renderReel } from '../src/render.js';
import { createApp } from '../src/server.js';
import { ROOT } from '../src/config.js';

let work, video, fakeYtdlp;
const fontsDir = path.join(ROOT, 'assets', 'fonts');

// A 6-second vertical clip: red, blue, green (2 s each) over a tone, so there are cuts at 2 s and 4 s.
before(async () => {
	work = tmpDir('ootto-watch-');
	video = path.join(work, 'fixture.mp4');
	await ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=360x640:r=30:d=2', '-f', 'lavfi', '-i', 'color=c=blue:s=360x640:r=30:d=2', '-f', 'lavfi', '-i', 'color=c=green:s=360x640:r=30:d=2',
		'-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100:duration=6',
		'-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-map', '3:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
	// Stand-in for yt-dlp: copies the fixture, writes info JSON and English captions, logs its arguments.
	fakeYtdlp = path.join(work, 'fake-yt-dlp.mjs');
	fs.writeFileSync(fakeYtdlp, `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('2099.01.01'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(path.join(work, 'ytdlp-args.log'))}, JSON.stringify(a) + '\\n');
const url = a.at(-1), dir = path.dirname(a[a.indexOf('-o') + 1]);
if (url.includes('private')) { console.error('ERROR: [Instagram] xyz: Requested content is not available, rate-limit reached or login required'); process.exit(1); }
fs.copyFileSync(${JSON.stringify(video)}, path.join(dir, 'video.mp4'));
const n = url.includes('second') ? 2 : 1;
fs.writeFileSync(path.join(dir, 'video.info.json'), JSON.stringify({ webpage_url: url, extractor_key: 'Instagram', title: 'Video by bakerbob', uploader: 'bakerbob', description: 'Three bread mistakes\\n\\n#sourdough #baking', view_count: 120000 * n, like_count: 5400, upload_date: '20260901' }));
fs.writeFileSync(path.join(dir, 'video.en.vtt'), 'WEBVTT\\n\\n00:00:00.000 --> 00:00:02.000\\nStop making this mistake\\n\\n00:00:02.000 --> 00:00:04.000\\nProof it overnight\\n\\n00:00:04.000 --> 00:00:06.000\\nOrder yours today\\n');
`, { mode: 0o755 });
});
after(() => fs.rmSync(work, { recursive: true, force: true }));

test('measure: cuts, frame times, frames, audio and captions', async () => {
	const cuts = await detectCuts(video, 0.3);
	assert.equal(cuts.length, 2, `cuts ${cuts}`);
	assert.ok(Math.abs(cuts[0] - 2) < 0.1 && Math.abs(cuts[1] - 4) < 0.1, `cuts ${cuts}`);

	const times = frameTimes(6, cuts, 40);
	assert.equal(times[0], 0.1);
	assert.ok(times.some((t) => Math.abs(t - (cuts[0] + 0.15)) < 0.01), 'a frame right after each cut');
	assert.ok(times.length <= 15 && times.every((t, i) => i === 0 || t - times[i - 1] >= 0.25));
	assert.ok(frameTimes(300, [], 12).length <= 12, 'capped');

	const dir = path.join(work, 'measure');
	const frames = await extractFrames(video, dir, [0.1, 3, 5.5]);
	assert.deepEqual(frames.map((f) => f.file), ['frames/f000.jpg', 'frames/f001.jpg', 'frames/f002.jpg']);
	assert.equal((await probe(path.join(dir, frames[0].file))).video.width, 512);

	const audio = await extractAudio(video, path.join(dir, 'speech.mp3'));
	assert.ok(audio && (await probe(audio)).audio === 'mp3');

	assert.deepEqual(parseCaptions('1\n00:00:01,000 --> 00:00:02,500\nHello <i>there</i>\n\n2\n00:00:02,500 --> 00:00:04,000\nAgain\n'),
		[{ start: 1, end: 2.5, text: 'Hello there' }, { start: 2.5, end: 4, text: 'Again' }]);
	// Rolling auto-captions repeat the previous line; only the new words are kept.
	const rolling = parseCaptions('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nfirst line\n\n00:00:01.000 --> 00:00:02.000\nfirst line\nsecond line\n\n00:00:02.000 --> 00:00:02.500\nsecond line\n');
	assert.deepEqual(rolling.map((s) => s.text), ['first line', 'second line']);
});

test('breakdown clean-up: sorted, no gaps, measured pacing; long reels are compacted', () => {
	const b = normalizeBreakdown({
		format: 'nope', hook: { type: 'question', seconds: 2 },
		beats: [
			{ start: 3, end: 5, purpose: 'cta', shot: 'wide', text_position: 'bottom', on_screen_text: 'Order', spoken: '', visual: '' },
			{ start: 0.2, end: 2.5, purpose: 'hook', shot: 'close_up', text_position: 'top', on_screen_text: 'Why?', spoken: '', visual: '' },
			{ start: 2.9, end: 2.95, purpose: 'point', shot: 'x', text_position: 'top', on_screen_text: '', spoken: '', visual: '' },
		],
		layout: {}, audio: {}, why_it_works: ['a'],
	}, { duration: 6, cuts: [3] });
	assert.equal(b.format, 'other');
	assert.deepEqual(b.beats.map((x) => [x.start, x.end]), [[0, 3], [3, 6]], 'gapless 0..duration, sliver folded in');
	assert.equal(b.pacing.beats, 2);
	assert.equal(b.pacing.avg_beat_seconds, 3);
	assert.equal(b.pacing.cuts_per_10s, 1.67);

	const many = Array.from({ length: 20 }, (_, i) => ({ start: i, end: i + 1, on_screen_text: `t${i}`, spoken: '', visual: '' }));
	const c = compactBeats(many, 12);
	assert.equal(c.length, 12);
	assert.equal(c[0].start, 0);
	assert.equal(c.at(-1).end, 20);
	assert.ok(c.every((x, i) => i === 0 || x.start === c[i - 1].end));
});

test('OpenAI: transcription and vision requests, then a format remake that keeps the rhythm', async () => {
	const beats = [
		{ start: 0, end: 2.1, purpose: 'hook', shot: 'close_up', text_position: 'top', on_screen_text: 'Stop making this mistake', spoken: 'Stop making this mistake', visual: 'Close-up of red dough' },
		{ start: 1.9, end: 4, purpose: 'point', shot: 'hands', text_position: 'top', on_screen_text: 'Proof it overnight', spoken: 'Proof it overnight', visual: 'Blue bowl' },
		{ start: 4, end: 6, purpose: 'cta', shot: 'wide', text_position: 'top', on_screen_text: 'Order today', spoken: 'Order yours today', visual: 'Green shopfront' },
	];
	const srv = await fakeServer(({ path: p, body }) => {
		if (p === '/v1/audio/transcriptions') {
			return { json: { language: 'english', text: 'Stop making this mistake. Proof it overnight. Order yours today.', segments: [{ start: 0, end: 2, text: ' Stop making this mistake.' }, { start: 2, end: 4, text: ' Proof it overnight.' }, { start: 4, end: 6, text: ' Order yours today.' }], words: [{ start: 0, end: 0.4, word: 'Stop' }] } };
		}
		const name = body.response_format.json_schema.name;
		if (name === 'reel_breakdown') {
			return { json: { choices: [{ message: { content: JSON.stringify({ topic: 'bread mistakes', summary: 's', format: 'text_on_screen', hook: { type: 'mistake_warning', seconds: 2, on_screen_text: 'Stop making this mistake', spoken: 'Stop making this mistake', visual: 'red', why_it_works: 'warns' }, beats, pacing: { notes: 'even' }, layout: { text_position: 'top', caption_style: 'white box', framing: 'close', colors: 'bold' }, audio: { voiceover: true, music: 'none', notes: '' }, cta: 'Order today', why_it_works: ['clear'], template: 'Stop [mistake] / [fix] / [cta]' }) } }] } };
		}
		if (name === 'reel') {
			return { json: { choices: [{ message: { content: JSON.stringify({ title: 'Bike chain mistake', format: 'tips', hook: 'Stop oiling your chain like this', scenes: [
				{ seconds: 3, visual: 'Close-up of a bike chain', on_screen_text: 'Stop oiling your chain like this', voiceover: 'Stop oiling your chain like this.' },
				{ seconds: 3, visual: 'Hands wiping a chain', on_screen_text: 'Wipe first', voiceover: 'Wipe it first.' },
				{ seconds: 3, visual: 'Wide shot of the shop', on_screen_text: 'Book a tune-up', voiceover: 'Book a tune-up.' },
			], caption: 'Chain care.', hashtags: ['bikes'], cta: 'Book a tune-up', best_time: '17:00' }) } }] } };
		}
		return { status: 404, json: { error: { message: 'unexpected' } } };
	});
	try {
		const cfg = { mock: false, fontsDir, accentColor: '#C8F53A', watch: { maxSeconds: 600, maxFrames: 40, sceneThreshold: 0.3, uploadLimitMb: 50 },
			openai: { apiKey: 'sk-test', baseUrl: `${srv.url}/v1`, textModel: 'gpt-4o', visionModel: 'gpt-4o-vision-test', transcribeModel: 'whisper-1', imageModel: 'gpt-image-1', imageQuality: 'low', ttsModel: 'gpt-4o-mini-tts', ttsVoice: 'alloy' } };
		const provider = createProvider(cfg);
		const dir = path.join(work, 'openai-src');
		fs.mkdirSync(dir, { recursive: true });
		fs.copyFileSync(video, path.join(dir, 'video.mp4'));
		const result = await watchSource({ source: { id: 'src_x', file: 'video.mp4' }, dir, provider, cfg });

		const tr = srv.calls.find((c) => c.path === '/v1/audio/transcriptions');
		assert.match(tr.headers['content-type'], /multipart\/form-data/);
		assert.match(tr.body, /name="model"\r\n\r\nwhisper-1/);
		assert.match(tr.body, /verbose_json/);
		assert.match(tr.body, /timestamp_granularities\[\]/);
		assert.equal(result.transcript.source, 'openai');
		assert.equal(result.transcript.segments.length, 3);

		const chat = srv.calls.find((c) => c.path === '/v1/chat/completions');
		assert.equal(chat.body.model, 'gpt-4o-vision-test');
		const parts = chat.body.messages[1].content;
		assert.ok(Array.isArray(parts));
		const images = parts.filter((x) => x.type === 'image_url');
		assert.equal(images.length, result.frames.length);
		assert.match(images[0].image_url.url, /^data:image\/jpeg;base64,/);
		assert.equal(images[0].image_url.detail, 'low');
		assert.match(parts[0].text, /Measured cuts at: 2\.\d\ds, 4\.\d\ds/);
		assert.match(parts[0].text, /Proof it overnight/);

		const b = result.breakdown;
		assert.equal(b.hook.type, 'mistake_warning');
		assert.deepEqual(b.beats.map((x) => x.start), [0, 1.9, 4], 'overlap trimmed');
		assert.equal(b.beats.at(-1).end, 6);

		const plan = await remakePlan(provider, { name: 'Spoke & Chain', description: 'Bike repair shop', language: 'English' }, { breakdown: b });
		assert.equal(plan.timing, 'exact');
		assert.deepEqual(plan.scenes.map((x) => x.seconds), [1.9, 2.1, 2], 'scene lengths follow the original beats');
		assert.deepEqual(plan.layout, { text_position: 'top' });
		const ask = srv.calls.at(-1).body.messages;
		assert.match(ask[0].content, /Do not reuse the original's sentences/);
		assert.match(ask[1].content, /exactly 3 scenes/);
		assert.match(ask[1].content, /Spoke & Chain/);
	} finally { await srv.close(); }
});

test('render: exact timing holds scene lengths and speeds up long lines', async () => {
	const provider = createProvider({ mock: true });
	const dir = path.join(work, 'exact-render');
	const plan = {
		title: 'x', format: 'remake', hook: 'Hi', timing: 'exact', layout: { text_position: 'bottom' },
		scenes: [
			{ seconds: 1.5, visual: 'a', on_screen_text: 'Hi', voiceover: 'Hi there' },
			{ seconds: 2.5, visual: 'b', on_screen_text: 'Long', voiceover: 'one two three four five six seven eight nine ten' },
		],
		caption: '', hashtags: [], cta: '', best_time: '18:00',
	};
	const media = await renderReel({ plan, dir, provider, cfg: { fontsDir, accentColor: '#C8F53A' } });
	assert.equal(media.scenes[0].duration, 1.5, 'short line: the slot length is kept');
	// 10 words of mock voice = 4.15 s; at the 1.3x cap that is 3.19 s, so the slot grows to 3.29 s.
	assert.ok(Math.abs(media.scenes[1].duration - 3.29) < 0.03, `scene 2 ${media.scenes[1].duration}`);
	assert.ok(Math.abs(media.duration - 4.79) < 0.15, `total ${media.duration}`);
});

// ---------- through the HTTP API in mock mode ----------
async function start(dataDir, watch) {
	const cfg = {
		port: 0, dataDir, fontsDir, mock: true, accentColor: '#C8F53A', schedulerIntervalMs: 60000, watch,
		openai: {}, instagram: { userId: '', accessToken: '', graphBaseUrl: '', graphVersion: 'v21.0', publicBaseUrl: '', pollIntervalMs: 10, pollTimeoutMs: 2000 },
	};
	const ctx = createApp(cfg, { log: { error() {}, log() {} } });
	const server = await new Promise((r) => { const s = ctx.app.listen(0, '127.0.0.1', () => r(s)); });
	const base = `http://127.0.0.1:${server.address().port}`;
	const call = async (method, p, body, headers = { 'Content-Type': 'application/json' }) => {
		const res = await fetch(base + p, { method, headers, body: Buffer.isBuffer(body) ? body : body ? JSON.stringify(body) : undefined });
		return { status: res.status, body: await res.json() };
	};
	return { ctx, call, close: async () => { await new Promise((r) => server.close(r)); ctx.jobs.stop(); await ctx.store.flush(); } };
}

test('API: watch links and uploads, remake (format and exact), patterns, plan from patterns', async () => {
	const dir = tmpDir();
	const s = await start(dir, { ytdlpPath: fakeYtdlp, cookiesFromBrowser: 'chrome' });
	const ready = (id) => waitFor(async () => { const r = (await s.call('GET', `/api/sources/${id}`)).body; return ['ready', 'failed'].includes(r.status) && r; });
	try {
		const status = (await s.call('GET', '/api/status')).body;
		assert.equal(status.watch.downloader, '2099.01.01');

		assert.equal((await s.call('POST', '/api/sources', { urls: [] })).status, 400);
		assert.equal((await s.call('POST', '/api/sources', { urls: ['javascript:alert(1)'] })).status, 400);
		const add = await s.call('POST', '/api/sources', { urls: ['https://www.instagram.com/reel/first/', 'https://www.instagram.com/reel/second/ https://www.instagram.com/reel/private/'] });
		assert.equal(add.status, 201);
		assert.equal(add.body.added.length, 3);
		const again = await s.call('POST', '/api/sources', { url: 'https://www.instagram.com/reel/first/' });
		assert.equal(again.body.skipped, 1, 'the same link is not watched twice');

		const [first, second, priv] = add.body.added;
		const a = await ready(first.id);
		assert.equal(a.status, 'ready', a.error);
		assert.equal(a.meta.uploader, 'bakerbob');
		assert.equal(a.meta.views, 120000);
		assert.equal(a.transcript.source, 'captions');
		assert.equal(a.breakdown.beats.length, 3, 'beats follow the measured cuts');
		assert.deepEqual(a.breakdown.beats.map((x) => x.spoken), ['Stop making this mistake', 'Proof it overnight', 'Order yours today']);
		assert.ok(a.videoUrl && a.thumbUrl && a.frames[0].url.startsWith(`/media/${a.id}/frames/`));
		const args = JSON.parse(fs.readFileSync(path.join(work, 'ytdlp-args.log'), 'utf8').split('\n')[0]);
		assert.equal(args.at(-2), '--', 'the link is passed after --');
		assert.ok(args.includes('--cookies-from-browser') && args.includes('chrome'));
		assert.ok(args.includes('--ffmpeg-location'));

		const p = await ready(priv.id);
		assert.equal(p.status, 'failed');
		assert.match(p.error, /login.*YTDLP_COOKIES_FROM_BROWSER|YTDLP_COOKIES_FROM_BROWSER/s);
		await ready(second.id);

		const up = await s.call('POST', '/api/sources/upload?name=My%20reel.mov', fs.readFileSync(video), { 'Content-Type': 'video/quicktime' });
		assert.equal(up.status, 201);
		const u = await ready(up.body.id);
		assert.equal(u.status, 'ready', u.error);
		assert.equal(u.file, 'video.mov');
		assert.equal(u.meta.title, 'My reel');

		const brand = (await s.call('POST', '/api/brands', { name: 'Spoke & Chain', description: 'Bike repair shop', offer: 'Book a tune-up' })).body;
		assert.equal((await s.call('POST', `/api/sources/${a.id}/remake`, { brandId: 'nope' })).status, 400);
		const fmt = await s.call('POST', `/api/sources/${a.id}/remake`, { brandId: brand.id, mode: 'format' });
		assert.equal(fmt.status, 201);
		assert.deepEqual(fmt.body.origin, { type: 'remake', mode: 'format', sourceId: a.id, label: '@bakerbob' });
		assert.equal(fmt.body.plan.scenes.length, 3);

		const noRights = await s.call('POST', `/api/sources/${a.id}/remake`, { brandId: brand.id, mode: 'exact' });
		assert.equal(noRights.status, 400);
		assert.match(noRights.body.error, /own reel|rights/);
		const exact = await s.call('POST', `/api/sources/${a.id}/remake`, { brandId: brand.id, mode: 'exact', rightsConfirmed: true });
		assert.equal(exact.status, 201);
		assert.deepEqual(exact.body.plan.scenes.map((x) => x.voiceover), ['Stop making this mistake', 'Proof it overnight', 'Order yours today']);
		assert.deepEqual(exact.body.plan.hashtags, ['sourdough', 'baking']);
		assert.equal(exact.body.plan.caption, 'Three bread mistakes');

		const rendered = await waitFor(async () => { const r = (await s.call('GET', `/api/reels/${fmt.body.id}`)).body; return r.status === 'ready' && r; });
		assert.ok(Math.abs(rendered.media.duration - 6) < 0.4, `remake keeps the 6 s rhythm (${rendered.media.duration})`);

		assert.equal((await s.call('POST', '/api/patterns', { sourceIds: [a.id] })).status, 400, 'needs two reels');
		const pat = await s.call('POST', '/api/patterns', { sourceIds: [a.id, second.id, u.id] });
		assert.equal(pat.status, 201);
		assert.equal(pat.body.profile.measured.reels, 3);
		assert.equal(pat.body.profile.measured.avg_seconds, 6);
		assert.equal(pat.body.profile.measured.total_views, 360000);
		const week = await s.call('POST', `/api/brands/${brand.id}/week`, { count: 2, startDate: '2026-10-05', profileId: pat.body.id });
		assert.equal(week.status, 201);
		assert.equal(week.body[0].origin.type, 'patterns');
		assert.equal((await s.call('POST', `/api/brands/${brand.id}/week`, { count: 1, profileId: 'pat_missing' })).status, 404);

		assert.equal((await s.call('DELETE', `/api/sources/${u.id}`)).status, 200);
		assert.equal((await s.call('GET', `/api/sources/${u.id}`)).status, 404);
		assert.ok(!fs.existsSync(path.join(dir, 'media', u.id)));
		assert.equal((await s.call('DELETE', `/api/patterns/${pat.body.id}`)).status, 200);
		await waitFor(async () => (await s.call('GET', `/api/reels?brandId=${brand.id}`)).body.every((r) => r.status === 'ready'));
	} finally {
		await s.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('API: a missing yt-dlp gives a clear message', async () => {
	const dir = tmpDir();
	const s = await start(dir, { ytdlpPath: path.join(work, 'no-such-yt-dlp') });
	try {
		assert.equal((await s.call('GET', '/api/status')).body.watch.downloader, null);
		const add = await s.call('POST', '/api/sources', { url: 'https://www.instagram.com/reel/abc/' });
		const r = await waitFor(async () => { const x = (await s.call('GET', `/api/sources/${add.body.added[0].id}`)).body; return x.status === 'failed' && x; });
		assert.match(r.error, /yt-dlp is not installed.*upload the video file/);
		const sources = (await s.call('GET', '/api/sources')).body;
		assert.equal(sources.length, 1);
	} finally {
		await s.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
