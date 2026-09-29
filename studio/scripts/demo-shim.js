// Demo only: answers the studio's /api requests inside the browser, so the page works with no
// server. Every flow works as a simulation built from the sample renders in the page:
// planning, rewriting, watching links or uploads, remaking, finding patterns and planning from
// them. Simulated results are labelled as such. No keys are accepted here, and nothing leaves the
// browser. Changes are kept in this browser only (and reset when the demo is rebuilt).
(() => {
	const seed = window.__OOTTO_DEMO__;
	const KEY = 'ootto.demo.v3';
	let db;
	try { db = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
	if (!db || db.seedId !== seed.brand.id) {
		db = { seedId: seed.brand.id, brands: [structuredClone(seed.brand)], reels: structuredClone(seed.reels), sources: structuredClone(seed.sources), profiles: structuredClone(seed.profiles) };
	}
	const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} };
	const SAMPLE_REELS = seed.reels.filter((r) => !r.origin);
	const REMAKE = seed.reels.find((r) => r.id === seed.remakeId) || SAMPLE_REELS[0];
	const SAMPLE_SOURCES = seed.sources;
	const NOTE_REEL = 'Demo: this plays a sample render. The real studio renders this script with AI images and voice.';
	const NOTE_SOURCE = 'Demo: this shows a sample analysis. The real studio downloads this reel, transcribes it and analyses it with OpenAI or Claude.';

	// Work interrupted by a reload finishes straight away.
	for (const r of db.reels) if (['queued', 'rendering'].includes(r.status)) { r.status = 'ready'; r.progress = ''; }
	for (const x of db.sources) if (['queued', 'watching'].includes(x.status)) Object.assign(x, finishedSource(x));

	const rid = (p) => `${p}_demo_${Math.random().toString(16).slice(2, 10)}`;
	const captionText = (p) => [p.caption, (p.hashtags || []).map((h) => `#${h}`).join(' ')].filter(Boolean).join('\n\n');
	const view = (r) => ({ ...r, captionText: captionText(r.plan) });
	const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
	const fail = (msg, status = 400) => json({ error: msg }, status);
	const clampWords = (s, n) => String(s || '').trim().split(/\s+/).slice(0, n).join(' ');
	const shortUrl = (u) => { try { const x = new URL(u); return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/$/, '')}`.slice(0, 60); } catch { return u; } };
	const platformOf = (u) => { const h = (() => { try { return new URL(u).hostname; } catch { return ''; } })(); return /instagram/.test(h) ? 'Instagram' : /tiktok/.test(h) ? 'TikTok' : /youtu/.test(h) ? 'YouTube' : h || 'Link'; };
	const at = (day, offset, hhmm) => { const [y, m, d] = day.split('-').map(Number); const [hh, mm] = hhmm.split(':').map(Number); return new Date(y, m - 1, d + offset, hh, mm).toISOString(); };
	const tomorrow = () => { const t = new Date(Date.now() + 86400000); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };

	function simulate(item, steps, busy, done) {
		item.status = busy; item.progress = steps[0]; save();
		steps.slice(1).forEach((s, i) => setTimeout(() => { item.progress = s; save(); }, 800 * (i + 1)));
		setTimeout(() => { done(); item.progress = ''; save(); }, 800 * steps.length);
	}
	const RENDER_STEPS = ['Writing the script', 'Creating images', 'Recording voice', 'Animating scenes', 'Adding captions'];

	function finishedSource(x) {
		const sample = SAMPLE_SOURCES[Math.max(0, db.sources.indexOf(x)) % SAMPLE_SOURCES.length];
		return {
			status: 'ready', progress: '', error: null, warnings: [], demoNote: NOTE_SOURCE,
			video: sample.video, cuts: sample.cuts, frames: sample.frames, transcript: sample.transcript, breakdown: sample.breakdown,
			videoUrl: sample.videoUrl, videoWebmUrl: sample.videoWebmUrl, thumbUrl: sample.thumbUrl,
			analyzedWith: 'demo (sample analysis)', analyzedAt: new Date().toISOString(),
		};
	}

	// ---------- scripts, in the same shape the real planner returns ----------
	const TOPICS = [
		['tips', '3 mistakes customers make', 'Avoid these three mistakes'],
		['behind_the_scenes', 'A day behind the counter', 'What really happens before we open'],
		['myth_vs_fact', 'Myth vs fact', 'You have been told this is true'],
		['how_to', 'Quick how-to', 'Do this in under a minute'],
		['customer_story', 'Why people come back', 'This is why they keep coming back'],
		['faq', 'The question we get most', 'Everyone asks us this'],
		['offer', 'This week only', 'Here is what is on this week'],
	];
	function planFor(brand, i, profile) {
		const name = brand.name || 'your business';
		const offer = brand.offer || 'Send us a message';
		const [format, title, baseHook] = TOPICS[i % TOPICS.length];
		const hook = profile?.profile?.hook_patterns?.[i % (profile.profile.hook_patterns.length || 1)]?.template || baseHook;
		return {
			title: profile ? clampWords(hook, 6) : title, format, hook,
			scenes: [
				{ seconds: 3, visual: `Close-up inside ${name}, warm morning light`, on_screen_text: clampWords(hook, 8), voiceover: `${hook}. Stay for ten seconds, it is worth it.` },
				{ seconds: 4, visual: `Wide shot of ${name} with a customer being helped`, on_screen_text: 'Here is the short version', voiceover: `At ${name} we see this every week, and the fix is simpler than you think.` },
				{ seconds: 4, visual: 'Detail shot of the finished result', on_screen_text: 'Small change, big difference', voiceover: 'Make this one change and you will notice the difference straight away.' },
				{ seconds: 3, visual: `Friendly team member at ${name} smiling`, on_screen_text: clampWords(offer, 8), voiceover: `${offer}. We reply to every message.` },
			],
			caption: `${hook}.\n\nA quick one from the ${name} team. Save this for later.`,
			hashtags: ['smallbusiness', 'reels', 'tips', 'local'], cta: offer,
			best_time: ['09:00', '12:30', '18:00', '19:30', '08:30', '17:00', '11:00'][i % 7],
		};
	}
	const LINES = {
		hook: 'Nobody tells you this', problem: 'Most people get this wrong', context: 'We see it every week', point: 'Do this instead',
		proof: 'Our regulars noticed', demo: 'Watch how we do it', twist: 'Here is the twist', payoff: 'Worth it every time', cta: null,
	};
	function remakePlanFor(brand, x, mode) {
		const b = x.breakdown;
		const scenes = b.beats.slice(0, 12).map((bt) => {
			const seconds = Math.round((bt.end - bt.start) * 100) / 100;
			if (mode === 'exact') return { seconds, visual: bt.visual, on_screen_text: bt.on_screen_text, voiceover: bt.spoken };
			const text = bt.purpose === 'cta' ? (brand.offer || 'Send us a message') : `${LINES[bt.purpose] || LINES.point}${bt.purpose === 'hook' ? ` about ${brand.name}` : ''}`;
			return { seconds, visual: `${bt.shot.replace(/_/g, ' ')} shot at ${brand.name}, same framing as the original`, on_screen_text: clampWords(text, 10), voiceover: `${text}.` };
		});
		return {
			title: `Remake: ${x.meta?.title || b.topic || 'watched reel'}`.slice(0, 60), format: mode === 'exact' ? 'remake' : 'tips',
			hook: scenes[0]?.on_screen_text || '', scenes, timing: 'exact', layout: { text_position: b.layout.text_position === 'none' ? 'top' : b.layout.text_position },
			caption: mode === 'exact' ? (x.meta?.caption || '') : `${scenes[0]?.on_screen_text}.\n\nSame format as a reel that works, made for ${brand.name}.`,
			hashtags: ['smallbusiness', 'reels'], cta: brand.offer || '', best_time: '18:00',
		};
	}
	function newReel(brand, plan, template, extra) {
		const r = {
			id: rid('reel'), brandId: brand.id, day: 0, plan, status: 'queued', progress: 'Waiting to render', history: [], createdAt: new Date().toISOString(),
			media: { ...template.media, scenes: plan.scenes.map((s, i) => ({ image: '', start: 0, duration: template.media.scenes?.[i]?.duration ?? s.seconds })) },
			videoUrl: template.videoUrl, videoWebmUrl: template.videoWebmUrl, thumbUrl: template.thumbUrl, demoNote: NOTE_REEL, ...extra,
		};
		db.reels.push(r);
		simulate(r, RENDER_STEPS, 'rendering', () => { r.status = 'ready'; });
		return r;
	}

	function patternsFrom(sources, name) {
		const bds = sources.map((x) => x.breakdown);
		const avg = (xs) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100;
		const base = seed.profiles[0]?.profile || {};
		return {
			...base,
			name: name || `Patterns from ${sources.length} reels`,
			summary: `Compared ${sources.length} reels (demo: a sample comparison). The real studio asks OpenAI or Claude what the strongest ones share.`,
			hook_patterns: bds.map((b) => ({ type: b.hook.type, template: b.hook.on_screen_text, example: b.hook.on_screen_text })).filter((h) => h.template).slice(0, 4),
			length_seconds: avg(bds.map((b) => b.pacing.seconds)), beat_seconds: avg(bds.map((b) => b.pacing.avg_beat_seconds)),
			measured: { reels: sources.length, avg_seconds: avg(bds.map((b) => b.pacing.seconds)), avg_beat_seconds: avg(bds.map((b) => b.pacing.avg_beat_seconds)), avg_cuts_per_10s: avg(bds.map((b) => b.pacing.cuts_per_10s)), total_views: null },
		};
	}

	// What this browser can check on its own; the rest runs on the user's computer.
	function browserCheck() {
		const v = document.createElement('video');
		const mp4 = v.canPlayType('video/mp4; codecs="avc1.640028, mp4a.40.2"');
		const webm = v.canPlayType('video/webm; codecs="vp9, opus"');
		let storage = false; try { localStorage.setItem('ootto.t', '1'); localStorage.removeItem('ootto.t'); storage = true; } catch {}
		const here = 'Runs on your computer: open Settings there or run npm run check.';
		const checks = [
			{ id: 'demo', label: 'Demo page', status: 'ok', detail: `Loaded with ${SAMPLE_REELS.length} sample reels and ${SAMPLE_SOURCES.length} watched reels.` },
			{ id: 'video', label: 'Video playback', status: mp4 || webm ? 'ok' : 'fail', detail: mp4 ? 'This browser plays the MP4 renders (H.264).' : webm ? 'This browser plays the WebM copies.' : 'This browser cannot play the sample videos.' },
			{ id: 'storage', label: 'Browser storage', status: storage ? 'ok' : 'warn', detail: storage ? 'Your demo changes are remembered in this browser.' : 'Storage is blocked here, so demo changes reset when you reload.' },
			{ id: 'ffmpeg', label: 'Video rendering (ffmpeg)', status: 'skip', detail: here },
			{ id: 'openai', label: 'OpenAI key', status: 'skip', detail: here },
			{ id: 'anthropic', label: 'Claude key', status: 'skip', detail: here },
			{ id: 'ytdlp', label: 'Reel downloads (yt-dlp)', status: 'skip', detail: here },
			{ id: 'instagram', label: 'Instagram account', status: 'skip', detail: here },
		];
		return { ok: !checks.some((c) => c.status === 'fail'), checks, at: new Date().toISOString() };
	}

	const realFetch = window.fetch.bind(window);
	window.fetch = async (input, init = {}) => {
		const url = new URL(typeof input === 'string' ? input : input.url, location.href);
		if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
		const method = (init.method || 'GET').toUpperCase();
		let body = {};
		try { body = typeof init.body === 'string' ? JSON.parse(init.body) : {}; } catch {}
		const parts = url.pathname.split('/').filter(Boolean); // api, kind, id, action
		await new Promise((r) => setTimeout(r, 150));
		const brandOf = (id) => db.brands.find((b) => b.id === id);

		if (url.pathname === '/api/status') {
			return json({ mode: 'demo', models: { text: 'demo', vision: 'demo', image: 'demo', voice: 'demo', transcribe: 'demo' }, providers: { text: 'mock', vision: 'mock', image: 'mock', voice: 'mock', transcribe: 'captions' }, instagram: { connected: false, userId: null, publicBaseUrl: null }, watch: { downloader: 'demo', maxSeconds: 600, uploadLimitMb: 300 }, queue: 0, watchQueue: 0 });
		}
		if (url.pathname === '/api/selftest') return json(browserCheck());

		if (parts[1] === 'settings') {
			if (method !== 'GET') return fail('Keys are never entered in this online demo, to keep them safe. Run the studio on your computer and open Settings there.', 403);
			const none = { configured: false, source: null, hint: null };
			return json({
				demo: true, canEdit: false, exposed: false, keys: { openai: none, anthropic: none },
				text: 'auto', vision: 'auto', anthropicModel: 'claude-opus-5-5', claudeModels: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'],
				active: { mode: 'mock', parts: { text: 'mock', vision: 'mock', image: 'mock', voice: 'mock', transcribe: 'captions' }, models: { text: 'mock', vision: 'mock', image: 'mock', voice: 'mock', transcribe: 'captions only' } },
				limits: { imagesPerMonth: 0, watchesPerMonth: 0 },
				usage: { month: new Date().toISOString().slice(0, 7), counts: { rendered: db.reels.length, watched: db.sources.length }, images: 0, watched: db.sources.length },
			});
		}

		// ---------- brands and weekly plans ----------
		if (url.pathname === '/api/brands') {
			if (method === 'GET') return json(db.brands);
			const website = String(body.website || '').trim(), description = String(body.description || '').trim();
			if (!website && !description) return fail('Add your website or describe your business.');
			const host = website ? shortUrl(/^https?:/.test(website) ? website : `https://${website}`).split('/')[0] : '';
			const brand = { id: rid('brand'), name: String(body.name || '').trim() || host || 'My business', website, description, audience: body.audience || '', offer: String(body.offer || '').trim(), tone: body.tone || 'friendly and expert', language: body.language || 'English', createdAt: new Date().toISOString() };
			db.brands.push(brand); save();
			return json(brand, 201);
		}
		if (parts[1] === 'brands' && parts[3] === 'week') {
			const brand = brandOf(parts[2]);
			if (!brand) return fail('Brand not found.', 404);
			const count = Math.min(7, Math.max(1, Number(body.count) || 7));
			const start = /^\d{4}-\d{2}-\d{2}$/.test(body.startDate || '') ? body.startDate : tomorrow();
			const profile = body.profileId ? db.profiles.find((p) => p.id === body.profileId) : null;
			const made = Array.from({ length: count }, (_, i) => {
				const plan = planFor(brand, i, profile);
				return newReel(brand, plan, SAMPLE_REELS[i % SAMPLE_REELS.length], { day: i, scheduledAt: at(start, i, plan.best_time), origin: profile ? { type: 'patterns', profileId: profile.id, label: profile.name } : undefined });
			});
			save();
			return json(made.map(view), 201);
		}

		// ---------- watch & remake ----------
		if (parts[1] === 'sources') {
			if (method === 'GET' && !parts[2]) return json(db.sources);
			if (parts[2] === 'upload') {
				const name = url.searchParams.get('name') || 'upload.mp4';
				const x = { id: rid('src'), url: null, name, label: name.replace(/\.[^.]+$/, ''), meta: { url: null, platform: 'Upload', title: name.replace(/\.[^.]+$/, ''), uploader: null, caption: null, views: null, likes: null, comments: null }, frames: [], cuts: [], createdAt: new Date().toISOString() };
				db.sources.unshift(x); watchSim(x);
				return json(x, 201);
			}
			if (method === 'POST' && !parts[2]) {
				const urls = [].concat(body.urls || [], body.url || []).flatMap((u) => String(u).split(/\s+/)).map((u) => u.trim()).filter(Boolean);
				if (!urls.length) return fail('Paste at least one reel link.');
				const bad = urls.find((u) => !/^https?:\/\/[^\s]+\.[^\s]+/.test(u));
				if (bad) return fail(`Not a valid link: ${bad.slice(0, 80)}`);
				const known = new Set(db.sources.map((x) => x.url));
				const fresh = [...new Set(urls)].filter((u) => !known.has(u));
				const added = fresh.map((u) => {
					const x = { id: rid('src'), url: u, name: u, label: shortUrl(u), meta: { url: u, platform: platformOf(u), title: null, uploader: null, caption: null, views: null, likes: null, comments: null }, frames: [], cuts: [], createdAt: new Date().toISOString() };
					db.sources.unshift(x); watchSim(x);
					return x;
				});
				return json({ added, skipped: urls.length - added.length }, 201);
			}
			const x = db.sources.find((v) => v.id === parts[2]);
			if (!x) return fail('Watched reel not found.', 404);
			if (method === 'GET') return json(x);
			if (method === 'DELETE') { db.sources = db.sources.filter((v) => v !== x); save(); return json({ ok: true }); }
			if (parts[3] === 'watch') { watchSim(x); return json(x); }
			if (parts[3] === 'remake') {
				if (x.status !== 'ready') return fail('Wait until the reel has been watched.');
				const brand = brandOf(body.brandId);
				if (!brand) return fail('Add or pick your business first.');
				const mode = body.mode === 'exact' ? 'exact' : 'format';
				if (mode === 'exact' && body.rightsConfirmed !== true) return fail('An exact remake reuses the original words. Confirm that this is your own reel or that you have the rights to reuse it.');
				const plan = remakePlanFor(brand, x, mode);
				const when = body.scheduledAt && !Number.isNaN(Date.parse(body.scheduledAt)) ? new Date(body.scheduledAt).toISOString() : at(tomorrow(), 0, '18:00');
				const r = newReel(brand, plan, REMAKE, { scheduledAt: when, origin: { type: 'remake', mode, sourceId: x.id, label: x.label } });
				save();
				return json(view(r), 201);
			}
			return fail('Not available in the demo.', 404);
		}
		if (parts[1] === 'patterns') {
			if (method === 'GET') return json(db.profiles);
			if (method === 'DELETE') { db.profiles = db.profiles.filter((v) => v.id !== parts[2]); save(); return json({ ok: true }); }
			const picked = [...new Set([].concat(body.sourceIds || []))].map((id) => db.sources.find((v) => v.id === id)).filter((v) => v?.status === 'ready' && v.breakdown);
			if (picked.length < 2) return fail('Pick at least 2 watched reels to compare.');
			const profile = patternsFrom(picked, body.name);
			const p = { id: rid('pat'), name: profile.name, sourceIds: picked.map((v) => v.id), profile, createdAt: new Date().toISOString() };
			db.profiles.unshift(p); save();
			return json(p, 201);
		}

		// ---------- reels ----------
		if (url.pathname === '/api/reels') {
			const list = db.reels.filter((r) => !url.searchParams.get('brandId') || r.brandId === url.searchParams.get('brandId'));
			return json(list.slice().sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)).map(view));
		}
		const r = db.reels.find((v) => v.id === parts[2]);
		if (!r) return fail('Reel not found.', 404);
		const action = parts[3];
		if (!action) return json(view(r));
		if (method !== 'POST') return fail('Not available in the demo.', 404);
		switch (action) {
			case 'approve':
				if (!r.videoUrl) return fail('Wait until the reel has rendered before approving it.');
				if (body.scheduledAt) r.scheduledAt = body.scheduledAt;
				r.status = 'approved'; r.error = null; save(); return json(view(r));
			case 'unapprove':
				r.status = 'ready'; save(); return json(view(r));
			case 'revise': {
				const fb = String(body.feedback || '').trim();
				if (!fb) return fail('Say what should change.');
				r.history = [...(r.history || []), { at: new Date().toISOString(), feedback: fb, previous: r.plan }];
				const plan = structuredClone(r.plan);
				plan.hook = `${plan.hook.replace(/ \(revised:.*\)$/, '')} (revised: ${fb.slice(0, 40)})`;
				plan.scenes[0].on_screen_text = clampWords(`Revised: ${plan.scenes[0].on_screen_text.replace(/^Revised: /, '')}`, 8);
				r.plan = plan;
				simulate(r, ['Rewriting the script', 'Recording voice 1', 'Animating scene 1', 'Adding captions'], 'rendering', () => { r.status = 'ready'; });
				return json(view(r));
			}
			case 'render':
				simulate(r, ['Animating scenes', 'Joining scenes', 'Adding captions'], 'rendering', () => { r.status = 'ready'; });
				return json(view(r));
			case 'publish':
				return fail('Instagram is not connected in this demo. In the real studio, approved reels post at their time once IG_USER_ID, IG_ACCESS_TOKEN and PUBLIC_BASE_URL are set.');
		}
		return fail('Not available in the demo.', 404);
	};

	function watchSim(x) {
		Object.assign(x, { status: 'queued', error: null });
		simulate(x, ['Downloading the reel', 'Finding the cuts', 'Taking key frames', 'Listening to the audio', 'Analysing hook, structure and pacing'], 'watching', () => Object.assign(x, finishedSource(x)));
	}

	document.addEventListener('DOMContentLoaded', () => {
		document.body.classList.add('demo');
		const style = document.createElement('style');
		style.textContent = `.demo a[href^="/api/reels/"]{display:none}.demo-bar{background:var(--ink);color:var(--bg);font-size:.86rem;padding:10px 0}.demo-bar .wrap{display:flex;gap:10px;align-items:flex-start}.demo-bar b{background:var(--accent);color:var(--accent-ink);border-radius:6px;padding:1px 8px;font-size:.72rem;letter-spacing:.08em;flex:none;margin-top:2px}`;
		document.head.append(style);
		const bar = document.createElement('div');
		bar.className = 'demo-bar';
		bar.innerHTML = '<div class="wrap"><b>DEMO</b><span></span></div>';
		bar.querySelector('span').textContent = 'Everything here works, but it is simulated in your browser: new plans, watched links and remakes reuse sample videos and a sample analysis, and no AI is called. Use How to test (bottom right) to try each feature. For real AI output, run the studio on your computer with your OpenAI or Claude key.';
		document.body.prepend(bar);
	});
})();
