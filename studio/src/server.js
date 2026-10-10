// Ootto Studio HTTP server: JSON API + static web app + rendered media.
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
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
import { Settings, meter, CLAUDE_MODELS } from './settings.js';
import { OpenAIClient } from './openai.js';
import { AnthropicClient } from './anthropic.js';
import { runSelfTest } from './selftest.js';

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

// A provider whose implementation can be replaced while the server runs (after Settings change),
// so the job queues keep their reference.
function swappable(initial) {
	let current = initial;
	return new Proxy({}, {
		get: (_, k) => (k === 'swap' ? (next) => { current = next; } : current[k]),
		has: (_, k) => k in current,
	});
}

// Loopback and not forwarded by a proxy or tunnel (a tunnel also connects from 127.0.0.1).
export function isLocalRequest(req) {
	const ip = req.socket.remoteAddress || '';
	const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
	return loopback && !req.headers['x-forwarded-for'] && !req.headers.forwarded && !req.headers['cf-connecting-ip'] && !req.headers['x-real-ip'];
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

export function createApp(cfg = getConfig(), { provider: override = null, log = console } = {}) {
	cfg.watch = { ...WATCH_DEFAULTS, ...(cfg.watch || {}) };
	const store = new Store(cfg.dataDir);
	const settings = new Settings(cfg.dataDir);
	const build = () => meter(override || createProvider(settings.apply(cfg)), store, () => settings.limits());
	const provider = swappable(build());
	// A run can ask for OpenAI or Claude for its analysis and script, whatever the Settings default.
	const providerFor = (ai) => {
		if (override || !['openai', 'anthropic'].includes(ai)) return null;
		const eff = settings.apply(cfg);
		if (eff.mock) return null;
		return meter(createProvider({ ...eff, ai: { text: ai, vision: ai } }), store, () => settings.limits());
	};
	const jobs = new Jobs({ store, provider, cfg, log, providerFor, onWatched: (id) => writeRunReel(id) });
	const app = express();

	// Health check for load balancers and Docker: open, and says nothing about the setup.
	app.get('/healthz', (req, res) => res.json({ ok: true }));

	// Optional password (HTTP Basic, any user name). /media stays open because Instagram downloads
	// the videos from there.
	if (cfg.password) {
		app.use((req, res, next) => {
			if (req.path.startsWith('/media/')) return next();
			const [type, value] = String(req.headers.authorization || '').split(' ');
			const given = type === 'Basic' ? Buffer.from(value || '', 'base64').toString().split(':').slice(1).join(':') : '';
			if (given && crypto.timingSafeEqual(sha(given), sha(cfg.password))) return next();
			res.set('WWW-Authenticate', 'Basic realm="Ootto Studio", charset="UTF-8"').status(401).send('Password required.');
		});
	}
	app.use(express.json({ limit: '1mb' }));

	const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
		log.error(`[api] ${req.method} ${req.path}:`, e.message);
		res.status(e.status || 500).json({ error: e.message });
	});
	const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
	const need = (reel) => { if (!reel) throw bad('Reel not found.', 404); return reel; };
	const view = (r) => ({ ...r, captionText: captionFor(r.plan), videoUrl: r.media?.video ? `/media/${r.id}/${r.media.video}?v=${encodeURIComponent(r.media.renderedAt)}` : null, thumbUrl: r.media?.thumb ? `/media/${r.id}/${r.media.thumb}?v=${encodeURIComponent(r.media.renderedAt)}` : null });

	app.get('/api/status', wrap(async (req, res) => res.json({
		mode: provider.mode,
		providers: provider.parts,
		models: provider.models,
		ai: (({ openai, anthropic }) => ({ openai: Boolean(openai.apiKey), anthropic: Boolean(anthropic.apiKey) }))(settings.apply(cfg)),
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

	// ---------- settings: keys, providers, usage ----------
	const canEdit = (req) => Boolean(cfg.password) || isLocalRequest(req);
	const settingsView = (req) => {
		const eff = settings.apply(cfg);
		return {
			keys: settings.keyView(cfg),
			text: eff.ai.text, vision: eff.ai.vision,
			anthropicModel: eff.anthropic.model, claudeModels: CLAUDE_MODELS,
			active: { mode: provider.mode, parts: provider.parts, models: provider.models },
			limits: settings.limits(), usage: store.usage(),
			canEdit: canEdit(req),
			exposed: Boolean(cfg.instagram.publicBaseUrl) && !cfg.password,
		};
	};
	const needEdit = (req) => {
		if (!canEdit(req)) throw bad('Settings can only be changed on the computer running the studio. To change them from elsewhere, set STUDIO_PASSWORD.', 403);
	};

	app.get('/api/settings', (req, res) => res.json(settingsView(req)));

	app.put('/api/settings', wrap(async (req, res) => {
		needEdit(req);
		try { settings.update(req.body || {}); } catch (e) { throw bad(e.message); }
		provider.swap(build());
		res.json(settingsView(req));
	}));

	// Checks a key by listing models. Uses the key in the body, or the one already configured.
	app.post('/api/settings/test', wrap(async (req, res) => {
		needEdit(req);
		const eff = settings.apply(cfg);
		const service = req.body?.service === 'anthropic' ? 'anthropic' : 'openai';
		const key = String(req.body?.key || '').trim() || eff[service].apiKey;
		if (!key) throw bad(`No ${service === 'openai' ? 'OpenAI' : 'Claude'} key to test yet.`);
		const client = service === 'openai' ? new OpenAIClient({ ...eff.openai, apiKey: key }) : new AnthropicClient({ ...eff.anthropic, apiKey: key, timeoutMs: 20_000 });
		try {
			const models = await client.check();
			res.json({ ok: true, service, models });
		} catch (e) {
			res.json({ ok: false, service, error: e.message });
		}
	}));

	// System check: ffmpeg, data folder, yt-dlp, keys, Instagram, access. Spends no credits.
	app.post('/api/selftest', wrap(async (req, res) => res.json(await runSelfTest(settings.apply(cfg)))));

	const checkWatchLimit = (adding) => {
		const { watchesPerMonth } = settings.limits();
		if (!watchesPerMonth || provider.mode !== 'live') return;
		const pending = store.sources().filter((x) => x.status === 'queued' || x.status === 'watching').length;
		if (store.usage().watched + pending + adding > watchesPerMonth) {
			throw bad(`This would pass your monthly limit of ${watchesPerMonth} watched reels. Raise it in Settings.`);
		}
	};

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
		const fresh = [...new Set(raw)].filter((u) => !known.has(u));
		checkWatchLimit(fresh.length);
		const added = fresh.map((url) => newSource({ url, name: url }));
		added.forEach((s) => jobs.enqueueWatch(s.id));
		res.status(201).json({ added: added.map((s) => sview(store.source(s.id))), skipped: raw.length - added.length });
	}));

	// Raw video bytes in the body; ?name= keeps the original file name as the title.
	app.post('/api/sources/upload', express.raw({ type: () => true, limit: `${cfg.watch.uploadLimitMb}mb` }), wrap(async (req, res) => {
		if (!Buffer.isBuffer(req.body) || req.body.length < 1000) throw bad('Choose a video file to upload.');
		checkWatchLimit(1);
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
		checkWatchLimit(1);
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

	// ---------- runs: one start point, link or upload -> watched -> new reel -> rendered ----------
	const RUN_STEPS = [
		['get', 'Get the video'], ['watch', 'Find cuts and key frames'], ['listen', 'Listen to the speech'], ['analyse', 'Analyse hook, beats and pacing'],
		['script', 'Write your version'], ['render', 'Make images, voice and video'], ['review', 'Ready for review'],
	];
	const AI_NAME = { openai: 'OpenAI', anthropic: 'Claude', auto: 'Default AI' };

	// Runs after the reel is watched: write the new reel and queue its render.
	async function writeRunReel(id) {
		const src = store.source(id);
		if (!src?.auto || src.auto.reelId) return;
		const brand = store.brand(src.auto.brandId);
		if (!brand) throw new Error('The business for this run no longer exists.');
		store.updateSource(id, { auto: { ...src.auto, stage: 'script', error: null } });
		const plan = src.auto.mode === 'exact' ? exactPlan(src) : await remakePlan(providerFor(src.auto.ai) || provider, brand, src);
		const reel = store.addReel({
			id: Store.id('reel'), brandId: brand.id, day: 0, plan, status: 'queued', progress: 'Waiting to render',
			scheduledAt: src.auto.scheduledAt || scheduleFor(tomorrow(), 0, plan.best_time), history: [], createdAt: new Date().toISOString(),
			origin: { type: 'remake', mode: src.auto.mode, sourceId: id, label: sourceLabel(src), run: true },
			autoApprove: Boolean(src.auto.autoApprove),
		});
		store.updateSource(id, { auto: { ...store.source(id).auto, stage: 'render', reelId: reel.id } });
		jobs.enqueueRender(reel.id);
	}

	const stepIndex = (x) => {
		const p = x.progress || '';
		if (/Download|Starting|Waiting/i.test(p)) return 0;
		if (/cuts|frames/i.test(p)) return 1;
		if (/Listen/i.test(p)) return 2;
		if (/Analys|Measur/i.test(p)) return 3;
		return 0;
	};
	const runView = (x) => {
		const a = x.auto;
		const reel = a.reelId ? store.reel(a.reelId) : null;
		let at = 0, state = 'active', progress = x.progress || '';
		if (x.status === 'failed') { at = x.frames?.length ? 3 : x.file ? 1 : 0; state = 'failed'; }
		else if (x.status !== 'ready') { at = stepIndex(x); }
		else if (!reel) { at = 4; state = a.stage === 'failed' ? 'failed' : 'active'; progress = a.stage === 'failed' ? '' : 'Writing your version'; }
		else if (['queued', 'rendering'].includes(reel.status)) { at = 5; progress = reel.progress || 'Rendering'; }
		else if (reel.status === 'failed') { at = 5; state = 'failed'; }
		else if (reel.status === 'ready') { at = 6; progress = 'Ready for your review'; }
		else { at = 7; state = 'done'; progress = reel.status === 'posted' ? 'Posted to Instagram' : reel.status === 'posting' ? 'Posting' : 'Approved and scheduled'; }
		if (!x.url && at === 0 && state !== 'failed') at = 1;
		const steps = RUN_STEPS.map(([id, label], i) => ({
			id, label: id === 'get' ? (x.url ? 'Download the reel' : 'Upload the video') : id === 'review' && reel && ['approved', 'posting', 'posted'].includes(reel.status) ? (reel.status === 'posted' ? 'Posted' : 'Approved and scheduled') : label,
			state: i < at ? 'done' : i === at ? state : 'todo',
		}));
		return {
			id: x.id, label: sourceLabel(x), url: x.url, createdAt: x.createdAt, thumbUrl: x.frames?.[0] ? `/media/${x.id}/${x.frames[0].file}` : null,
			ai: a.ai, aiName: AI_NAME[a.ai] || AI_NAME.auto, mode: a.mode, brandId: a.brandId, brandName: store.brand(a.brandId)?.name || '', autoApprove: Boolean(a.autoApprove),
			steps, state: state === 'failed' ? 'failed' : at >= 7 ? 'done' : at === 6 ? 'review' : 'working', progress,
			error: x.status === 'failed' ? x.error : a.stage === 'failed' ? a.error : reel?.status === 'failed' ? reel.error : null,
			beats: x.breakdown?.pacing?.beats || null, seconds: x.video?.duration || null,
			reel: reel ? view(reel) : null,
		};
	};

	// Checks shared by link and upload runs. Returns the run options.
	const runOptions = (o) => {
		const brand = store.brand(o.brandId);
		if (!brand) throw bad('Pick your business first, or add one.');
		const mode = o.mode === 'exact' ? 'exact' : 'format';
		if (mode === 'exact' && o.rightsConfirmed !== true) throw bad('An exact remake reuses the original words. Confirm that this is your own reel or that you have the rights to reuse it.');
		const ai = ['openai', 'anthropic'].includes(o.ai) ? o.ai : 'auto';
		const eff = settings.apply(cfg);
		if (!eff.mock && ai !== 'auto' && !eff[ai].apiKey) throw bad(`Add a ${AI_NAME[ai]} key in Settings first, or choose the other AI.`);
		const scheduledAt = o.scheduledAt && !Number.isNaN(Date.parse(o.scheduledAt)) ? new Date(o.scheduledAt).toISOString() : null;
		return { brandId: brand.id, mode, rightsConfirmed: mode === 'exact', ai, autoApprove: Boolean(o.autoApprove), scheduledAt, stage: 'watch', reelId: null, error: null };
	};

	app.get('/api/runs', (req, res) => res.json(store.sources().filter((x) => x.auto).map(runView)));
	app.get('/api/runs/:id', wrap(async (req, res) => {
		const x = store.source(req.params.id);
		if (!x?.auto) throw bad('Run not found.', 404);
		res.json(runView(x));
	}));

	// Body: { url, brandId, mode, rightsConfirmed, ai, autoApprove, scheduledAt }
	app.post('/api/runs', wrap(async (req, res) => {
		const b = req.body || {};
		const url = String(b.url || '').trim();
		if (!url) throw bad('Paste a reel link, or upload the video instead.');
		if (!isHttpUrl(url)) throw bad('That is not a valid link. Copy the reel link from Instagram (Share → Copy link).');
		const auto = runOptions(b);
		const known = store.sources().find((x) => x.url === url);
		if (known && ['queued', 'watching'].includes(known.status) && known.auto && !known.auto.reelId) throw bad('This reel is already being processed.');
		let x;
		if (known && known.status === 'ready') {
			// Already watched: go straight to writing the new reel.
			x = store.updateSource(known.id, { auto });
			jobs.afterWatch(x.id);
		} else if (known) {
			x = store.updateSource(known.id, { auto });
			if (!['queued', 'watching'].includes(known.status)) { checkWatchLimit(1); jobs.enqueueWatch(x.id); }
		} else {
			checkWatchLimit(1);
			x = newSource({ url, name: url, auto });
			jobs.enqueueWatch(x.id);
		}
		res.status(201).json(runView(store.source(x.id)));
	}));

	// Raw video bytes; options in the query string (name, brandId, mode, rightsConfirmed=1, ai, autoApprove=1, scheduledAt).
	app.post('/api/runs/upload', express.raw({ type: () => true, limit: `${cfg.watch.uploadLimitMb}mb` }), wrap(async (req, res) => {
		if (!Buffer.isBuffer(req.body) || req.body.length < 1000) throw bad('Choose a video file to upload.');
		const q = req.query;
		const auto = runOptions({ brandId: q.brandId, mode: q.mode, rightsConfirmed: q.rightsConfirmed === '1', ai: q.ai, autoApprove: q.autoApprove === '1', scheduledAt: q.scheduledAt });
		checkWatchLimit(1);
		const name = String(q.name || 'upload.mp4').slice(0, 120);
		const x = newSource({ url: null, name, auto, meta: { url: null, platform: 'Upload', title: name.replace(/\.[^.]+$/, ''), uploader: null, caption: null, views: null, likes: null, comments: null, uploadDate: null } });
		const file = uploadTarget(name);
		fs.writeFileSync(path.join(store.reelDir(x.id), file), req.body);
		store.updateSource(x.id, { file });
		jobs.enqueueWatch(x.id);
		res.status(201).json(runView(store.source(x.id)));
	}));

	// Try a failed run again from where it stopped.
	app.post('/api/runs/:id/retry', wrap(async (req, res) => {
		const x = store.source(req.params.id);
		if (!x?.auto) throw bad('Run not found.', 404);
		const reel = x.auto.reelId ? store.reel(x.auto.reelId) : null;
		if (x.status === 'failed') { store.updateSource(x.id, { auto: { ...x.auto, stage: 'watch', error: null } }); jobs.enqueueWatch(x.id); }
		else if (!reel) { store.updateSource(x.id, { auto: { ...x.auto, stage: 'script', error: null } }); jobs.afterWatch(x.id); }
		else if (reel.status === 'failed') jobs.enqueueRender(reel.id);
		else throw bad('This run has not failed.');
		res.json(runView(store.source(x.id)));
	}));

	app.use('/media', express.static(store.mediaDir, { fallthrough: false, maxAge: '1h' }));
	app.use(express.static(path.join(ROOT, 'public')));

	return { app, store, jobs, provider, cfg, settings };
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (isMain) {
	const cfg0 = getConfig();
	const local = ['127.0.0.1', 'localhost', '::1'].includes(cfg0.host);
	// On a server the studio holds your API keys: refuse to open it to the network without a password.
	if (!local && !cfg0.password && process.env.ALLOW_NO_PASSWORD !== '1') {
		console.error(`HOST=${cfg0.host} makes the studio reachable from other machines, but STUDIO_PASSWORD is not set.\nSet STUDIO_PASSWORD in .env (or ALLOW_NO_PASSWORD=1 on a private network) and start again.`);
		process.exit(1);
	}
	const ctx = createApp(cfg0);
	ctx.jobs.resume();
	ctx.jobs.startScheduler();
	ctx.app.listen(ctx.cfg.port, ctx.cfg.host, () => {
		const m = ctx.provider.models;
		const mode = ctx.provider.mode === 'live'
			? `scripts ${m.text}, analysis ${m.vision}, images ${m.image}, voice ${m.voice}`
			: 'MOCK mode (no API key): placeholder images, silent voice. Add a key in Settings or .env';
		if (!local && !ctx.cfg.password) console.warn(`Listening on ${ctx.cfg.host} without STUDIO_PASSWORD: anyone who can reach it can use this studio.`);
		downloaderVersion(ctx.cfg.watch).then((v) => console.log(`Ootto Studio on http://${local ? 'localhost' : ctx.cfg.host}:${ctx.cfg.port}${ctx.cfg.password ? ' (password protected)' : ''}\nContent: ${mode}\nInstagram: ${instagramReady(ctx.cfg) ? 'connected' : 'not connected (reels can still be downloaded)'}\nReel links: ${v ? `yt-dlp ${v}` : 'yt-dlp not found (install it to watch links; uploads still work)'}`));
	});
}
