// Content providers. One provider object answers every AI job the studio has, and each job is
// routed to whichever service can do it:
//
//   job         used for                 OpenAI key       Claude key only        no key (mock)
//   json        scripts, remakes,        OpenAI or Claude (Settings or AI_TEXT_PROVIDER)
//               patterns                                                        template scripts
//   vision      reel breakdowns          OpenAI or Claude (Settings or AI_VISION_PROVIDER)
//                                                                               measured only
//   image       scene visuals            gpt-image-1      text cards (no AI)     placeholder art
//   speech      voiceover                gpt-4o-mini-tts  silent, captions only  silent track
//   transcribe  watched reels            whisper-1        site captions only     site captions only
//
// imageId / voiceId name where images and voice come from, so rendered media is cached per source.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OpenAIClient } from './openai.js';
import { AnthropicClient } from './anthropic.js';
import { ffmpeg } from './ffmpeg.js';
import { assEscape } from './render.js';

// Which service a job goes to: the requested one when its key exists, else the other one.
export function route(want, { openai, anthropic }) {
	if (want === 'anthropic') return anthropic ? 'anthropic' : 'openai';
	if (want === 'openai') return openai ? 'openai' : 'anthropic';
	return openai ? 'openai' : 'anthropic';
}

export function createProvider(cfg) {
	const oaKey = cfg.openai?.apiKey, clKey = cfg.anthropic?.apiKey;
	if (cfg.mock || (!oaKey && !clKey)) return mockProvider();

	const oa = oaKey ? new OpenAIClient(cfg.openai) : null;
	const cl = clKey ? new AnthropicClient(cfg.anthropic) : null;
	const have = { openai: Boolean(oa), anthropic: Boolean(cl) };
	const text = route(cfg.ai?.text, have);
	const vision = route(cfg.ai?.vision, have);
	const clModel = cfg.anthropic?.model;
	const visionModel = cfg.openai?.visionModel || cfg.openai?.textModel;
	const parts = { text, vision, image: oa ? 'openai' : 'cards', voice: oa ? 'openai' : 'none', transcribe: oa ? 'openai' : 'captions' };
	const models = {
		text: text === 'anthropic' ? clModel : cfg.openai.textModel,
		vision: vision === 'anthropic' ? clModel : visionModel,
		image: oa ? cfg.openai.imageModel : 'text cards',
		voice: oa ? `${cfg.openai.ttsModel} (${cfg.openai.ttsVoice})` : 'none (captions only)',
		transcribe: oa ? cfg.openai.transcribeModel || 'whisper-1' : 'captions only',
	};
	return {
		name: text, mode: 'live', parts, models,
		imageId: parts.image,
		voiceId: `${parts.voice}|${models.voice}`,
		json: (req) => (text === 'anthropic' ? cl.json(req) : oa.json(req)),
		vision: (req) => (vision === 'anthropic' ? cl.json({ ...req, maxTokens: 12000 }) : oa.json({ ...req, model: visionModel })),
		image: oa
			? async (prompt, outFile) => fs.promises.writeFile(outFile, await oa.image(prompt))
			: (prompt, outFile, { index = 0 } = {}) => cardImage(outFile, index, cfg.accentColor),
		speech: oa
			? async (line, outFile, opts) => fs.promises.writeFile(outFile, await oa.speech(line, opts))
			: (line, outFile) => silentSpeech(line, outFile),
		transcribe: oa ? (file) => oa.transcribe(file) : null,
	};
}

function mockProvider() {
	return {
		name: 'mock', mode: 'mock',
		parts: { text: 'mock', vision: 'mock', image: 'mock', voice: 'mock', transcribe: 'captions' },
		models: { text: 'mock', image: 'mock', voice: 'mock (silent)', vision: 'mock (measured only)', transcribe: 'captions only' },
		imageId: 'mock',
		voiceId: 'mock|mock (silent)',
		json: async (req) => (req.mock ? req.mock() : { reels: [] }),
		// Mock mode cannot see or hear: analysis falls back to what ffmpeg measures.
		vision: async (req) => req.mock(),
		image: (prompt, outFile, { index = 0, fontsDir } = {}) => mockImage(prompt, outFile, index, fontsDir),
		speech: (line, outFile) => silentSpeech(line, outFile),
		transcribe: null,
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

// Text-card background for reels made without an image model: a deep diagonal gradient tinted
// with the accent colour, fine grain and a vignette. The headline and captions carry the content.
const CARD_BASES = ['0x0f1216', '0x14161f', '0x17120f', '0x0f1714', '0x16101a', '0x11151c'];
async function cardImage(outFile, index, accent = '#C8F53A') {
	const hex = /^#?([0-9a-f]{6})$/i.exec(accent || '')?.[1] || 'C8F53A';
	const tint = `0x${[0, 2, 4].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.3).toString(16).padStart(2, '0')).join('')}`;
	const base = CARD_BASES[index % CARD_BASES.length];
	const [x0, x1] = index % 2 ? [1024, 0] : [0, 1024];
	await ffmpeg(['-f', 'lavfi', '-i', `gradients=s=1024x1536:c0=${base}:c1=${tint}:x0=${x0}:y0=0:x1=${x1}:y1=1536:d=1`,
		'-vf', 'noise=alls=7:allf=u,vignette=angle=0.6', '-frames:v', '1', outFile]);
}

// Silent track as long as the line would take to say, so captions still pace naturally.
async function silentSpeech(line, outFile) {
	const words = line.trim().split(/\s+/).filter(Boolean).length;
	const secs = Math.max(1, words / 2.6 + 0.3).toFixed(2);
	await ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', secs, '-c:a', 'libmp3lame', '-b:a', '64k', outFile]);
}
