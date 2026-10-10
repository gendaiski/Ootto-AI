// Getting a reel onto disk: yt-dlp for links (Instagram, TikTok, YouTube Shorts and the rest of
// its supported sites), or a file the user uploads.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { FFMPEG } from './ffmpeg.js';

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);

export function isHttpUrl(s) {
	try { return /^https?:$/.test(new URL(String(s).trim()).protocol); } catch { return false; }
}

function run(bin, args, { timeoutMs = 10 * 60 * 1000 } = {}) {
	return new Promise((resolve, reject) => {
		const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '', err = '';
		p.stdout.on('data', (d) => { out = (out + d).slice(-20000); });
		p.stderr.on('data', (d) => { err = (err + d).slice(-20000); });
		const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
		p.on('error', (e) => { clearTimeout(t); reject(e); });
		p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
	});
}

// The installed yt-dlp version, or null when it is missing. Cached per binary path.
const versions = new Map();
export function downloaderVersion(w) {
	if (!versions.has(w.ytdlpPath)) {
		versions.set(w.ytdlpPath, run(w.ytdlpPath, ['--version'], { timeoutMs: 15000 })
			.then((r) => (r.code === 0 ? r.out.trim().split('\n')[0] : null))
			.catch(() => null));
	}
	return versions.get(w.ytdlpPath);
}

function explain(stderr) {
	const last = stderr.split('\n').filter((l) => /ERROR|error/i.test(l)).pop() || stderr.trim().split('\n').pop() || 'unknown error';
	const msg = last.replace(/^.*?ERROR:\s*/, '').slice(0, 300);
	if (/login|log in|cookies|private|rate.?limit|not available|401|403/i.test(stderr)) {
		return `${msg}. The site asked for a login or blocked the download. Set YTDLP_COOKIES_FROM_BROWSER (for example chrome) or YTDLP_COOKIES in .env, or upload the video file instead.`;
	}
	return msg;
}

export async function downloadVideo(url, dir, w) {
	if (!isHttpUrl(url)) throw new Error('That link is not a valid http(s) address.');
	if (!(await downloaderVersion(w))) {
		throw new Error('yt-dlp is not installed, so links cannot be downloaded. Install it (pip install yt-dlp, or brew install yt-dlp) or upload the video file instead.');
	}
	fs.mkdirSync(dir, { recursive: true });
	for (const f of fs.readdirSync(dir)) if (f.startsWith('video.')) fs.rmSync(path.join(dir, f), { force: true });
	const args = [
		'--no-playlist', '--no-progress', '--no-warnings',
		'-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b', '--merge-output-format', 'mp4',
		'--ffmpeg-location', FFMPEG,
		'--write-info-json', '--write-subs', '--write-auto-subs', '--sub-langs', w.subLangs, '--sub-format', 'vtt/srt/best',
		'--match-filter', `!is_live & duration <=? ${w.maxSeconds}`, '--max-filesize', `${w.uploadLimitMb}M`,
		'-o', path.join(dir, 'video.%(ext)s'),
	];
	if (w.cookiesFile) args.push('--cookies', w.cookiesFile);
	if (w.cookiesFromBrowser) args.push('--cookies-from-browser', w.cookiesFromBrowser);
	args.push('--', String(url).trim());

	const r = await run(w.ytdlpPath, args);
	if (r.code !== 0) throw new Error(`Download failed: ${explain(r.err)}`);
	const files = fs.readdirSync(dir);
	const video = files.find((f) => f.startsWith('video.') && VIDEO_EXT.has(path.extname(f).toLowerCase()) && !f.includes('.f'));
	if (!video) throw new Error(`Download produced no video. It may be a live stream, a photo post, or longer than ${w.maxSeconds} seconds (WATCH_MAX_SECONDS).`);
	let info = {};
	try { info = JSON.parse(fs.readFileSync(path.join(dir, 'video.info.json'), 'utf8')); } catch {}
	return { file: video, meta: pickMeta(info, url), captions: findCaptions(dir) };
}

export function findCaptions(dir) {
	return fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => f.startsWith('video.') && /\.(vtt|srt)$/i.test(f)) || null : null;
}

export function pickMeta(info, url) {
	const num = (v) => (Number.isFinite(v) ? v : null);
	return {
		url: info.webpage_url || url || null,
		platform: info.extractor_key || info.extractor || null,
		title: String(info.title || '').slice(0, 200) || null,
		uploader: info.uploader || info.channel || info.uploader_id || null,
		caption: String(info.description || '').slice(0, 2200) || null,
		views: num(info.view_count), likes: num(info.like_count), comments: num(info.comment_count),
		uploadDate: /^\d{8}$/.test(info.upload_date || '') ? `${info.upload_date.slice(0, 4)}-${info.upload_date.slice(4, 6)}-${info.upload_date.slice(6)}` : null,
	};
}

// An uploaded file keeps only a safe extension; the name the user gave is kept as the title.
export function uploadTarget(name) {
	const ext = path.extname(String(name || '')).toLowerCase();
	return `video${VIDEO_EXT.has(ext) ? ext : '.mp4'}`;
}
