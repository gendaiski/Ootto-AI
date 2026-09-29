// Content providers. "openai" calls the OpenAI API; "mock" produces the same shapes offline
// (placeholder art rendered with ffmpeg, silent voice tracks, template scripts) so the whole
// pipeline can be exercised without a key.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OpenAIClient } from './openai.js';
import { ffmpeg } from './ffmpeg.js';
import { assEscape } from './render.js';

export function createProvider(cfg) {
	if (!cfg.mock) {
		const client = new OpenAIClient(cfg.openai);
		return {
			name: 'openai',
			models: { text: cfg.openai.textModel, image: cfg.openai.imageModel, voice: `${cfg.openai.ttsModel} (${cfg.openai.ttsVoice})` },
			json: (req) => client.json(req),
			image: async (prompt, outFile) => fs.promises.writeFile(outFile, await client.image(prompt)),
			speech: async (text, outFile, opts) => fs.promises.writeFile(outFile, await client.speech(text, opts)),
		};
	}
	return {
		name: 'mock',
		models: { text: 'mock', image: 'mock', voice: 'mock (silent)' },
		json: async (req) => (req.mock ? req.mock() : { reels: [] }),
		image: (prompt, outFile, { index = 0, fontsDir } = {}) => mockImage(prompt, outFile, index, fontsDir),
		speech: (text, outFile) => mockSpeech(text, outFile),
	};
}

const PALETTES = [
	['0x1d2b12', '0x5d7a1c'], ['0x14223a', '0x3b6fb6'], ['0x3a1426', '0xb63b6f'],
	['0x2b2112', '0xb6883b'], ['0x122b2a', '0x3bb6a4'], ['0x24143a', '0x7a3bb6'],
];

async function mockImage(prompt, outFile, index, fontsDir) {
	const [c0, c1] = PALETTES[index % PALETTES.length];
	const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ootto-img-'));
	const ass = path.join(tmp, 'label.ass');
	await fs.promises.writeFile(ass, `[Script Info]\nScriptType: v4.00+\nPlayResX: 1024\nPlayResY: 1536\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: L,DejaVu Sans,34,&H66FFFFFF,&H66FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,120,120,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,L,,0,0,0,,MOCK IMAGE\\N\\N${assEscape(prompt.split('. Vertical 9:16')[0].slice(0, 180))}\n`);
	try {
		await ffmpeg(['-f', 'lavfi', '-i', `gradients=s=1024x1536:c0=${c0}:c1=${c1}:x0=0:y0=0:x1=1024:y1=1536:d=1`,
			'-vf', `ass=${ass}:fontsdir=${fontsDir}`, '-frames:v', '1', outFile]);
	} finally {
		fs.promises.rm(tmp, { recursive: true, force: true });
	}
}

async function mockSpeech(text, outFile) {
	const words = text.trim().split(/\s+/).filter(Boolean).length;
	const secs = Math.max(1, words / 2.6 + 0.3).toFixed(2);
	await ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', secs, '-c:a', 'libmp3lame', '-b:a', '64k', outFile]);
}
