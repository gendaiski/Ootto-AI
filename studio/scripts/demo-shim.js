// Demo only: answers the studio's /api requests in the browser from a pre-rendered sample week,
// so the page works without the local server. Changes are kept in this browser only.
(() => {
	const seed = window.__OOTTO_DEMO__;
	const KEY = 'ootto.demo.v2';
	let db;
	try { db = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
	if (!db || db.brand?.id !== seed.brand.id) db = structuredClone(seed);
	const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} };

	const captionText = (p) => [p.caption, (p.hashtags || []).map((h) => `#${h}`).join(' ')].filter(Boolean).join('\n\n');
	const view = (r) => ({ ...r, captionText: captionText(r.plan) });
	const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
	const fail = (msg, status = 400) => json({ error: msg }, status);
	const find = (id) => db.reels.find((r) => r.id === id);
	const clampWords = (s, n) => String(s || '').trim().split(/\s+/).slice(0, n).join(' ');

	function simulateWork(r, steps, done) {
		r.status = 'rendering'; r.progress = steps[0]; save();
		steps.slice(1).forEach((s, i) => setTimeout(() => { r.progress = s; save(); }, 700 * (i + 1)));
		setTimeout(() => { r.status = 'ready'; r.progress = ''; done?.(); save(); }, 700 * steps.length);
	}

	const realFetch = window.fetch.bind(window);
	window.fetch = async (input, init = {}) => {
		const url = new URL(typeof input === 'string' ? input : input.url, location.href);
		if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
		const method = (init.method || 'GET').toUpperCase();
		let body = {};
		try { body = typeof init.body === 'string' ? JSON.parse(init.body) : {}; } catch {}
		const parts = url.pathname.split('/').filter(Boolean); // api, reels, id, action
		await new Promise((r) => setTimeout(r, 120));

		if (url.pathname === '/api/status') return json({ mode: 'demo', models: { text: 'demo', image: 'demo', voice: 'demo' }, instagram: { connected: false, userId: null, publicBaseUrl: null }, providers: { text: 'mock', vision: 'mock', image: 'mock', voice: 'mock', transcribe: 'captions' }, watch: { downloader: null, maxSeconds: 600, uploadLimitMb: 300 }, queue: 0, watchQueue: 0 });
		if (parts[1] === 'settings') {
			if (method !== 'GET') return fail('Keys cannot be entered in this online demo. Run the studio on your computer and open Settings there.', 403);
			const none = { configured: false, source: null, hint: null };
			return json({
				demo: true, canEdit: false, exposed: false, keys: { openai: none, anthropic: none },
				text: 'auto', vision: 'auto', anthropicModel: 'claude-opus-5-5', claudeModels: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'],
				active: { mode: 'mock', parts: { text: 'mock', vision: 'mock', image: 'mock', voice: 'mock', transcribe: 'captions' }, models: { text: 'mock', vision: 'mock', image: 'mock', voice: 'mock', transcribe: 'captions only' } },
				limits: { imagesPerMonth: 0, watchesPerMonth: 0 },
				usage: { month: new Date().toISOString().slice(0, 7), counts: {}, images: 0, watched: 0 },
			});
		}
		const LOCAL = 'needs the studio running on your computer with your OpenAI key (see studio/README.md). This demo already includes three watched reels, one pattern set, a remake and a reel planned from the patterns.';
		if (parts[1] === 'sources') {
			if (method === 'GET' && !parts[2]) return json(db.sources);
			const x = db.sources.find((v) => v.id === parts[2]);
			if (method === 'GET') return x ? json(x) : fail('Watched reel not found.', 404);
			if (method === 'DELETE' && x) { db.sources = db.sources.filter((v) => v !== x); save(); return json({ ok: true }); }
			if (parts[3] === 'remake') return fail(`Remaking ${LOCAL}`);
			return fail(`Watching reels ${LOCAL}`);
		}
		if (parts[1] === 'patterns') {
			if (method === 'GET') return json(db.profiles);
			if (method === 'DELETE') { db.profiles = db.profiles.filter((v) => v.id !== parts[2]); save(); return json({ ok: true }); }
			return fail(`Finding patterns ${LOCAL}`);
		}
		if (url.pathname === '/api/brands' && method === 'GET') return json([db.brand]);
		if (parts[1] === 'brands' && method === 'POST') return fail('This demo shows a sample week. Planning new reels needs the studio running on your computer with your OpenAI key (see studio/README.md).');
		if (url.pathname === '/api/reels') return json(db.reels.slice().sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)).map(view));

		const r = find(parts[2]);
		if (!r) return fail('Reel not found.', 404);
		const action = parts[3];
		if (!action) return json(view(r));
		if (method !== 'POST') return fail('Not available in the demo.', 404);

		switch (action) {
			case 'approve':
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
				simulateWork(r, ['Rewriting the script', 'Recording voice 1', 'Animating scene 1', 'Adding captions']);
				return json(view(r));
			}
			case 'render':
				simulateWork(r, ['Animating scenes', 'Joining scenes', 'Adding captions']);
				return json(view(r));
			case 'publish':
				return fail('Instagram is not connected in this demo. In the real studio, approved reels post at their time once IG_USER_ID, IG_ACCESS_TOKEN and PUBLIC_BASE_URL are set.');
		}
		return fail('Not available in the demo.', 404);
	};

	document.addEventListener('DOMContentLoaded', () => {
		document.body.classList.add('demo');
		const style = document.createElement('style');
		style.textContent = `.demo a[href^="/api/reels/"]{display:none}.demo-bar{background:var(--ink);color:var(--bg);font-size:.86rem;padding:10px 0}.demo-bar .wrap{display:flex;gap:10px;align-items:flex-start}.demo-bar b{background:var(--accent);color:var(--accent-ink);border-radius:6px;padding:1px 8px;font-size:.72rem;letter-spacing:.08em;flex:none;margin-top:2px}`;
		document.head.append(style);
		const bar = document.createElement('div');
		bar.className = 'demo-bar';
		bar.innerHTML = '<div class="wrap"><b>DEMO</b><span></span></div>';
		bar.querySelector('span').textContent = 'A sample week rendered by the real Studio pipeline in mock mode, so images are placeholders and the voice is silent. Watch & remake shows three of these reels watched back in, their patterns, and a remake. Approve, request changes and scheduling work here. Watching new links, planning, real images and voiceover, and posting need the app running on your computer with your OpenAI key.';
		document.body.prepend(bar);
	});
})();
