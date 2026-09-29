// Turns a business brief into a week of reel plans (and rewrites one reel from feedback).
// Optional: patterns learned from watched reels steer the week.
export const FORMATS = ['tips', 'myth_vs_fact', 'behind_the_scenes', 'customer_story', 'how_to', 'offer', 'faq'];
const ALL_FORMATS = [...FORMATS, 'remake'];

const SCENE = {
	type: 'object',
	additionalProperties: false,
	required: ['seconds', 'visual', 'on_screen_text', 'voiceover'],
	properties: {
		seconds: { type: 'number', description: 'Target length of this scene, 2 to 6 seconds.' },
		visual: { type: 'string', description: 'Prompt for a vertical photo. Describe subject, setting, light, framing. Never ask for text in the image.' },
		on_screen_text: { type: 'string', description: 'Big overlay text, at most 8 words.' },
		voiceover: { type: 'string', description: 'What the narrator says during this scene, at most 25 words.' },
	},
};

export const REEL_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['title', 'format', 'hook', 'scenes', 'caption', 'hashtags', 'cta', 'best_time'],
	properties: {
		title: { type: 'string', description: 'Internal name for the reel, at most 6 words.' },
		format: { type: 'string', enum: FORMATS },
		hook: { type: 'string', description: 'The line that stops the scroll in the first 2 seconds.' },
		scenes: { type: 'array', items: SCENE, description: '3 to 6 scenes.' },
		caption: { type: 'string', description: 'Instagram caption without hashtags, 1 to 3 short paragraphs.' },
		hashtags: { type: 'array', items: { type: 'string' }, description: '5 to 10 hashtags without the # sign.' },
		cta: { type: 'string', description: 'The single action you ask viewers to take.' },
		best_time: { type: 'string', description: 'Posting time as HH:MM, 24-hour, in the audience time zone.' },
	},
};

const WEEK_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['reels'],
	properties: { reels: { type: 'array', items: REEL_SCHEMA } },
};

const SYSTEM = `You are a short-form video strategist who writes Instagram Reels for small businesses.
Rules:
- One idea per reel. The hook lands in the first 2 seconds and is also the first scene's on-screen text.
- 3 to 6 scenes, 2 to 6 seconds each, 12 to 35 seconds in total.
- On-screen text: at most 8 words, punchy, no hashtags or emoji.
- Voiceover: conversational, second person, at most 25 words per scene, matches that scene's visual.
- Visual prompts describe a realistic vertical photo that fits the business. Never ask for words, letters, logos or signs in the image.
- Keep every claim consistent with the brief. Do not invent prices, awards, statistics or customer names that are not in the brief.
- Vary the formats across the week and end each reel with one clear call to action.
- Write every field in the requested language.`;

export function briefBlock(brand) {
	return [
		`Business: ${brand.name || 'unnamed'}`,
		brand.website && `Website: ${brand.website}`,
		brand.description && `What they do: ${brand.description}`,
		brand.audience && `Audience: ${brand.audience}`,
		brand.offer && `Main offer / call to action: ${brand.offer}`,
		brand.tone && `Tone: ${brand.tone}`,
		`Language: ${brand.language || 'English'}`,
		brand.site?.text && `Website text (for facts only):\n${brand.site.title}\n${brand.site.description}\n${brand.site.text.slice(0, 5000)}`,
	].filter(Boolean).join('\n');
}

// Patterns found across watched reels, as instructions for the planner.
export function profileBlock(p) {
	return [
		`Use these patterns, learned from reels that perform well in this niche${p.measured?.reels ? ` (${p.measured.reels} reels studied)` : ''}:`,
		p.summary,
		p.hook_patterns?.length && `Hook shapes that work (fill them for this business, do not copy the examples):\n${p.hook_patterns.map((h) => `- ${h.type}: ${h.template}`).join('\n')}`,
		p.structure?.length && `Beat structure: ${p.structure.join(' -> ')}`,
		p.length_seconds && `Target length: about ${Math.round(p.length_seconds)} seconds, beats of about ${p.beat_seconds} seconds.`,
		p.cta_patterns?.length && `Calls to action that work: ${p.cta_patterns.join('; ')}`,
		p.do?.length && `Do: ${p.do.join('; ')}`,
		p.avoid?.length && `Avoid: ${p.avoid.join('; ')}`,
	].filter(Boolean).join('\n');
}

export async function planWeek(provider, brand, count, { profile = null } = {}) {
	const out = await provider.json({
		system: SYSTEM,
		user: `${briefBlock(brand)}\n\n${profile ? `${profileBlock(profile)}\n\n` : ''}Write ${count} different reels for the coming week, in posting order.`,
		schemaName: 'reel_week',
		schema: WEEK_SCHEMA,
		mock: () => mockWeek(brand, count, profile),
	});
	const layout = profile?.text_position && profile.text_position !== 'none' ? { text_position: profile.text_position } : undefined;
	const reels = (out.reels || []).slice(0, count).map((r) => normalizeReel(r, { layout }));
	if (!reels.length) throw new Error('The planner returned no reels.');
	return reels;
}

