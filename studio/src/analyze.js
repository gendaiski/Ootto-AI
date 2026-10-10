// Reel analysis. One reel -> a beat-by-beat breakdown (hook, format, structure, pacing, layout),
// grounded in key frames + transcript + measured cuts. Several reels -> the patterns they share.
import fs from 'node:fs';
import path from 'node:path';
import { spokenBetween } from './measure.js';

export const REEL_FORMATS = ['talking_head', 'faceless_voiceover', 'text_on_screen', 'screen_recording', 'split_screen', 'montage', 'tutorial_demo', 'skit', 'slideshow', 'other'];
export const HOOK_TYPES = ['question', 'bold_claim', 'number_or_stat', 'mistake_warning', 'curiosity_gap', 'how_to_promise', 'list_promise', 'story_open', 'contrarian', 'pov', 'before_after', 'other'];
export const PURPOSES = ['hook', 'problem', 'context', 'point', 'proof', 'demo', 'twist', 'payoff', 'cta'];
export const SHOTS = ['face_to_camera', 'close_up', 'medium', 'wide', 'product', 'hands', 'screen', 'text_card', 'b_roll', 'other'];
export const TEXT_POSITIONS = ['top', 'middle', 'bottom', 'none'];

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const en = (values, description) => ({ type: 'string', enum: values, description });
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const arr = (items, description) => ({ type: 'array', items, description });

const BEAT = obj({
	start: num('Start time in seconds.'),
	end: num('End time in seconds.'),
	purpose: en(PURPOSES, 'What this beat does in the story.'),
	shot: en(SHOTS, 'Main shot type.'),
	text_position: en(TEXT_POSITIONS, 'Where the overlay text sits.'),
	on_screen_text: str('Overlay text exactly as shown, empty if none.'),
	spoken: str('Words said during this beat, from the transcript. Empty if none.'),
	visual: str('The shot, described so an image generator could recreate the composition. People described generically.'),
});

export const BREAKDOWN_SCHEMA = obj({
	topic: str('What the reel is about, in a few words.'),
	summary: str('Two sentences: what happens and who it is for.'),
	format: en(REEL_FORMATS, 'Overall style of the reel.'),
	hook: obj({
		type: en(HOOK_TYPES, 'The hook technique.'),
		seconds: num('How long the hook lasts.'),
		on_screen_text: str('Overlay text in the hook, exactly as shown.'),
		spoken: str('Words said in the hook.'),
		visual: str('What is on screen in the hook.'),
		why_it_works: str('Why this stops the scroll.'),
	}),
	beats: arr(BEAT, 'Every beat in order, covering the whole reel.'),
	pacing: obj({ notes: str('Cut rhythm, where it speeds up or slows down.') }),
	layout: obj({
		text_position: en(TEXT_POSITIONS, 'Where the main overlay text usually sits.'),
		caption_style: str('How captions and overlay text look: size, box, colour, animation, word highlight.'),
		framing: str('Typical framing and camera.'),
		colors: str('Dominant colours and look.'),
	}),
	audio: obj({
		voiceover: { type: 'boolean', description: 'True if someone speaks.' },
		music: str('Music style or "none".'),
		notes: str('Sound effects, silence, beat drops.'),
	}),
	cta: str('The call to action, empty if none.'),
	why_it_works: arr({ type: 'string' }, '3 to 5 reasons this reel performs.'),
	template: str('A reusable fill-in-the-blanks template of this reel, beat by beat.'),
});

const SYSTEM = `You are a short-form video analyst. You receive key frames from one short vertical video (each labelled with its timestamp), the scene cuts measured with ffmpeg, the transcript with timestamps, and the post's metadata. Break the reel down so it can be studied and its format reused.
Rules:
- Ground every point in what the frames show and the transcript says. If you cannot see or hear something, leave that field empty instead of guessing.
- Beats: split the reel at cuts or where the idea or overlay text changes. Beats are in order, start at 0, end at the video's duration, and leave no gaps.
- on_screen_text: copy overlay text exactly as shown, in its original language. spoken: the transcript words for that beat.
- visual: describe the shot for an image generator: subject, setting, framing, camera angle, light, colours. Describe people generically (age range, clothing, expression); never name or identify a real person.
- The hook is the opening, usually the first 1 to 3 seconds.
- Write summary, why_it_works, notes and template in English.`;

