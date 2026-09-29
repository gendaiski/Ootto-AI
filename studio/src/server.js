// Ootto Studio HTTP server: JSON API + static web app + rendered media.
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { getConfig, instagramReady, ROOT, WATCH_DEFAULTS } from './config.js';
import { Store } from './store.js';
import { createProvider } from './providers.js';
import { planWeek, reviseReel } from './planner.js';
import { fetchSiteText } from './brief.js';
import { Jobs } from './jobs.js';
import { captionFor } from './instagram.js';
import { isHttpUrl, downloaderVersion, uploadTarget } from './fetchvideo.js';
import { findPatterns } from './analyze.js';
import { remakePlan, exactPlan } from './remake.js';

// Local date at the reel's posting time, dayOffset days after startDate (YYYY-MM-DD).
export function scheduleFor(startDate, dayOffset, hhmm) {
	const [y, m, d] = startDate.split('-').map(Number);
	const [hh, mm] = hhmm.split(':').map(Number);
	return new Date(y, m - 1, d + dayOffset, hh, mm, 0, 0).toISOString();
}

const tomorrow = () => {
	const t = new Date(Date.now() + 86400000);
	return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};

export function createApp(cfg = getConfig(), { provider = createProvider(cfg), log = console } = {}) {
	cfg.watch = { ...WATCH_DEFAULTS, ...(cfg.watch || {}) };
	const store = new Store(cfg.dataDir);
	const jobs = new Jobs({ store, provider, cfg, log });
	const app = express();
	app.use(express.json({ limit: '1mb' }));

	const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
		log.error(`[api] ${req.method} ${req.path}:`, e.message);
		res.status(e.status || 500).json({ error: e.message });
	});
	const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
	const need = (reel) => { if (!reel) throw bad('Reel not found.', 404); return reel; };
	const view = (r) => ({ ...r, captionText: captionFor(r.plan), videoUrl: r.media?.video ? `/media/${r.id}/${r.media.video}?v=${encodeURIComponent(r.media.renderedAt)}` : null, thumbUrl: r.media?.thumb ? `/media/${r.id}/${r.media.thumb}?v=${encodeURIComponent(r.media.renderedAt)}` : null });

	app.get('/api/status', wrap(async (req, res) => res.json({
		mode: provider.name,
		models: provider.models,
		instagram: { connected: instagramReady(cfg), userId: cfg.instagram.userId ? `…${cfg.instagram.userId.slice(-4)}` : null, publicBaseUrl: cfg.instagram.publicBaseUrl || null },
		watch: { downloader: await downloaderVersion(cfg.watch), maxSeconds: cfg.watch.maxSeconds, uploadLimitMb: cfg.watch.uploadLimitMb },
		queue: jobs.queue.length + (jobs.running ? 1 : 0),
		watchQueue: jobs.watchQueue.length + (jobs.watching ? 1 : 0),
	})));

	app.get('/api/brands', (req, res) => res.json(store.brands()));

	app.post('/api/brands', wrap(async (req, res) => {
		const b = req.body || {};
		const website = String(b.website || '').trim();
		const description = String(b.description || '').trim();
		if (!website && !description) throw bad('Add your website or describe your business.');
		let site = null, siteError = null;
		if (website) {
			try { site = await fetchSiteText(website); } catch (e) { siteError = e.message; }
		}
		const brand = store.addBrand({
			id: Store.id('brand'),
			name: String(b.name || site?.title || '').trim().slice(0, 80) || 'My business',
			website, description,
			audience: String(b.audience || '').trim(), offer: String(b.offer || '').trim(),
			tone: String(b.tone || 'friendly and expert').trim(), language: String(b.language || 'English').trim(),
			site, siteError, createdAt: new Date().toISOString(),
		});
		res.status(201).json(brand);
	}));

	app.post('/api/brands/:id/week', wrap(async (req, res) => {
		const brand = store.brand(req.params.id);
		if (!brand) throw bad('Brand not found.', 404);
		const count = Math.min(7, Math.max(1, Number(req.body?.count) || 7));
		const startDate = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.startDate || '') ? req.body.startDate : tomorrow();
		const prof = req.body?.profileId ? store.profile(req.body.profileId) : null;
		if (req.body?.profileId && !prof) throw bad('Those patterns no longer exist.', 404);
		const plans = await planWeek(provider, brand, count, { profile: prof?.profile });
		const origin = prof ? { type: 'patterns', profileId: prof.id, label: prof.name } : undefined;
		const reels = plans.map((plan, i) => store.addReel({
			id: Store.id('reel'), brandId: brand.id, day: i, plan, status: 'queued', progress: 'Waiting to render',
			scheduledAt: scheduleFor(startDate, i, plan.best_time), history: [], createdAt: new Date().toISOString(), origin,
		}));
		reels.forEach((r) => jobs.enqueueRender(r.id));
		res.status(201).json(reels.map(view));
	}));

	app.get('/api/reels', (req, res) => res.json(store.reels({ brandId: req.query.brandId }).map(view)));
	app.get('/api/reels/:id', (req, res) => { const r = store.reel(req.params.id); r ? res.json(view(r)) : res.status(404).json({ error: 'Reel not found.' }); });

	app.post('/api/reels/:id/approve', wrap(async (req, res) => {
		const r = need(store.reel(req.params.id));
		if (!r.media?.video) throw bad('Wait until the reel has rendered before approving it.');
		const patch = { status: 'approved', approvedFor: JSON.stringify(r.plan), error: null };
		if (req.body?.scheduledAt && !Number.isNaN(Date.parse(req.body.scheduledAt))) patch.scheduledAt = new Date(req.body.scheduledAt).toISOString();
		res.json(view(store.updateReel(r.id, patch)));
	}));

	app.post('/api/reels/:id/unapprove', wrap(async (req, res) => {
		const r = need(store.reel(req.params.id));
		if (r.status !== 'approved') throw bad('Only approved reels can be moved back to review.');
		res.json(view(store.updateReel(r.id, { status: 'ready', approvedFor: null })));
	}));

	app.post('/api/reels/:id/revise', wrap(async (req, res) => {
		const r = need(store.reel(req.params.id));
		const feedback = String(req.body?.feedback || '').trim();
		if (!feedback) throw bad('Say what should change.');
		if (['rendering', 'posting', 'posted'].includes(r.status)) throw bad(`This reel is ${r.status}; try again after it finishes.`);
		store.updateReel(r.id, { status: 'queued', progress: 'Rewriting the script' });
		try {
			const plan = await reviseReel(provider, store.brand(r.brandId) || {}, r.plan, feedback);
			const history = [...(r.history || []), { at: new Date().toISOString(), feedback, previous: r.plan }].slice(-10);
			store.updateReel(r.id, { plan, history, approvedFor: null, scheduledAt: r.scheduledAt });
		} catch (e) {
			store.updateReel(r.id, { status: r.media ? 'ready' : 'failed', progress: '', error: e.message });
			throw e;
		}
		jobs.enqueueRender(r.id);
		res.json(view(store.reel(r.id)));
	}));

	app.post('/api/reels/:id/render', wrap(async (req, res) => {
		const r = need(store.reel(req.params.id));
		if (['rendering', 'posting'].includes(r.status)) throw bad(`This reel is already ${r.status}.`);
		jobs.enqueueRender(r.id, { force: Boolean(req.body?.regenerateMedia) });
		res.json(view(store.reel(r.id)));
	}));

	app.post('/api/reels/:id/publish', wrap(async (req, res) => {
		const r = need(store.reel(req.params.id));
		res.json(view(await jobs.publish(r.id)));
	}));

	app.get('/api/reels/:id/download', (req, res) => {
		const r = store.reel(req.params.id);
		if (!r?.media?.video) return res.status(404).json({ error: 'Not rendered yet.' });
		const safe = (r.plan.title || 'reel').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'reel';
		res.download(path.join(store.reelDir(r.id), r.media.video), `${safe}.mp4`);
	});

	// ---------- watch & remake ----------
	const needSource = (s) => { if (!s) throw bad('Watched reel not found.', 404); return s; };
	const shortUrl = (u) => { try { const x = new URL(u); return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/$/, '')}`.slice(0, 60); } catch { return u; } };
	const sourceLabel = (s) => (s.meta?.uploader ? `@${String(s.meta.uploader).replace(/^@/, '')}` : s.meta?.title || (s.url ? shortUrl(s.url) : s.name) || 'a watched reel');
	const sview = (s) => {
		const base = `/media/${s.id}/`;
		const { words, ...transcript } = s.transcript || {};
		return {
			...s, label: sourceLabel(s), transcript: s.transcript ? transcript : null,
			videoUrl: s.file && s.status === 'ready' ? `${base}${s.file}` : null,
			thumbUrl: s.frames?.[0] ? `${base}${s.frames[0].file}` : null,
			frames: (s.frames || []).map((f) => ({ ...f, url: `${base}${f.file}` })),
		};
	};
	const newSource = (fields) => store.addSource({ id: Store.id('src'), status: 'queued', progress: 'Waiting to watch', createdAt: new Date().toISOString(), ...fields });

	app.get('/api/sources', (req, res) => res.json(store.sources().map(sview)));
	app.get('/api/sources/:id', wrap(async (req, res) => res.json(sview(needSource(store.source(req.params.id))))));

	// Body: { urls: [..] } or { url }. Links already in the library are not added twice.
	app.post('/api/sources', wrap(async (req, res) => {
		const raw = [].concat(req.body?.urls || [], req.body?.url || []).flatMap((u) => String(u).split(/\s+/)).map((u) => u.trim()).filter(Boolean);
		if (!raw.length) throw bad('Paste at least one reel link.');
		const invalid = raw.filter((u) => !isHttpUrl(u));
		if (invalid.length) throw bad(`Not a valid link: ${invalid[0].slice(0, 80)}`);
		if (raw.length > 50) throw bad('Add at most 50 links at a time.');
		const known = new Set(store.sources().map((s) => s.url));
		const added = [...new Set(raw)].filter((u) => !known.has(u)).map((url) => newSource({ url, name: url }));
		added.forEach((s) => jobs.enqueueWatch(s.id));
		res.status(201).json({ added: added.map((s) => sview(store.source(s.id))), skipped: raw.length - added.length });
	}));

	// Raw video bytes in the body; ?name= keeps the original file name as the title.
	app.post('/api/sources/upload', express.raw({ type: () => true, limit: `${cfg.watch.uploadLimitMb}mb` }), wrap(async (req, res) => {
		if (!Buffer.isBuffer(req.body) || req.body.length < 1000) throw bad('Choose a video file to upload.');
		const name = String(req.query.name || 'upload.mp4').slice(0, 120);
		const s = newSource({ url: null, name, meta: { url: null, platform: 'Upload', title: name.replace(/\.[^.]+$/, ''), uploader: null, caption: null, views: null, likes: null, comments: null, uploadDate: null } });
		const file = uploadTarget(name);
		fs.writeFileSync(path.join(store.reelDir(s.id), file), req.body);
		store.updateSource(s.id, { file });
		jobs.enqueueWatch(s.id);
		res.status(201).json(sview(store.source(s.id)));
	}));

	app.post('/api/sources/:id/watch', wrap(async (req, res) => {
		const s = needSource(store.source(req.params.id));
		if (['queued', 'watching'].includes(s.status)) throw bad('This reel is already being watched.');
		jobs.enqueueWatch(s.id);
		res.json(sview(store.source(s.id)));
	}));

	app.delete('/api/sources/:id', wrap(async (req, res) => {
		const s = needSource(store.source(req.params.id));
		if (s.status === 'watching') throw bad('Wait until this reel has been watched, then remove it.');
		jobs.watchQueue = jobs.watchQueue.filter((id) => id !== s.id);
		store.removeSource(s.id);
		res.json({ ok: true });
	}));

	// mode 'format' (default): same structure and timing, new content for the brand.
	// mode 'exact': the original words and timing; requires rightsConfirmed.
	app.post('/api/sources/:id/remake', wrap(async (req, res) => {
		const s = needSource(store.source(req.params.id));
		if (s.status !== 'ready' || !s.breakdown) throw bad('Wait until the reel has been watched.');
		const brand = store.brand(req.body?.brandId);
		if (!brand) throw bad('Add or pick your business first.');
		const mode = req.body?.mode === 'exact' ? 'exact' : 'format';
		if (mode === 'exact' && req.body?.rightsConfirmed !== true) {
			throw bad('An exact remake reuses the original words. Confirm that this is your own reel or that you have the rights to reuse it.');
		}
		const plan = mode === 'exact' ? exactPlan(s) : await remakePlan(provider, brand, s);
		const when = req.body?.scheduledAt && !Number.isNaN(Date.parse(req.body.scheduledAt)) ? new Date(req.body.scheduledAt).toISOString() : scheduleFor(tomorrow(), 0, plan.best_time);
		const reel = store.addReel({
			id: Store.id('reel'), brandId: brand.id, day: 0, plan, status: 'queued', progress: 'Waiting to render',
			scheduledAt: when, history: [], createdAt: new Date().toISOString(),
			origin: { type: 'remake', mode, sourceId: s.id, label: sourceLabel(s) },
		});
		jobs.enqueueRender(reel.id);
		res.status(201).json(view(store.reel(reel.id)));
	}));

	app.get('/api/patterns', (req, res) => res.json(store.profiles()));

	app.post('/api/patterns', wrap(async (req, res) => {
		const ids = [...new Set([].concat(req.body?.sourceIds || []))];
		const sources = ids.map((id) => store.source(id)).filter((s) => s?.status === 'ready' && s.breakdown);
		if (sources.length < 2) throw bad('Pick at least 2 watched reels to compare.');
		const profile = await findPatterns(provider, sources);
		const p = store.addProfile({
			id: Store.id('pat'), name: String(req.body?.name || '').trim().slice(0, 80) || profile.name,
			sourceIds: sources.map((s) => s.id), profile, createdAt: new Date().toISOString(),
		});
		res.status(201).json(p);
	}));

	app.delete('/api/patterns/:id', wrap(async (req, res) => {
		if (!store.profile(req.params.id)) throw bad('Patterns not found.', 404);
		store.removeProfile(req.params.id);
		res.json({ ok: true });
	}));

	app.use('/media', express.static(store.mediaDir, { fallthrough: false, maxAge: '1h' }));
	app.use(express.static(path.join(ROOT, 'public')));

	return { app, store, jobs, provider, cfg };
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (isMain) {
	const ctx = createApp();
	ctx.jobs.resume();
	ctx.jobs.startScheduler();
	ctx.app.listen(ctx.cfg.port, () => {
		const mode = ctx.provider.name === 'openai' ? `OpenAI (${Object.values(ctx.provider.models).join(', ')})` : 'MOCK mode (no OPENAI_API_KEY): placeholder images, silent voice';
		downloaderVersion(ctx.cfg.watch).then((v) => console.log(`Ootto Studio on http://localhost:${ctx.cfg.port}\nContent: ${mode}\nInstagram: ${instagramReady(ctx.cfg) ? 'connected' : 'not connected (reels can still be downloaded)'}\nReel links: ${v ? `yt-dlp ${v}` : 'yt-dlp not found (install it to watch links; uploads still work)'}`));
	});
}