export async function reviseReel(provider, brand, plan, feedback) {
	const exact = plan.timing === 'exact';
	const keep = exact ? `\nKeep exactly ${plan.scenes.length} scenes with the same seconds per scene unless the feedback asks to change the timing.` : '';
	const out = await provider.json({
		system: SYSTEM,
		user: `${briefBlock(brand)}\n\nHere is a reel the owner reviewed:\n${JSON.stringify(plan, null, 2)}\n\nTheir feedback: "${feedback}"\n\nRewrite this reel to address the feedback. Keep what they did not complain about.${keep}`,
		schemaName: 'reel',
		schema: REEL_SCHEMA,
		mock: () => mockRevision(plan, feedback),
	});
	const next = normalizeReel(out, { timing: plan.timing, layout: plan.layout });
	if (exact && next.scenes.length === plan.scenes.length) next.scenes.forEach((sc, i) => { sc.seconds = plan.scenes[i].seconds; });
	return next;
}

const clampWords = (s, n) => String(s || '').trim().split(/\s+/).slice(0, n).join(' ');

// timing 'exact' (remakes): keep each scene's length as given (0.5-20 s), allow up to 12 scenes
// and longer lines. layout.text_position places the headline (top, middle or bottom).
export function normalizeReel(r, { timing, layout } = {}) {
	const exact = timing === 'exact';
	let scenes = (r.scenes || []).slice(0, exact ? 12 : 6).map((s) => ({
		seconds: exact ? Math.round(Math.min(20, Math.max(0.5, Number(s.seconds) || 3)) * 100) / 100 : Math.min(6, Math.max(2, Number(s.seconds) || 3)),
		visual: String(s.visual || '').trim() || 'A warm, natural-light photo of the business at work',
		on_screen_text: clampWords(s.on_screen_text, exact ? 16 : 8),
		voiceover: clampWords(s.voiceover, exact ? 60 : 30),
	}));
	if (scenes.length < 1) throw new Error('A reel came back without scenes.');
	const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(r.best_time) ? r.best_time : '18:00';
	const pos = layout?.text_position;
	return {
		title: clampWords(r.title, 8) || 'Untitled reel',
		format: ALL_FORMATS.includes(r.format) ? r.format : 'tips',
		hook: String(r.hook || scenes[0].on_screen_text).trim(),
		scenes,
		caption: String(r.caption || '').trim(),
		hashtags: [...new Set((r.hashtags || []).map((h) => String(h).replace(/^#/, '').replace(/\s+/g, '')).filter(Boolean))].slice(0, 12),
		cta: String(r.cta || '').trim(),
		best_time: time,
		...(exact && { timing: 'exact' }),
		...(['top', 'middle', 'bottom'].includes(pos) && { layout: { text_position: pos } }),
	};
}

// ---------- mock content (no API key) ----------
function mockWeek(brand, count, profile) {
	const hookFrom = (i, fallback) => profile?.hook_patterns?.[i % (profile.hook_patterns.length || 1)]?.template || fallback;
	const name = brand.name || 'your business';
	const offer = brand.offer || 'Send us a message';
	const topics = [
		['tips', '3 mistakes customers make', 'Avoid these three mistakes'],
		['behind_the_scenes', 'A day behind the counter', 'What really happens before we open'],
		['myth_vs_fact', 'Myth vs fact', 'You have been told this is true'],
		['how_to', 'Quick how-to', 'Do this in under a minute'],
		['customer_story', 'Why people come back', 'This is why they keep coming back'],
		['faq', 'The question we get most', 'Everyone asks us this'],
		['offer', 'This week only', 'Here is what is on this week'],
	];
	return {
		reels: Array.from({ length: count }, (_, i) => {
			const [format, baseTitle, baseHook] = topics[i % topics.length];
			const hook = hookFrom(i, baseHook);
			const title = profile ? clampWords(hook, 6) : baseTitle;
			return {
				title, format, hook,
				scenes: [
					{ seconds: 3, visual: `Close-up of hands at work inside ${name}, warm morning light`, on_screen_text: hook, voiceover: `${hook}. Stay for ten seconds, it is worth it.` },
					{ seconds: 4, visual: `Wide shot of the ${name} space with a customer being helped`, on_screen_text: 'Here is the short version', voiceover: `At ${name} we see this every single week, and the fix is simpler than you think.` },
					{ seconds: 4, visual: 'Detail shot of the finished result on a clean table', on_screen_text: 'Small change, big difference', voiceover: 'Make this one change and you will notice the difference straight away.' },
					{ seconds: 3, visual: `Friendly team member at ${name} smiling toward the camera`, on_screen_text: offer, voiceover: `${offer}. We reply to every message.` },
				],
				caption: `${hook}.\n\nA quick one from the ${name} team. Save this for later.`,
				hashtags: ['smallbusiness', 'reels', 'tips', 'behindthescenes', 'local'],
				cta: offer,
				best_time: ['09:00', '12:30', '18:00', '19:30', '08:30', '17:00', '11:00'][i % 7],
			};
		}),
	};
}

function mockRevision(plan, feedback) {
	const next = structuredClone(plan);
	next.title = `${plan.title} (rev)`.slice(0, 60);
	next.hook = `${plan.hook} (revised: ${feedback.slice(0, 30)})`;
	next.scenes[0].on_screen_text = clampWords(`Revised: ${plan.scenes[0].on_screen_text}`, 8);
	return next;
}