const r2 = (n) => Math.round(n * 100) / 100;
const fmtT = (t) => `${t.toFixed(2)}s`;

// Vision request: a text header, the transcript, then each frame with its timestamp.
export function analysisRequest({ duration, cuts, frames, transcript, meta }, dir) {
	const head = [
		`Duration: ${duration.toFixed(2)} seconds`,
		`Measured cuts at: ${cuts.length ? cuts.map(fmtT).join(', ') : 'none (one continuous shot)'}`,
		meta?.uploader && `Posted by: ${meta.uploader}${meta.platform ? ` on ${meta.platform}` : ''}`,
		meta?.views != null && `Views: ${meta.views}${meta.likes != null ? `, likes: ${meta.likes}` : ''}${meta.comments != null ? `, comments: ${meta.comments}` : ''}`,
		meta?.caption && `Post caption:\n${meta.caption.slice(0, 1500)}`,
		`Transcript (${transcript?.source || 'none'}):`,
		transcript?.segments?.length ? transcript.segments.map((s) => `[${fmtT(s.start)}-${fmtT(s.end)}] ${s.text}`).join('\n') : transcript?.text || '(no speech found)',
		`Key frames follow (${frames.length}).`,
	].filter(Boolean).join('\n');
	const parts = [{ type: 'text', text: head }];
	for (const f of frames) {
		parts.push({ type: 'text', text: `Frame at ${fmtT(f.t)}` });
		const b64 = fs.readFileSync(path.join(dir, f.file)).toString('base64');
		parts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'low' } });
	}
	return parts;
}

export async function analyzeReel(provider, measured, dir) {
	const out = await provider.vision({
		system: SYSTEM,
		user: analysisRequest(measured, dir),
		schemaName: 'reel_breakdown',
		schema: BREAKDOWN_SCHEMA,
		mock: () => mockBreakdown(measured),
	});
	return normalizeBreakdown(out, measured);
}

const pick = (v, list, d) => (list.includes(v) ? v : d);
const s = (v, n = 2000) => String(v ?? '').trim().slice(0, n);

// Clean up the model's beats against the measured video and add measured pacing.
export function normalizeBreakdown(b, { duration, cuts = [] }) {
	let beats = (b.beats || [])
		.map((x) => ({
			start: r2(Math.max(0, Math.min(duration, Number(x.start) || 0))),
			end: r2(Math.max(0, Math.min(duration, Number(x.end) || 0))),
			purpose: pick(x.purpose, PURPOSES, 'point'), shot: pick(x.shot, SHOTS, 'other'),
			text_position: pick(x.text_position, TEXT_POSITIONS, 'none'),
			on_screen_text: s(x.on_screen_text, 300), spoken: s(x.spoken, 1200), visual: s(x.visual, 600),
		}))
		.sort((a, c) => a.start - c.start);
	// No gaps or overlaps: each beat ends where the next starts; the last ends at the duration.
	beats = beats.filter((x, i) => i === 0 || x.start > beats[i - 1].start);
	beats.forEach((x, i) => { x.end = i < beats.length - 1 ? beats[i + 1].start : r2(duration); });
	if (beats.length) beats[0].start = 0;
	// Fold slivers under 0.2 s into the beat before (or after, for the first one).
	beats = beats.reduce((acc, x) => {
		if (x.end - x.start >= 0.2 || !acc.length) acc.push(x);
		else acc.at(-1).end = x.end;
		return acc;
	}, []);
	if (beats.length > 1 && beats[0].end - beats[0].start < 0.2) { beats[1].start = 0; beats.shift(); }
	beats = beats.slice(0, 30);
	if (beats.length) beats.at(-1).end = r2(duration);
	if (!beats.length) beats = [{ start: 0, end: r2(duration), purpose: 'hook', shot: 'other', text_position: 'none', on_screen_text: '', spoken: '', visual: '' }];
	const hook = b.hook || {};
	const layout = b.layout || {};
	return {
		topic: s(b.topic, 200), summary: s(b.summary, 800),
		format: pick(b.format, REEL_FORMATS, 'other'),
		hook: {
			type: pick(hook.type, HOOK_TYPES, 'other'),
			seconds: r2(Math.min(duration, Math.max(0.5, Number(hook.seconds) || beats[0].end))),
			on_screen_text: s(hook.on_screen_text, 300), spoken: s(hook.spoken, 600), visual: s(hook.visual, 600), why_it_works: s(hook.why_it_works, 600),
		},
		beats,
		pacing: {
			seconds: r2(duration),
			beats: beats.length,
			avg_beat_seconds: r2(duration / beats.length),
			cuts: cuts.length,
			cuts_per_10s: r2((cuts.length / Math.max(1, duration)) * 10),
			notes: s(b.pacing?.notes, 600),
		},
		layout: {
			text_position: pick(layout.text_position, TEXT_POSITIONS, mostCommon(beats.map((x) => x.text_position).filter((p) => p !== 'none')) || 'top'),
			caption_style: s(layout.caption_style, 400), framing: s(layout.framing, 400), colors: s(layout.colors, 300),
		},
		audio: { voiceover: Boolean(b.audio?.voiceover), music: s(b.audio?.music, 200), notes: s(b.audio?.notes, 400) },
		cta: s(b.cta, 300),
		why_it_works: (b.why_it_works || []).map((x) => s(x, 400)).filter(Boolean).slice(0, 6),
		template: s(b.template, 2000),
	};
}

