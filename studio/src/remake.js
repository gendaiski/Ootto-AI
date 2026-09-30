// Turning a watched reel into a new reel plan.
// - format: same beats, timing, hook type, shots and text placement; new words and visuals for the
//   business. Nothing of the original's wording, footage or audio is reused.
// - exact: the original's words and timing, with new AI visuals and voice. Only for reels the user
//   owns or has the rights to (the API requires that confirmation).
import { REEL_SCHEMA, briefBlock, normalizeReel } from './planner.js';

const r2 = (n) => Math.round(n * 100) / 100;

// Merge the shortest neighbouring beats until at most `max` remain (renders stay affordable).
export function compactBeats(beats, max = 12) {
	const out = beats.map((b) => ({ ...b }));
	while (out.length > max) {
		let best = 0;
		for (let i = 1; i < out.length - 1; i++) {
			if (out[i].end - out[i].start + (out[i + 1].end - out[i + 1].start) < out[best].end - out[best].start + (out[best + 1].end - out[best + 1].start)) best = i;
		}
		const [a, b] = [out[best], out[best + 1]];
		out.splice(best, 2, {
			...a, end: b.end,
			on_screen_text: [a.on_screen_text, b.on_screen_text].filter(Boolean).join(' '),
			spoken: [a.spoken, b.spoken].filter(Boolean).join(' '),
			visual: a.visual || b.visual,
		});
	}
	return out;
}

const SYSTEM = `You adapt proven short-form video formats for small businesses. You receive a beat-by-beat breakdown of a reel that performed well and a business brief. Write a new Instagram Reel for the business that reuses the reel's FORMAT: the same number of scenes as beats, the same length per scene, the same purpose per beat, the same hook technique, the same shot types and framing, the same pacing.
Rules:
- Do not reuse the original's sentences, overlay text, jokes, names, brand or footage. Every line is new and about this business. Never mention the original creator.
- The first scene's overlay text is the hook, using the same hook technique as the original.
- Overlay text: at most 10 words. Voiceover: fits the scene length at about 2.5 words per second; leave it empty for scenes where the original has no speech.
- Visual prompts describe a realistic vertical photo for this business with the same shot type and framing as the original beat. Never ask for words, letters, logos or signs in the image.
- Keep every claim consistent with the brief. Do not invent prices, awards, statistics or customer names.
- Write every field in the requested language.`;

function beatLines(beats) {
	return beats.map((b, i) => `Scene ${i + 1}: ${r2(b.end - b.start)} s · ${b.purpose} · shot: ${b.shot} · text ${b.text_position}\n  original text: "${b.on_screen_text}"\n  original speech: "${b.spoken}"\n  original visual: ${b.visual}`).join('\n');
}

export async function remakePlan(provider, brand, source) {
	const b = source.breakdown;
	const beats = compactBeats(b.beats);
	const user = `${briefBlock(brand)}

Original reel (${b.pacing.seconds} s, format ${b.format}, hook technique ${b.hook.type}, overlay text ${b.layout.text_position}):
Topic: ${b.topic}
Why it works: ${b.why_it_works.join('; ')}
Template: ${b.template}

${beatLines(beats)}

Write the adapted reel with exactly ${beats.length} scenes. Scene lengths in seconds: ${beats.map((x) => r2(x.end - x.start)).join(', ')}.`;
	const out = await provider.json({ system: SYSTEM, user, schemaName: 'reel', schema: REEL_SCHEMA, mock: () => mockRemake(brand, b, beats) });
	const plan = normalizeReel(out, { timing: 'exact', layout: { text_position: b.layout.text_position } });
	// Hold the original's rhythm even if the model drifted on lengths.
	if (plan.scenes.length === beats.length) plan.scenes.forEach((sc, i) => { sc.seconds = r2(Math.max(0.5, beats[i].end - beats[i].start)); });
	return plan;
}

const HASHTAG = /#([\p{L}\p{N}_]+)/gu;

// The original words and timing, new visuals and voice. Nothing to generate beyond media.
export function exactPlan(source) {
	const b = source.breakdown;
	const beats = compactBeats(b.beats);
	const caption = String(source.meta?.caption || '');
	return normalizeReel({
		title: `Remake: ${source.meta?.title || b.topic || 'watched reel'}`,
		format: 'remake',
		hook: b.hook.on_screen_text || b.hook.spoken || beats[0].on_screen_text,
		scenes: beats.map((x) => ({ seconds: x.end - x.start, visual: x.visual, on_screen_text: x.on_screen_text, voiceover: x.spoken })),
		caption: caption.replace(HASHTAG, '').replace(/[ \t]+\n/g, '\n').trim(),
		hashtags: [...caption.matchAll(HASHTAG)].map((m) => m[1]),
		cta: b.cta,
		best_time: '18:00',
	}, { timing: 'exact', layout: { text_position: b.layout.text_position } });
}

// Mock: same rhythm and beat purposes, template lines about the business.
function mockRemake(brand, b, beats) {
	const name = brand.name || 'our business';
	const offer = brand.offer || 'Send us a message';
	const lines = {
		hook: ['Nobody tells you this about ' + name, `Stop scrolling if you love ${name}`],
		problem: ['Most people get this wrong', 'Here is the problem'],
		context: [`At ${name} we see it every week`, 'A bit of background'],
		point: ['Do this instead', 'Small change, big difference', 'The simple fix'],
		proof: ['Our regulars noticed straight away', 'See the difference'],
		demo: ['Watch how we do it', 'Step by step'],
		twist: ['But here is the twist', 'It is not what you think'],
		payoff: ['And that is the secret', 'Worth it every time'],
		cta: [offer, offer],
	};
	return {
		title: `Remake: ${b.topic || 'watched reel'}`.slice(0, 60),
		format: 'tips',
		hook: lines.hook[0],
		scenes: beats.map((x, i) => {
			const text = (lines[x.purpose] || lines.point)[i % 2];
			const secs = r2(x.end - x.start);
			return {
				seconds: secs,
				visual: `${x.shot.replace(/_/g, ' ')} shot at ${name}, natural light`,
				on_screen_text: text,
				voiceover: x.spoken || b.audio.voiceover ? `${text}.`.split(/\s+/).slice(0, Math.max(2, Math.floor(secs * 2.5))).join(' ') : '',
			};
		}),
		caption: `${lines.hook[0]}.\n\nSame format as a reel that works, made for ${name}.`,
		hashtags: ['smallbusiness', 'reels', 'tips'],
		cta: offer,
		best_time: '18:00',
	};
}
