// Renders a reel plan into a 1080x1920 H.264/AAC MP4:
// per-scene image + voiceover -> Ken Burns clip sized to the voice line -> concat ->
// burned-in headline and word-highlighted captions (libass) -> thumbnail.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ffmpeg, probe } from './ffmpeg.js';

const W = 1080, H = 1920, FPS = 30;
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

export function assEscape(s) {
	return String(s).replace(/\\/g, '\u2216').replace(/[{}]/g, '').replace(/\r?\n/g, '\\N');
}

// "#C8F53A" -> "&H003AF5C8" (ASS colours are &HAABBGGRR)
export function assColor(hex, alpha = 0) {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex) || [, 'C8F53A'];
	const [r, g, b] = [m[1].slice(0, 2), m[1].slice(2, 4), m[1].slice(4, 6)];
	return `&H${alpha.toString(16).padStart(2, '0')}${b}${g}${r}`.toUpperCase();
}

const ts = (t) => {
	const cs = Math.max(0, Math.round(t * 100));
	const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), s = Math.floor((cs % 6000) / 100);
	return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

// Build the subtitle script: one boxed headline per scene, captions in 3-5 word chunks with the
// spoken word highlighted in the accent colour.
export function buildAss(timeline, { accent = '#C8F53A' } = {}) {
	const lines = [
		'[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
		'[V4+ Styles]',
		'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
		`Style: Headline,DejaVu Sans,86,&H00FFFFFF,&H00FFFFFF,&H3A000000,&H00000000,-1,0,0,0,100,100,0,0,3,26,0,8,110,110,250,1`,
		`Style: Caption,DejaVu Sans,60,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,6,3,2,110,110,470,1`,
		'', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
	];
	const hi = assColor(accent);
	for (const sc of timeline) {
		if (sc.onScreenText) {
			lines.push(`Dialogue: 1,${ts(sc.start)},${ts(sc.end - 0.05)},Headline,,0,0,0,,{\\fad(180,120)}${assEscape(sc.onScreenText)}`);
		}
		const words = (sc.voiceover || '').split(/\s+/).filter(Boolean);
		if (!words.length) continue;
		const speechEnd = sc.start + Math.max(0.6, Math.min(sc.voiceDuration || sc.duration, sc.duration) - 0.1);
		const t0 = sc.start + 0.08;
		const weights = words.map((w) => Math.max(2, w.replace(/[^\p{L}\p{N}]/gu, '').length) + 1.5);
		const total = weights.reduce((a, b) => a + b, 0);
		let acc = 0;
		const times = weights.map((w) => { const s = t0 + ((speechEnd - t0) * acc) / total; acc += w; return [s, t0 + ((speechEnd - t0) * acc) / total]; });
		const chunkSize = words.length <= 5 ? words.length : 4;
		for (let c = 0; c < words.length; c += chunkSize) {
			const chunk = words.slice(c, c + chunkSize);
			chunk.forEach((_, j) => {
				const k = c + j;
				const text = chunk.map((w, n) => (n === j ? `{\\c${hi}}${assEscape(w)}{\\c&H00FFFFFF&}` : assEscape(w))).join(' ');
				const end = j === chunk.length - 1 ? Math.min(times[k][1] + 0.12, sc.end - 0.02) : times[k + 1][0];
				lines.push(`Dialogue: 0,${ts(times[k][0])},${ts(end)},Caption,,0,0,0,,${text}`);
			});
		}
	}
	return lines.join('\n') + '\n';
}

const MOTIONS = [
	(n) => ({ z: `1+0.14*on/${n}`, x: 'iw/2-(iw/zoom/2)', y: 'ih/2-(ih/zoom/2)' }), // push in
	(n) => ({ z: `1.14-0.14*on/${n}`, x: 'iw/2-(iw/zoom/2)', y: 'ih/2-(ih/zoom/2)' }), // pull out
	(n) => ({ z: '1.14', x: `(iw-iw/zoom)*on/${n}`, y: 'ih/2-(ih/zoom/2)' }), // pan right
	(n) => ({ z: '1.14', x: 'iw/2-(iw/zoom/2)', y: `(ih-ih/zoom)*(1-on/${n})` }), // pan up
];