function mostCommon(list) {
	const c = new Map();
	for (const x of list) c.set(x, (c.get(x) || 0) + 1);
	return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

// Without a key: beats come from the measured cuts (long shots split into ~3 s pieces) and words
// from captions when the site provided them. Text, visuals and the hook type stay empty.
export function mockBreakdown({ duration, cuts, transcript }) {
	const edges = [0, ...cuts.filter((c) => c > 0.2 && c < duration - 0.2), duration];
	const beats = [];
	for (let i = 0; i < edges.length - 1; i++) {
		const [a, b] = [edges[i], edges[i + 1]];
		const pieces = Math.max(1, Math.round((b - a) / 3.5));
		for (let k = 0; k < pieces; k++) {
			const start = a + ((b - a) * k) / pieces, end = a + ((b - a) * (k + 1)) / pieces;
			beats.push({ start, end, purpose: beats.length === 0 ? 'hook' : 'point', shot: 'other', text_position: 'none', on_screen_text: '', spoken: spokenBetween(transcript, start, end), visual: '' });
		}
	}
	if (beats.length > 1) beats.at(-1).purpose = 'cta';
	return {
		topic: '', summary: 'Measured without AI: cut timings, pacing and frames are real; add an OpenAI key to read the text, visuals and hook.',
		format: 'other',
		hook: { type: 'other', seconds: beats[0]?.end || 0, on_screen_text: '', spoken: beats[0]?.spoken || '', visual: '', why_it_works: '' },
		beats, pacing: { notes: '' },
		layout: { text_position: 'top', caption_style: '', framing: '', colors: '' },
		audio: { voiceover: Boolean(transcript?.text), music: '', notes: '' },
		cta: '', why_it_works: [], template: '',
	};
}

// ---------- patterns across several reels ----------
export const PROFILE_SCHEMA = obj({
	name: str('Short name for this style, at most 6 words.'),
	summary: str('Two or three sentences on what the strongest reels have in common.'),
	hook_patterns: arr(obj({
		type: en(HOOK_TYPES, 'Hook technique.'),
		template: str('Fill-in-the-blanks hook line.'),
		example: str('One example from the reels.'),
	}), '2 to 5 hook shapes that repeat.'),
	structure: arr(en(PURPOSES, 'Beat purpose.'), 'The beat sequence that works best, e.g. hook, problem, point, proof, cta.'),
	formats: arr(en(REEL_FORMATS, 'Format.'), 'Formats that work, most important first.'),
	length_seconds: num('Recommended total length.'),
	beat_seconds: num('Recommended average beat length.'),
	text_position: en(TEXT_POSITIONS, 'Where overlay text should sit.'),
	caption_style: str('How overlay text and captions should look.'),
	cta_patterns: arr({ type: 'string' }, 'Calls to action that repeat.'),
	do: arr({ type: 'string' }, '3 to 6 concrete things to copy.'),
	avoid: arr({ type: 'string' }, '2 to 4 things the weaker reels do.'),
});

const PATTERN_SYSTEM = `You compare several short vertical videos that were broken down beat by beat, with their view and like counts when known, and find what the strongest ones share: hook shapes, beat structure, lengths, formats, text placement, calls to action. Weigh reels with more views more heavily. Be concrete and base every point on the breakdowns. Write in English.`;

export function compactBreakdown(src) {
	const b = src.breakdown;
	return {
		views: src.meta?.views ?? null, likes: src.meta?.likes ?? null, by: src.meta?.uploader || null,
		topic: b.topic, format: b.format, hook: b.hook, pacing: b.pacing, layout: b.layout, cta: b.cta,
		beats: b.beats.map((x) => ({ t: `${x.start}-${x.end}`, purpose: x.purpose, shot: x.shot, text: x.on_screen_text, spoken: x.spoken })),
	};
}

export async function findPatterns(provider, sources) {
	const out = await provider.json({
		system: PATTERN_SYSTEM,
		user: `Breakdowns of ${sources.length} reels:\n${JSON.stringify(sources.map(compactBreakdown), null, 1)}`,
		schemaName: 'reel_patterns',
		schema: PROFILE_SCHEMA,
		mock: () => mockPatterns(sources),
	});
	return normalizeProfile(out, sources);
}

export function normalizeProfile(p, sources) {
	const bds = sources.map((x) => x.breakdown);
	const avg = (xs) => (xs.length ? r2(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
	const list = (xs, n, len = 300) => [...new Set((xs || []).map((x) => s(x, len)).filter(Boolean))].slice(0, n);
	return {
		name: s(p.name, 80) || 'Reel patterns',
		summary: s(p.summary, 1000),
		hook_patterns: (p.hook_patterns || []).slice(0, 6).map((h) => ({ type: pick(h.type, HOOK_TYPES, 'other'), template: s(h.template, 300), example: s(h.example, 300) })),
		structure: (p.structure || []).filter((x) => PURPOSES.includes(x)).slice(0, 12),
		formats: [...new Set((p.formats || []).filter((x) => REEL_FORMATS.includes(x)))].slice(0, 4),
		length_seconds: r2(Math.min(180, Math.max(5, Number(p.length_seconds) || avg(bds.map((b) => b.pacing.seconds))))),
		beat_seconds: r2(Math.min(15, Math.max(0.5, Number(p.beat_seconds) || avg(bds.map((b) => b.pacing.avg_beat_seconds))))),
		text_position: pick(p.text_position, TEXT_POSITIONS, 'top'),
		caption_style: s(p.caption_style, 400),
		cta_patterns: list(p.cta_patterns, 6), do: list(p.do, 8), avoid: list(p.avoid, 6),
		measured: {
			reels: sources.length,
			avg_seconds: avg(bds.map((b) => b.pacing.seconds)),
			avg_beat_seconds: avg(bds.map((b) => b.pacing.avg_beat_seconds)),
			avg_cuts_per_10s: avg(bds.map((b) => b.pacing.cuts_per_10s)),
			total_views: sources.some((x) => x.meta?.views != null) ? sources.reduce((a, x) => a + (x.meta?.views || 0), 0) : null,
		},
	};
}

function mockPatterns(sources) {
	const bds = sources.map((x) => x.breakdown);
	const ranked = [...sources].sort((a, b) => (b.meta?.views || 0) - (a.meta?.views || 0));
	const top = ranked[0].breakdown;
	const hooks = bds.map((b) => b.hook).filter((h) => h.on_screen_text || h.spoken);
	return {
		name: 'Patterns from watched reels',
		summary: `Measured across ${sources.length} reels: average length and beat rhythm are real. Add an OpenAI key for hook, structure and style analysis.`,
		hook_patterns: hooks.slice(0, 3).map((h) => ({ type: h.type, template: h.on_screen_text || h.spoken, example: h.on_screen_text || h.spoken })),
		structure: top.beats.map((b) => b.purpose).slice(0, 8),
		formats: [...new Set(bds.map((b) => b.format))],
		length_seconds: 0, beat_seconds: 0,
		text_position: mostCommon(bds.map((b) => b.layout.text_position)) || 'top',
		caption_style: '',
		cta_patterns: bds.map((b) => b.cta).filter(Boolean).slice(0, 3),
		do: [`Keep beats around ${(bds.reduce((a, b) => a + b.pacing.avg_beat_seconds, 0) / bds.length).toFixed(1)} s, like these reels.`, 'Open on the hook text in the first second.', 'End with one clear call to action.'],
		avoid: ['Long single shots without a change on screen.'],
	};
}
