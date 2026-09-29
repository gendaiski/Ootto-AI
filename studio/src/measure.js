// Measuring a reel with ffmpeg: where the cuts are, key frames at known times, the speech track,
// and captions parsed into timed segments. Everything here is exact, no AI involved.
import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg } from './ffmpeg.js';

const r2 = (n) => Math.round(n * 100) / 100;

// Scene cuts (seconds) from ffmpeg's per-frame scene score on a downscaled copy. A frame is a cut
// when its score passes the threshold, or when it is a sharp spike (a third of the threshold and
// ten times the local median), which catches jump cuts between similar shots.
export async function detectCuts(file, threshold = 0.3) {
	const log = await ffmpeg(['-i', file, '-an', '-sn', '-vf', "scale=192:-2,select='gte(scene,0)',metadata=print:key=lavfi.scene_score", '-f', 'null', '-'], { full: true });
	const frames = [];
	let t = null;
	for (const line of log.split('\n')) {
		const pt = line.match(/pts_time:\s*([\d.]+)/);
		if (pt) { t = Number(pt[1]); continue; }
		const sc = line.match(/lavfi\.scene_score=([\d.]+)/);
		if (sc && t != null) { frames.push({ t, score: Number(sc[1]) }); t = null; }
	}
	const cuts = [];
	for (let i = 0; i < frames.length; i++) {
		const { t: at, score } = frames[i];
		let hit = score >= threshold;
		if (!hit && score >= threshold / 3) {
			const near = frames.filter((f, j) => j !== i && Math.abs(f.t - at) <= 1).map((f) => f.score).sort((x, y) => x - y);
			const median = near.length ? near[near.length >> 1] : 0;
			hit = score >= 10 * Math.max(median, 0.002);
		}
		if (!hit || at < 0.25 || (cuts.length && at - cuts.at(-1) < 0.3)) continue;
		cuts.push(r2(at));
	}
	return cuts;
}

// Which moments to grab: an even spread (denser for short reels) plus the first frame after each
// cut, capped at maxFrames.
export function frameTimes(duration, cuts, maxFrames = 40) {
	const d = Math.max(0.5, duration);
	const target = Math.min(maxFrames, d <= 15 ? 15 : d <= 30 ? 24 : d <= 60 ? 32 : 40);
	const cutShots = cuts.filter((c) => c + 0.15 < d - 0.05).map((c) => ({ t: c + 0.15, cut: true }));
	const evenCount = Math.max(1, target - Math.min(cutShots.length, Math.floor(target / 2)));
	const even = Array.from({ length: evenCount }, (_, i) => ({ t: ((i + 0.5) * d) / evenCount, cut: false }));
	const all = [{ t: 0.1, cut: true }, ...cutShots, ...even].sort((a, b) => a.t - b.t);
	const kept = [];
	for (const f of all) {
		const prev = kept.at(-1);
		if (prev && f.t - prev.t < 0.25) { if (f.cut && !prev.cut) kept[kept.length - 1] = f; continue; }
		kept.push(f);
	}
	let times = kept.map((f) => r2(Math.min(f.t, d - 0.05)));
	if (times.length > maxFrames) {
		const step = times.length / maxFrames;
		times = Array.from({ length: maxFrames }, (_, i) => times[Math.floor(i * step)]);
	}
	return times;
}

export async function extractFrames(file, dir, times, { width = 512, parallel = 4 } = {}) {
	const fdir = path.join(dir, 'frames');
	fs.rmSync(fdir, { recursive: true, force: true });
	fs.mkdirSync(fdir, { recursive: true });
	const out = new Array(times.length);
	const queue = times.map((t, i) => ({ t, i }));
	await Promise.all(Array.from({ length: parallel }, async () => {
		for (let job; (job = queue.shift()); ) {
			const name = `f${String(job.i).padStart(3, '0')}.jpg`;
			await ffmpeg(['-ss', job.t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', path.join(fdir, name)]).catch(() => {});
			if (fs.existsSync(path.join(fdir, name))) out[job.i] = { t: job.t, file: `frames/${name}` };
		}
	}));
	return out.filter(Boolean);
}

// Mono 16 kHz MP3: small enough for the transcription API even for long videos.
export async function extractAudio(file, outFile) {
	await ffmpeg(['-i', file, '-vn', '-sn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', outFile]);
	return fs.existsSync(outFile) && fs.statSync(outFile).size > 1000 ? outFile : null;
}

const toSec = (h, m, s, ms) => Number(h || 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;

// WebVTT or SRT -> [{start, end, text}]. Auto-captions that repeat the previous line are collapsed.
export function parseCaptions(raw) {
	const segs = [];
	const blocks = String(raw).replace(/\r/g, '').split(/\n\s*\n/);
	for (const b of blocks) {
		const lines = b.split('\n');
		const i = lines.findIndex((l) => l.includes('-->'));
		if (i < 0) continue;
		const m = lines[i].match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})/);
		if (!m) continue;
		const textLines = lines.slice(i + 1).map((l) => l.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim()).filter(Boolean);
		if (!textLines.length) continue;
		const prev = segs.at(-1);
		// Rolling captions show the previous line again above the new one: keep only what is new.
		let text = textLines.join(' ');
		if (prev && textLines.length > 1 && textLines[0] === prev.last) text = textLines.slice(1).join(' ');
		const seg = { start: r2(toSec(m[1], m[2], m[3], m[4])), end: r2(toSec(m[5], m[6], m[7], m[8])), text, last: textLines.at(-1) };
		if (prev && prev.text === seg.text) { prev.end = seg.end; continue; }
		segs.push(seg);
	}
	return segs.map(({ start, end, text }) => ({ start, end, text }));
}

export function transcriptFromSegments(segments, source) {
	return { source, language: null, text: segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim(), segments, words: [] };
}

// The words spoken between two times, from segments (or words when available).
export function spokenBetween(transcript, start, end) {
	const items = transcript?.words?.length ? transcript.words.map((w) => ({ start: w.start, end: w.end, text: w.word })) : transcript?.segments || [];
	return items
		.filter((s) => { const mid = (s.start + s.end) / 2; return mid >= start && mid < end; })
		.map((s) => s.text.trim()).join(' ').replace(/\s+/g, ' ').trim();
}
