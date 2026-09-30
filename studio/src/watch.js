// Watching one reel end to end: get the video, measure it, transcribe it, analyse it.
import fs from 'node:fs';
import path from 'node:path';
import { probe } from './ffmpeg.js';
import { downloadVideo, findCaptions } from './fetchvideo.js';
import { detectCuts, frameTimes, extractFrames, extractAudio, parseCaptions, transcriptFromSegments } from './measure.js';
import { analyzeReel } from './analyze.js';

export async function watchSource({ source, dir, provider, cfg, onProgress = () => {} }) {
	const w = cfg.watch;
	const warnings = [];
	let file = source.file && fs.existsSync(path.join(dir, source.file)) ? source.file : null;
	let meta = source.meta || null;
	if (!file) {
		if (!source.url) throw new Error('The uploaded video is missing. Upload it again.');
		onProgress('Downloading the reel');
		const dl = await downloadVideo(source.url, dir, w);
		file = dl.file;
		meta = dl.meta;
	}
	const full = path.join(dir, file);
	const info = await probe(full);
	if (!info.video) throw new Error('That file has no video track.');
	if (!info.duration) throw new Error('Could not read the video length.');
	if (info.duration > w.maxSeconds) throw new Error(`The video is ${Math.round(info.duration)} s long; the limit is ${w.maxSeconds} s (WATCH_MAX_SECONDS).`);

	onProgress('Finding the cuts');
	const cuts = await detectCuts(full, w.sceneThreshold);
	onProgress('Taking key frames');
	const frames = await extractFrames(full, dir, frameTimes(info.duration, cuts, w.maxFrames));
	if (!frames.length) throw new Error('Could not read any frames from the video.');

	onProgress('Listening to the audio');
	let transcript = { source: 'none', language: null, text: '', segments: [], words: [] };
	if (info.audio && provider.transcribe) {
		try {
			const audio = await extractAudio(full, path.join(dir, 'speech.mp3'));
			if (audio) transcript = { source: 'openai', ...(await provider.transcribe(audio)) };
		} catch (e) { warnings.push(`Transcription failed: ${e.message}`); }
	}
	const captions = findCaptions(dir);
	if (!transcript.text && captions) {
		transcript = transcriptFromSegments(parseCaptions(fs.readFileSync(path.join(dir, captions), 'utf8')), 'captions');
	}
	if (!transcript.text && info.audio && !provider.transcribe) {
		warnings.push(provider.mode === 'mock'
			? 'No captions came with this video and mock mode cannot transcribe. Add an OpenAI key to hear the words.'
			: 'No captions came with this video. Speech is transcribed with OpenAI; Claude reads the frames but cannot hear audio. Add an OpenAI key in Settings to include the spoken words.');
	}

	onProgress(provider.name === 'mock' ? 'Measuring pacing' : 'Analysing hook, structure and pacing');
	const measured = { duration: info.duration, cuts, frames, transcript, meta };
	const breakdown = await analyzeReel(provider, measured, dir);

	return {
		file, meta, warnings,
		video: { duration: Math.round(info.duration * 100) / 100, width: info.video.width, height: info.video.height, audio: Boolean(info.audio) },
		cuts, frames, transcript, breakdown,
		analyzedWith: provider.name === 'mock' ? 'measured only (mock)' : provider.models?.vision || 'openai',
		analyzedAt: new Date().toISOString(),
	};
}
