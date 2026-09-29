// Thin wrappers around the bundled ffmpeg binary.
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

export const FFMPEG = process.env.FFMPEG_PATH || ffmpegPath;

export function ffmpeg(args, { timeoutMs = 10 * 60 * 1000 } = {}) {
	return new Promise((resolve, reject) => {
		const p = spawn(FFMPEG, ['-hide_banner', '-nostdin', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
		let err = '';
		p.stderr.on('data', (d) => { err = (err + d).slice(-8000); });
		const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
		p.on('error', (e) => { clearTimeout(t); reject(e); });
		p.on('close', (code) => {
			clearTimeout(t);
			code === 0 ? resolve(err) : reject(new Error(`ffmpeg exited ${code}: ${err.split('\n').slice(-6).join(' ').trim()}`));
		});
	});
}

// Media info without ffprobe: parse `ffmpeg -i` output.
export async function probe(file) {
	const out = await new Promise((resolve) => {
		const p = spawn(FFMPEG, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
		let s = '';
		p.stderr.on('data', (d) => (s += d));
		p.on('close', () => resolve(s));
	});
	const d = out.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
	const v = out.match(/Stream #.*Video: ([^,\s]+).*?, (\d{2,5})x(\d{2,5})/);
	const fps = out.match(/, (\d+(?:\.\d+)?) fps/);
	return {
		duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
		video: v ? { codec: v[1], width: Number(v[2]), height: Number(v[3]), fps: fps ? Number(fps[1]) : null } : null,
		audio: /Stream #.*Audio: (\w+)/.test(out) ? out.match(/Stream #.*Audio: (\w+)/)[1] : null,
	};
}
