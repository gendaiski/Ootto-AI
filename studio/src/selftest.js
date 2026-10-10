// System check: proves each part the studio depends on actually works on this machine, and says
// what to fix when something does not. Used by Settings → System check and `npm run check`.
// Nothing here spends credits: key checks only list models, Instagram only reads the account name.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ffmpeg, probe } from './ffmpeg.js';
import { downloaderVersion } from './fetchvideo.js';
import { OpenAIClient } from './openai.js';
import { AnthropicClient } from './anthropic.js';

const ok = (id, label, detail) => ({ id, label, status: 'ok', detail });
const warn = (id, label, detail) => ({ id, label, status: 'warn', detail });
const fail = (id, label, detail) => ({ id, label, status: 'fail', detail });
const skip = (id, label, detail) => ({ id, label, status: 'skip', detail });

async function timed(fn) {
	try { return await fn(); } catch (e) { return e; }
}

// eff: the effective config (settings applied). Returns { ok, checks, at }.
export async function runSelfTest(eff, { fetchImpl = fetch } = {}) {
	const checks = [];

	const major = Number(process.versions.node.split('.')[0]);
	checks.push(major >= 20 ? ok('node', 'Node.js', `v${process.versions.node}`) : fail('node', 'Node.js', `v${process.versions.node}; version 20 or newer is required.`));

	// Data folder
	const probeFile = path.join(eff.dataDir, `.write-test-${process.pid}`);
	const w = await timed(async () => { fs.mkdirSync(eff.dataDir, { recursive: true }); fs.writeFileSync(probeFile, 'ok'); fs.rmSync(probeFile); });
	checks.push(w instanceof Error ? fail('data', 'Data folder', `Cannot write to ${eff.dataDir}: ${w.message}`) : ok('data', 'Data folder', `${eff.dataDir} is writable`));

	// ffmpeg: a one-second vertical clip with a burned-in caption, H.264 + AAC, like a real render.
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ootto-check-'));
	const r = await timed(async () => {
		const ass = path.join(tmp, 't.ass');
		fs.writeFileSync(ass, '[Script Info]\nScriptType: v4.00+\nPlayResX: 360\nPlayResY: 640\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: C,DejaVu Sans,40,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,0,2,20,20,40,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,C,,0,0,0,,System check\n');
		const out = path.join(tmp, 'check.mp4');
		await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x223344:s=360x640:r=30:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
			'-vf', `ass=${ass}:fontsdir=${eff.fontsDir}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out], { timeoutMs: 60_000 });
		return probe(out);
	});
	fs.rmSync(tmp, { recursive: true, force: true });
	checks.push(r instanceof Error || r.video?.codec !== 'h264' || r.audio !== 'aac'
		? fail('ffmpeg', 'Video rendering (ffmpeg)', `Test render failed: ${r instanceof Error ? r.message : 'wrong output format'}. Run npm ci again to reinstall ffmpeg-static.`)
		: ok('ffmpeg', 'Video rendering (ffmpeg)', 'Rendered a test clip with captions (H.264 + AAC)'));

	// yt-dlp (optional)
	const v = await downloaderVersion(eff.watch);
	checks.push(v ? ok('ytdlp', 'Reel downloads (yt-dlp)', `yt-dlp ${v}`) : warn('ytdlp', 'Reel downloads (yt-dlp)', 'Not installed. Reel links cannot be downloaded (uploads still work). Install with: pip install yt-dlp'));

	// AI keys
	const keyCheck = async (id, label, key, make) => {
		if (!key) return skip(id, label, 'No key set. Add one in Settings.');
		const res = await timed(() => make().check());
		return res instanceof Error ? fail(id, label, res.message) : ok(id, label, `Key works${res.length ? ` (models include ${res[0]})` : ''}`);
	};
	const [oa, cl] = await Promise.all([
		keyCheck('openai', 'OpenAI key', eff.openai?.apiKey, () => new OpenAIClient(eff.openai)),
		keyCheck('anthropic', 'Claude key', eff.anthropic?.apiKey, () => new AnthropicClient({ ...eff.anthropic, timeoutMs: 20_000 })),
	]);
	checks.push(oa, cl);
	if (oa.status !== 'ok' && cl.status !== 'ok') {
		checks.push(warn('ai', 'AI content', 'No working key: the studio runs in mock mode (template scripts, placeholder images, silent voice).'));
	} else if (oa.status !== 'ok') {
		checks.push(warn('ai', 'AI content', 'Claude only: scripts and analysis work; images are text cards and there is no voiceover. Add an OpenAI key for AI images and voice.'));
	} else {
		checks.push(ok('ai', 'AI content', cl.status === 'ok' ? 'OpenAI and Claude both available' : 'OpenAI: scripts, images, voice and transcription'));
	}

	// Instagram (optional)
	const ig = eff.instagram || {};
	if (!ig.userId || !ig.accessToken) {
		checks.push(skip('instagram', 'Instagram account', 'Not connected. Reels can be downloaded and posted by hand.'));
	} else {
		const res = await timed(async () => {
			const u = `${ig.graphBaseUrl}/${ig.graphVersion}/${ig.userId}?${new URLSearchParams({ fields: 'username', access_token: ig.accessToken })}`;
			const resp = await fetchImpl(u, { signal: AbortSignal.timeout(20_000) });
			const data = await resp.json().catch(() => ({}));
			if (!resp.ok || data.error) throw new Error(data.error?.message || `HTTP ${resp.status}`);
			return data;
		});
		checks.push(res instanceof Error ? fail('instagram', 'Instagram account', `Token or account id rejected: ${res.message}`) : ok('instagram', 'Instagram account', `Connected as @${res.username || ig.userId}`));
	}
	if (ig.publicBaseUrl) {
		if (!/^https:\/\//.test(ig.publicBaseUrl)) {
			checks.push(fail('public', 'Public address', `${ig.publicBaseUrl} must start with https:// for Instagram to download videos.`));
		} else {
			const res = await timed(async () => (await fetchImpl(`${ig.publicBaseUrl}/api/status`, { signal: AbortSignal.timeout(15_000) })).status);
			checks.push(res instanceof Error || ![200, 401].includes(res)
				? fail('public', 'Public address', `${ig.publicBaseUrl} did not reach this studio (${res instanceof Error ? res.message : `HTTP ${res}`}). Is the tunnel running?`)
				: ok('public', 'Public address', `${ig.publicBaseUrl} reaches this studio`));
		}
	}

	// Safety
	if ((ig.publicBaseUrl || (eff.host && eff.host !== '127.0.0.1' && eff.host !== 'localhost')) && !eff.password) {
		checks.push(warn('password', 'Password', 'The studio can be reached from outside this computer but has no STUDIO_PASSWORD. Anyone with the address could use your keys.'));
	} else {
		checks.push(ok('password', 'Access', eff.password ? 'Protected with STUDIO_PASSWORD' : 'Only reachable from this computer'));
	}

	return { ok: !checks.some((c) => c.status === 'fail'), checks, at: new Date().toISOString() };
}