export async function renderReel({ plan, dir, provider, cfg, force = false, onProgress = () => {} }) {
	fs.mkdirSync(dir, { recursive: true });
	const manifestFile = path.join(dir, 'assets.json');
	const assets = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : {};
	const brandStyle = cfg.visualStyle || 'natural light, realistic photography, modern and clean';
	const timeline = [];
	let t = 0;

	for (const [i, sc] of plan.scenes.entries()) {
		const n = plan.scenes.length;
		const imgKey = `img-${hash(sc.visual + '|' + brandStyle + '|' + provider.name)}`;
		const voiceKey = `voice-${hash(sc.voiceover + '|' + provider.name + '|' + (provider.models?.voice || ''))}`;
		const img = path.join(dir, `${imgKey}.png`);
		const voice = path.join(dir, `${voiceKey}.mp3`);

		if (force || !fs.existsSync(img)) {
			onProgress(`Creating image ${i + 1} of ${n}`);
			await provider.image(`${sc.visual}. Vertical 9:16 composition, ${brandStyle}. No text, letters, logos, signs or watermarks anywhere in the image.`, img, { index: i, fontsDir: cfg.fontsDir });
		}
		if (sc.voiceover && (force || !fs.existsSync(voice))) {
			onProgress(`Recording voice ${i + 1} of ${n}`);
			await provider.speech(sc.voiceover, voice, { instructions: 'Upbeat, warm, confident social media narrator. Natural pace.' });
		}
		const voiceDuration = sc.voiceover && fs.existsSync(voice) ? (await probe(voice)).duration : 0;
		const duration = Math.min(15, Math.max(sc.seconds || 3, voiceDuration + 0.35, 2));
		timeline.push({ index: i, img, voice: sc.voiceover ? voice : null, start: t, end: t + duration, duration, voiceDuration, onScreenText: sc.on_screen_text, voiceover: sc.voiceover });
		t += duration;
		assets[imgKey] = { scene: i, visual: sc.visual };
		assets[voiceKey] = { scene: i, voiceover: sc.voiceover };
	}
	fs.writeFileSync(manifestFile, JSON.stringify(assets, null, 2));

	const work = fs.mkdtempSync(path.join(dir, 'work-'));
	try {
		const clips = [], audios = [];
		for (const sc of timeline) {
			onProgress(`Animating scene ${sc.index + 1} of ${timeline.length}`);
			const frames = Math.round(sc.duration * FPS);
			const m = MOTIONS[sc.index % MOTIONS.length](frames);
			const clip = path.join(work, `v${sc.index}.mp4`);
			await ffmpeg(['-i', sc.img, '-vf',
				`scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},zoompan=z='${m.z}':x='${m.x}':y='${m.y}':d=${frames}:s=${W}x${H}:fps=${FPS},format=yuv420p`,
				'-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-r', String(FPS), clip]);
			clips.push(clip);
			const a = path.join(work, `a${sc.index}.wav`);
			const src = sc.voice ? ['-i', sc.voice] : ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo'];
			await ffmpeg([...src, '-af', 'apad', '-t', sc.duration.toFixed(3), '-ar', '44100', '-ac', '2', a]);
			audios.push(a);
		}
		const list = (files, name) => { const f = path.join(work, name); fs.writeFileSync(f, files.map((x) => `file '${x.replace(/'/g, "'\\''")}'`).join('\n')); return f; };
		const video = path.join(work, 'video.mp4'), audio = path.join(work, 'audio.wav');
		onProgress('Joining scenes');
		await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list(clips, 'v.txt'), '-c', 'copy', video]);
		await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list(audios, 'a.txt'), '-c', 'copy', audio]);

		const assFile = path.join(work, 'subs.ass');
		fs.writeFileSync(assFile, buildAss(timeline, { accent: cfg.accentColor }));
		onProgress('Adding captions');
		const out = path.join(dir, 'reel.mp4');
		const tmpOut = path.join(work, 'reel.mp4');
		await ffmpeg(['-i', video, '-i', audio, '-vf', `ass=${assFile}:fontsdir=${cfg.fontsDir}`,
			'-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-profile:v', 'high',
			'-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-shortest', '-movflags', '+faststart', tmpOut]);
		fs.renameSync(tmpOut, out);
		const thumb = path.join(dir, 'thumb.jpg');
		await ffmpeg(['-ss', String(Math.min(1.2, t / 2)), '-i', out, '-frames:v', '1', '-vf', 'scale=540:-2', '-q:v', '4', thumb]);
		const info = await probe(out);
		return {
			video: 'reel.mp4', thumb: 'thumb.jpg', duration: Number(info.duration.toFixed(2)),
			scenes: timeline.map((s) => ({ image: path.basename(s.img), start: Number(s.start.toFixed(2)), duration: Number(s.duration.toFixed(2)) })),
			renderedAt: new Date().toISOString(),
		};
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}
