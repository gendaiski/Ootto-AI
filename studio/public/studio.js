// Ootto Studio front end. Talks to the local API; renders everything with DOM APIs (no innerHTML for data).
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v == null || v === false) continue;
		if (k === 'class') n.className = v;
		else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
		else if (k === 'style') n.setAttribute('style', v);
		else n.setAttribute(k, v === true ? '' : v);
	}
	for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
	return n;
};
const kids = (...xs) => xs.flat().filter((x) => x != null && x !== false);
const svg = (d) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = d; return s; };

const state = {
	status: null, brands: [], brandId: null, reels: [], selectedId: null, busy: false,
	tab: 'plan', onboarding: false,
	sources: [], sourceId: null, picked: new Set(), profiles: [], profileId: null,
};
const BUSY = new Set(['queued', 'rendering', 'posting']);
const LABEL = { queued: 'Queued', rendering: 'Rendering', ready: 'Needs review', approved: 'Approved', posting: 'Posting', posted: 'Posted', failed: 'Failed' };
const FORMAT = { tips: 'Tips', myth_vs_fact: 'Myth vs fact', behind_the_scenes: 'Behind the scenes', customer_story: 'Customer story', how_to: 'How-to', offer: 'Offer', faq: 'FAQ', remake: 'Remake' };

async function api(path, opts = {}) {
	const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
	return data;
}

let toastTimer;
function toast(msg, err = false) {
	const t = $('#toast');
	t.textContent = msg; t.className = `toast${err ? ' err' : ''}`; t.hidden = false;
	clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), err ? 6000 : 3000);
}

const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short' });
const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const fmtTime = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const localInput = (iso) => { const d = new Date(iso); return `${isoDay(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// ---------- status ----------
function renderStatus() {
	const s = state.status; const box = $('#status'); box.replaceChildren();
	if (!s) return;
	const live = s.mode === 'openai';
	const label = live ? 'OpenAI connected' : s.mode === 'demo' ? 'Demo data' : 'Mock mode';
	box.append(el('span', { class: `pill ${live ? 'ok' : 'warn'}`, title: live ? `Script: ${s.models.text} · Images: ${s.models.image} · Voice: ${s.models.voice}` : 'No OPENAI_API_KEY set: placeholder images and silent voice' }, label));
	box.append(el('span', { class: `pill ${s.instagram.connected ? 'ok' : 'off'}`, title: s.instagram.connected ? `Posting as account ${s.instagram.userId}` : 'Set IG_USER_ID, IG_ACCESS_TOKEN and PUBLIC_BASE_URL to post automatically' }, s.instagram.connected ? 'Instagram connected' : 'Instagram not connected'));
}

// ---------- brands ----------
function renderBrandPicker() {
	const pick = $('#brand-pick'); const sel = $('#brand-select');
	pick.hidden = state.brands.length === 0;
	sel.replaceChildren(...state.brands.map((b) => el('option', { value: b.id, selected: b.id === state.brandId }, b.name)));
}

// Which main view shows: the Plan tab (onboarding or the week) or the Watch tab.
function applyView() {
	const plan = state.tab === 'plan';
	$('#watch').hidden = plan;
	$('#onboard').hidden = !plan || !(state.onboarding || !state.brands.length);
	$('#workspace').hidden = !plan || !$('#onboard').hidden || !state.brandId;
	for (const b of document.querySelectorAll('.tab')) b.setAttribute('aria-current', b.dataset.tab === state.tab ? 'page' : 'false');
}

function setTab(tab) {
	state.tab = tab === 'watch' ? 'watch' : 'plan';
	try { localStorage.setItem('ootto.tab', state.tab); } catch {}
	applyView();
	if (state.tab === 'watch') renderWatch();
}

function showOnboarding(show) {
	state.onboarding = show;
	if (show) state.tab = 'plan';
	applyView();
	if (show) setTimeout(() => $('#f-website').focus(), 50);
}

// ---------- week strip ----------
function renderWeek() {
	const week = $('#week'); week.replaceChildren();
	const brand = state.brands.find((b) => b.id === state.brandId);
	$('#ws-title').textContent = brand ? brand.name : 'Your reels';
	const counts = state.reels.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
	$('#ws-eyebrow').textContent = state.reels.length
		? `${state.reels.length} reels · ${counts.approved || 0} approved · ${counts.ready || 0} to review${counts.posted ? ` · ${counts.posted} posted` : ''}`
		: 'No reels yet';
	if (!state.reels.length) {
		week.append(el('li', { class: 'card empty', style: 'grid-column:1/-1' }, 'Plan your first reels with the button above.'));
		return;
	}
	for (const r of state.reels) {
		const busy = BUSY.has(r.status);
		const thumb = el('div', { class: 'thumb', style: r.thumbUrl ? `background-image:url("${r.thumbUrl}")` : null });
		if (busy) thumb.append(el('div', { class: 'spin' }, el('div', { class: 'spinner' })));
		week.append(el('li', {}, el('button', {
			class: 'day-btn', type: 'button', 'aria-current': r.id === state.selectedId ? 'true' : 'false',
			onclick: () => select(r.id),
		},
			el('div', { class: 'day-top' }, el('b', {}, fmtDay(r.scheduledAt)), el('span', {}, fmtDate(r.scheduledAt))),
			el('div', { class: 'day-when' }, fmtTime(r.scheduledAt)),
			thumb,
			el('div', { class: 'day-title' }, r.plan.title),
			el('span', { class: `tag ${busy ? 'busy' : r.status}` }, busy ? (r.progress || LABEL[r.status]) : LABEL[r.status] || r.status),
		)));
	}
}

// ---------- review ----------
function selected() { return state.reels.find((r) => r.id === state.selectedId); }

function select(id) {
	state.selectedId = id;
	renderWeek(); renderStage(); renderDetail();
}

function nextToReview(afterId) {
	const list = state.reels;
	const start = Math.max(0, list.findIndex((r) => r.id === afterId));
	for (let i = 1; i <= list.length; i++) {
		const r = list[(start + i) % list.length];
		if (r.status === 'ready') return r.id;
	}
	return afterId;
}

let shownVideo = null;
function renderStage() {
	const r = selected(); const screen = $('#screen');
	const canDecide = r && r.status === 'ready';
	$('#btn-approve').disabled = !canDecide;
	$('#btn-change').disabled = !r || BUSY.has(r.status) || r.status === 'posted';
	if (!r) { shownVideo = null; screen.replaceChildren(el('div', { class: 'msg' }, 'Pick a reel from the week.')); return; }
	if (r.videoUrl && !BUSY.has(r.status)) {
		if (shownVideo === r.videoUrl) return;
		shownVideo = r.videoUrl;
		// MP4 (H.264, what Instagram gets) first; an optional WebM copy for browsers without H.264.
		screen.replaceChildren(el('video', { poster: r.thumbUrl, controls: true, playsinline: true, loop: true, preload: 'metadata', 'aria-label': `Preview of ${r.plan.title}` },
			el('source', { src: r.videoUrl, type: 'video/mp4' }),
			r.videoWebmUrl ? el('source', { src: r.videoWebmUrl, type: 'video/webm' }) : null));
		return;
	}
	shownVideo = null;
	if (r.status === 'failed') { screen.replaceChildren(el('div', { class: 'msg' }, 'Rendering failed.', el('small', {}, 'See the error on the right, then try Re-render.'))); return; }
	screen.replaceChildren(el('div', { class: 'msg' }, el('div', { class: 'spinner' }), r.progress || LABEL[r.status] || 'Working'));
}

function field(title, ...kids) { return el('section', { class: 'block' }, el('h3', {}, title), ...kids); }

function renderDetail() {
	const d = $('#detail'); const r = selected();
	if (!r) { d.replaceChildren(el('div', { class: 'empty' }, 'Nothing selected.')); return; }
	const busy = BUSY.has(r.status);
	const p = r.plan;
	const igReady = state.status?.instagram.connected;

	const head = el('div', { class: 'detail-head' },
		el('div', {},
			el('h2', {}, p.title),
			el('div', { class: 'meta' },
				el('span', { class: `tag ${busy ? 'busy' : r.status}` }, LABEL[r.status] || r.status),
				el('span', {}, FORMAT[p.format] || p.format),
				r.media?.duration ? el('span', {}, `${r.media.duration.toFixed(1)} s`) : null,
				el('span', {}, `${p.scenes.length} scenes`),
				r.origin?.type === 'remake' ? el('span', { class: 'origin' }, `Remake of ${r.origin.label}${r.origin.mode === 'exact' ? ' · exact' : ' · same format'}`) : null,
				r.origin?.type === 'patterns' ? el('span', { class: 'origin' }, `From patterns: ${r.origin.label}`) : null,
			),
		),
	);

	const schedule = el('input', { type: 'datetime-local', id: 'sched', value: localInput(r.scheduledAt), 'aria-label': 'Posting time', disabled: r.status === 'posted' || busy });
	const when = el('div', { class: 'when' },
		schedule,
		r.status === 'approved' ? el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => act(r, 'approve', { scheduledAt: new Date(schedule.value).toISOString() }, 'Posting time saved') }, 'Save time') : null,
		el('span', { class: 'hint' }, r.status === 'posted' ? `Posted ${fmtDate(r.ig.postedAt)} ${fmtTime(r.ig.postedAt)}` : igReady ? 'Posts automatically when approved.' : 'Connect Instagram to post automatically, or download and post it yourself.'),
	);

	const actions = el('div', { class: 'actions' },
		r.videoUrl ? el('a', { class: 'btn btn-ink btn-sm', href: `/api/reels/${r.id}/download` }, 'Download MP4') : null,
		el('button', { class: 'btn btn-ghost btn-sm', type: 'button', disabled: busy || r.status === 'posted', onclick: () => act(r, 'render', {}, 'Re-rendering') }, 'Re-render'),
		el('button', { class: 'btn btn-ghost btn-sm', type: 'button', disabled: busy || r.status === 'posted', title: 'Create new images and voice for every scene (uses OpenAI credits)', onclick: () => act(r, 'render', { regenerateMedia: true }, 'Making new images and voice') }, 'New images & voice'),
		r.status === 'approved' ? el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => act(r, 'unapprove', {}, 'Moved back to review') }, 'Back to review') : null,
		el('button', { class: 'btn btn-accent btn-sm', type: 'button', disabled: !igReady || !r.videoUrl || busy || r.status === 'posted', title: igReady ? 'Post to Instagram now' : 'Instagram is not connected', onclick: () => { if (confirmPost(r)) act(r, 'publish', {}, 'Posted to Instagram'); } }, 'Post now'),
	);

	const copyBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: async () => {
		try { await navigator.clipboard.writeText(r.captionText); toast('Caption copied'); } catch { toast('Copy failed. Select the text instead.', true); }
	} }, 'Copy caption');

	d.replaceChildren(...kids(
		head,
		busy ? el('div', { class: 'progress' }, el('div', { class: 'spinner' }), r.progress || LABEL[r.status]) : null,
		r.error ? el('div', { class: 'error' }, r.error) : null,
		field('Posting time', when),
		field('Hook', el('p', { class: 'hook' }, p.hook)),
		field('Scenes', el('ol', { class: 'scenes' }, p.scenes.map((s, i) => {
			const dur = r.media?.scenes?.[i]?.duration;
			return el('li', { class: 'scene' },
				el('div', { class: 'n' }, `SCENE ${i + 1}`, el('span', {}, `${(dur ?? s.seconds).toFixed(1)} s`)),
				el('div', {}, el('div', { class: 'ost' }, s.on_screen_text), el('p', { class: 'vo' }, `“${s.voiceover}”`), el('div', { class: 'vis' }, `Visual: ${s.visual}`)),
			);
		}))),
		field('Caption', el('pre', { class: 'caption' }, r.captionText), el('div', { class: 'actions', style: 'margin-top:8px' }, copyBtn)),
		p.cta ? field('Call to action', el('p', { style: 'margin:0' }, p.cta)) : null,
		r.history?.length ? field('Change requests', el('ul', { style: 'margin:0;padding-left:18px' }, r.history.map((h) => el('li', {}, `${fmtDate(h.at)}: ${h.feedback}`)))) : null,
		actions,
	));
}

function confirmPost(r) {
	return window.confirm(`Post "${r.plan.title}" to Instagram now?`);
}

async function act(r, action, body, okMsg) {
	try {
		const updated = await api(`/api/reels/${r.id}/${action}`, { method: 'POST', body });
		merge(updated);
		toast(okMsg);
	} catch (e) { toast(e.message, true); }
	await refresh();
}

function merge(reel) {
	const i = state.reels.findIndex((x) => x.id === reel.id);
	if (i >= 0) state.reels[i] = reel; else state.reels.push(reel);
	renderWeek(); renderStage(); renderDetail();
}

async function approve() {
	const r = selected(); if (!r || r.status !== 'ready') return;
	try {
		merge(await api(`/api/reels/${r.id}/approve`, { method: 'POST', body: { scheduledAt: new Date($('#sched')?.value || r.scheduledAt).toISOString() } }));
		toast(`Approved: ${r.plan.title}`);
		select(nextToReview(r.id));
	} catch (e) { toast(e.message, true); }
}

function requestChanges() {
	const r = selected(); if (!r || BUSY.has(r.status) || r.status === 'posted') return;
	$('#fb-text').value = '';
	$('#fb-dialog').showModal();
	$('#fb-text').focus();
}

$('#fb-chips').addEventListener('click', (e) => {
	if (!e.target.matches('.chip')) return;
	const t = $('#fb-text'); t.value = t.value ? `${t.value.trim()}. ${e.target.textContent}` : e.target.textContent; t.focus();
});
$('#fb-dialog').addEventListener('close', async () => {
	if ($('#fb-dialog').returnValue !== 'send') return;
	const r = selected(); const feedback = $('#fb-text').value.trim();
	if (!r || !feedback) { if (!feedback) toast('Write what should change first.', true); return; }
	toast('Rewriting the reel…');
	try { merge(await api(`/api/reels/${r.id}/revise`, { method: 'POST', body: { feedback } })); } catch (e) { toast(e.message, true); }
	refresh();
});

$('#btn-approve').addEventListener('click', approve);
$('#btn-change').addEventListener('click', requestChanges);
document.addEventListener('keydown', (e) => {
	if (state.tab !== 'plan' || $('#fb-dialog').open || $('#remake-dialog').open || e.target.closest('input, textarea, select, video')) return;
	if (e.key === 'ArrowRight') { e.preventDefault(); approve(); }
	if (e.key === 'ArrowLeft') { e.preventDefault(); requestChanges(); }
});

// ---------- planning ----------
function setBusy(btn, on, label) { btn.disabled = on; if (label) btn.textContent = label; }

$('#brand-form').addEventListener('submit', async (e) => {
	e.preventDefault();
	const f = new FormData(e.target); const body = Object.fromEntries(f.entries());
	const msg = $('#form-msg'); msg.className = 'form-msg';
	if (!body.website && !body.description) { msg.textContent = 'Add your website or a short description.'; msg.className = 'form-msg err'; return; }
	const btn = $('#plan-btn');
	try {
		setBusy(btn, true, 'Reading your business…');
		msg.textContent = body.website ? 'Reading the website and writing scripts. This takes about a minute.' : 'Writing scripts. This takes about a minute.';
		const brand = await api('/api/brands', { method: 'POST', body });
		if (brand.siteError) toast(`Could not read the website (${brand.siteError}). Using your description instead.`, true);
		state.brands.push(brand); state.brandId = brand.id;
		setBusy(btn, true, 'Writing the week…');
		await api(`/api/brands/${brand.id}/week`, { method: 'POST', body: { count: Number(body.count), startDate: body.startDate } });
		e.target.reset(); msg.textContent = '';
		$('#f-start').value = isoDay(new Date(Date.now() + 86400000));
		state.onboarding = false;
		await refresh(true);
		applyView();
	} catch (err) {
		msg.textContent = err.message; msg.className = 'form-msg err';
	} finally { setBusy(btn, false, 'Plan my week'); }
});

$('#more-form').addEventListener('submit', async (e) => {
	e.preventDefault();
	const btn = $('#more-btn');
	try {
		setBusy(btn, true, 'Writing…');
		await api(`/api/brands/${state.brandId}/week`, { method: 'POST', body: { count: Number($('#more-count').value), startDate: $('#more-start').value } });
		toast('New reels planned. Rendering now.');
		await refresh(true);
	} catch (err) { toast(err.message, true); } finally { setBusy(btn, false, 'Plan more reels'); }
});

$('#brand-select').addEventListener('change', (e) => { state.brandId = e.target.value; state.selectedId = null; try { localStorage.setItem('ootto.brand', state.brandId); } catch {} refresh(true); });
$('#new-brand').addEventListener('click', () => showOnboarding(true));

// ---------- watch & remake ----------
const SBUSY = new Set(['queued', 'watching']);
const SLABEL = { queued: 'Queued', watching: 'Watching', ready: 'Watched', failed: 'Failed' };
const words = (s) => String(s || '').replace(/_/g, ' ');
const cap = (s) => { const w = words(s); return w.charAt(0).toUpperCase() + w.slice(1); };
const purpose = (p) => (p === 'cta' ? 'CTA' : cap(p));
const HOOK = { question: 'Question', bold_claim: 'Bold claim', number_or_stat: 'Number or stat', mistake_warning: 'Mistake warning', curiosity_gap: 'Curiosity gap', how_to_promise: 'How-to promise', list_promise: 'List promise', story_open: 'Story opener', contrarian: 'Contrarian', pov: 'POV', before_after: 'Before / after', other: 'Other' };
const secs = (n) => `${Number(n).toFixed(1)} s`;
const compact = (n) => (n == null ? null : Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n));

function selectedSource() { return state.sources.find((x) => x.id === state.sourceId); }

function renderWatch() {
	const st = state.status;
	const hint = $('#w-hint');
	const parts = [];
	if (st?.watch) {
		parts.push(st.watch.downloader
			? `Links are downloaded with yt-dlp ${st.watch.downloader}. Instagram sometimes needs a login: set YTDLP_COOKIES_FROM_BROWSER in .env, or upload the file.`
			: st.mode === 'demo' ? 'This demo shows reels watched earlier. Watching new links needs the studio running on your computer.'
			: 'yt-dlp is not installed, so links cannot be downloaded yet (pip install yt-dlp). Uploading a video works.');
		parts.push(`Up to ${Math.round(st.watch.maxSeconds / 60)} min per video.`);
	}
	if (st?.mode === 'mock') parts.push('Mock mode: cuts, pacing and frames are measured; add an OpenAI key to read the text, visuals and speech.');
	hint.textContent = parts.join(' ');
	const ready = state.sources.filter((x) => x.status === 'ready').length;
	$('#w-eyebrow').textContent = state.sources.length ? `${state.sources.length} watched · ${ready} analysed · ${state.profiles.length} pattern set${state.profiles.length === 1 ? '' : 's'}` : 'Learn from reels that work';
	renderLibrary(); renderSourceStage(); renderSourceDetail(); renderProfiles();
}

function renderLibrary() {
	const list = $('#library');
	const n = state.picked.size;
	const cmp = $('#w-compare');
	cmp.disabled = n < 2;
	cmp.textContent = n ? `Find patterns in ${n} reels` : 'Find patterns';
	if (!state.sources.length) { list.replaceChildren(el('li', { class: 'card empty', style: 'grid-column:1/-1' }, 'No reels yet. Paste a link above or upload a video.')); return; }
	list.replaceChildren(...state.sources.map((x) => {
		const busy = SBUSY.has(x.status);
		const thumb = el('div', { class: 'thumb', style: x.thumbUrl ? `background-image:url("${x.thumbUrl}")` : null });
		if (busy) thumb.append(el('div', { class: 'spin' }, el('div', { class: 'spinner' })));
		const facts = [x.video?.duration ? secs(x.video.duration) : null, x.meta?.views != null ? `${compact(x.meta.views)} views` : null].filter(Boolean).join(' · ');
		return el('li', { class: 'lib-item' },
			el('button', { class: 'day-btn', type: 'button', 'aria-current': x.id === state.sourceId ? 'true' : 'false', onclick: () => { state.sourceId = x.id; renderWatch(); } },
				thumb,
				el('div', { class: 'day-title' }, x.label),
				facts ? el('div', { class: 'day-when' }, facts) : null,
				el('span', { class: `tag ${busy ? 'busy' : x.status === 'ready' ? 'approved' : x.status}` }, busy ? (x.progress || SLABEL[x.status]) : SLABEL[x.status] || x.status),
			),
			x.status === 'ready' ? el('label', { class: 'pick' }, el('input', { type: 'checkbox', checked: state.picked.has(x.id), onchange: (e) => { e.target.checked ? state.picked.add(x.id) : state.picked.delete(x.id); renderLibrary(); } }), 'Compare') : null,
		);
	}));
}

let shownSourceVideo = null;
function renderSourceStage() {
	const x = selectedSource(); const screen = $('#w-screen');
	if (!x) { shownSourceVideo = null; screen.replaceChildren(el('div', { class: 'msg' }, 'Watched reels play here.')); return; }
	if (x.videoUrl) {
		if (shownSourceVideo === x.videoUrl) return;
		shownSourceVideo = x.videoUrl;
		screen.replaceChildren(el('video', { id: 'w-video', poster: x.thumbUrl, controls: true, playsinline: true, preload: 'metadata', 'aria-label': `Watched reel: ${x.label}` },
			el('source', { src: x.videoUrl, type: 'video/mp4' }),
			x.videoWebmUrl ? el('source', { src: x.videoWebmUrl, type: 'video/webm' }) : null));
		return;
	}
	shownSourceVideo = null;
	if (x.status === 'failed') { screen.replaceChildren(el('div', { class: 'msg' }, 'Could not watch this one.', el('small', {}, 'See the reason on the right.'))); return; }
	screen.replaceChildren(el('div', { class: 'msg' }, el('div', { class: 'spinner' }), x.progress || SLABEL[x.status]));
}

function seek(t) {
	const v = $('#w-video'); if (!v) return;
	const go = () => { v.currentTime = t; v.play().catch(() => {}); };
	if (v.readyState >= 1) go(); else { v.addEventListener('loadedmetadata', go, { once: true }); v.load(); }
}

function frameAt(x, t) {
	const fr = x.frames || [];
	return fr.find((f) => f.t >= t) || fr.at(-1);
}

function stat(label, value) { return el('div', { class: 'stat' }, el('b', {}, value), el('span', {}, label)); }

function renderSourceDetail() {
	const d = $('#w-detail'); const x = selectedSource();
	if (!x) { d.replaceChildren(el('div', { class: 'empty' }, 'Watch a reel to see its breakdown here.')); return; }
	const busy = SBUSY.has(x.status);
	const b = x.breakdown;
	const m = x.meta || {};
	const head = el('div', { class: 'detail-head' }, el('div', {},
		el('h2', {}, m.title || x.label),
		el('div', { class: 'meta' },
			el('span', { class: `tag ${busy ? 'busy' : x.status === 'ready' ? 'approved' : x.status}` }, SLABEL[x.status] || x.status),
			m.platform ? el('span', {}, m.platform) : null,
			m.uploader ? el('span', {}, `@${String(m.uploader).replace(/^@/, '')}`) : null,
			m.views != null ? el('span', {}, `${compact(m.views)} views`) : null,
			m.likes != null ? el('span', {}, `${compact(m.likes)} likes`) : null,
			m.url ? el('a', { href: m.url, target: '_blank', rel: 'noopener' }, 'Open original') : null,
		)));
	const actions = el('div', { class: 'actions' },
		el('button', { class: 'btn btn-accent btn-sm', type: 'button', disabled: x.status !== 'ready', onclick: () => openRemake(x) }, 'Remake for my business'),
		el('button', { class: 'btn btn-ghost btn-sm', type: 'button', disabled: busy, onclick: () => sourceAct(x, 'watch', 'POST', 'Watching again') }, 'Watch again'),
		el('button', { class: 'btn btn-ghost btn-sm', type: 'button', disabled: x.status === 'watching', onclick: () => { if (confirm('Remove this reel from the library?')) sourceAct(x, '', 'DELETE', 'Removed'); } }, 'Remove'),
	);
	if (!b) {
		d.replaceChildren(...kids(head, busy ? el('div', { class: 'progress' }, el('div', { class: 'spinner' }), x.progress || SLABEL[x.status]) : null, x.error ? el('div', { class: 'error' }, x.error) : null, x.url ? field('Link', el('p', { class: 'mono' }, x.url)) : null, actions));
		return;
	}
	const total = b.pacing.seconds || 1;
	const timeline = el('div', { class: 'timeline', role: 'list', 'aria-label': 'Beats' }, b.beats.map((bt, i) => el('button', {
		class: `seg p-${bt.purpose}`, type: 'button', role: 'listitem', style: `flex:${Math.max(0.2, bt.end - bt.start)}`,
		title: `${i + 1}. ${purpose(bt.purpose)} · ${secs(bt.start)}–${secs(bt.end)}`, 'aria-label': `Beat ${i + 1}, ${purpose(bt.purpose)}, from ${secs(bt.start)}`, onclick: () => seek(bt.start),
	})));
	const beatList = el('ol', { class: 'beats' }, b.beats.map((bt, i) => {
		const f = frameAt(x, bt.start);
		return el('li', {}, el('button', { class: 'beat', type: 'button', onclick: () => seek(bt.start) },
			f ? el('img', { src: f.url, alt: '', loading: 'lazy' }) : el('span', { class: 'noimg' }),
			el('div', { class: 'beat-body' },
				el('div', { class: 'beat-top' }, el('span', { class: `dot p-${bt.purpose}` }), el('b', {}, purpose(bt.purpose)), el('span', {}, `${secs(bt.start)} – ${secs(bt.end)}`), el('span', {}, cap(bt.shot))),
				bt.on_screen_text ? el('div', { class: 'ost' }, bt.on_screen_text) : null,
				bt.spoken ? el('p', { class: 'vo' }, `“${bt.spoken}”`) : null,
				bt.visual ? el('div', { class: 'vis' }, bt.visual) : null,
			)));
	}));
	d.replaceChildren(...kids(
		head,
		busy ? el('div', { class: 'progress' }, el('div', { class: 'spinner' }), x.progress || SLABEL[x.status]) : null,
		x.error ? el('div', { class: 'error' }, x.error) : null,
		(x.warnings || []).map((w) => el('div', { class: 'note' }, w)),
		b.summary ? el('p', { class: 'lede', style: 'margin:0' }, b.summary) : null,
		el('div', { class: 'stats' },
			stat('Length', secs(b.pacing.seconds)), stat('Beats', b.pacing.beats), stat('Avg beat', secs(b.pacing.avg_beat_seconds)),
			stat('Cuts / 10 s', b.pacing.cuts_per_10s), stat('Format', cap(b.format)), stat('Text', cap(b.layout.text_position))),
		field('Hook', el('div', { class: 'hookbox' },
			el('div', { class: 'meta', style: 'margin:0 0 6px' }, el('span', { class: 'tag approved' }, HOOK[b.hook.type] || words(b.hook.type)), el('span', {}, `first ${secs(b.hook.seconds)}`)),
			b.hook.on_screen_text ? el('p', { class: 'hook' }, b.hook.on_screen_text) : null,
			b.hook.spoken ? el('p', { class: 'vo' }, `“${b.hook.spoken}”`) : null,
			b.hook.why_it_works ? el('p', { class: 'why' }, b.hook.why_it_works) : null)),
		field('Structure', timeline, el('div', { class: 'legend' }, [...new Set(b.beats.map((bt) => bt.purpose))].map((p) => el('span', {}, el('span', { class: `dot p-${p}` }), purpose(p)))), beatList),
		b.pacing.notes ? field('Pacing', el('p', { style: 'margin:0' }, b.pacing.notes)) : null,
		b.layout.caption_style || b.layout.framing ? field('Visual layout', el('ul', { class: 'plain' }, [
			b.layout.caption_style && `Text: ${b.layout.caption_style}`, b.layout.framing && `Framing: ${b.layout.framing}`, b.layout.colors && `Look: ${b.layout.colors}`,
			b.audio.music && `Music: ${b.audio.music}`, b.audio.notes && `Sound: ${b.audio.notes}`,
		].filter(Boolean).map((t) => el('li', {}, t)))) : null,
		b.why_it_works.length ? field('Why it works', el('ul', { class: 'plain' }, b.why_it_works.map((t) => el('li', {}, t)))) : null,
		b.template ? field('Reusable template', el('pre', { class: 'caption' }, b.template)) : null,
		x.transcript?.text ? el('details', { class: 'more-box' }, el('summary', {}, `Transcript (${x.transcript.source === 'openai' ? 'OpenAI' : x.transcript.source})`), el('p', {}, x.transcript.text)) : null,
		m.caption ? el('details', { class: 'more-box' }, el('summary', {}, 'Post caption'), el('pre', { class: 'caption' }, m.caption)) : null,
		el('p', { class: 'hint' }, `Analysed with ${x.analyzedWith || 'the studio'} · ${x.frames.length} key frames · ${x.cuts.length} cuts measured`),
		actions,
	));
}

async function sourceAct(x, action, method, okMsg) {
	try {
		await api(`/api/sources/${x.id}${action ? `/${action}` : ''}`, { method });
		toast(okMsg);
	} catch (e) { toast(e.message, true); }
	await refresh();
}

$('#watch-form').addEventListener('submit', async (e) => {
	e.preventDefault();
	const urls = $('#w-urls').value.split(/\s+/).map((u) => u.trim()).filter(Boolean);
	const msg = $('#w-msg'); msg.className = 'form-msg';
	if (!urls.length) { msg.textContent = 'Paste at least one link.'; msg.className = 'form-msg err'; return; }
	const btn = $('#w-go');
	try {
		setBusy(btn, true, 'Adding…');
		const out = await api('/api/sources', { method: 'POST', body: { urls } });
		$('#w-urls').value = '';
		msg.textContent = `Watching ${out.added.length} reel${out.added.length === 1 ? '' : 's'}${out.skipped ? ` (${out.skipped} already in the library)` : ''}.`;
		if (out.added[0]) state.sourceId = out.added[0].id;
		await refresh();
	} catch (err) { msg.textContent = err.message; msg.className = 'form-msg err'; } finally { setBusy(btn, false, 'Watch'); }
});

$('#w-file').addEventListener('change', async (e) => {
	const file = e.target.files?.[0]; if (!file) return;
	const msg = $('#w-msg'); msg.className = 'form-msg'; msg.textContent = `Uploading ${file.name}…`;
	try {
		const res = await fetch(`/api/sources/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
		msg.textContent = `Watching ${file.name}.`;
		state.sourceId = data.id;
		await refresh();
	} catch (err) { msg.textContent = err.message; msg.className = 'form-msg err'; }
	e.target.value = '';
});

$('#w-compare').addEventListener('click', async () => {
	const btn = $('#w-compare');
	try {
		setBusy(btn, true, 'Comparing…');
		const p = await api('/api/patterns', { method: 'POST', body: { sourceIds: [...state.picked] } });
		state.picked.clear(); state.profileId = p.id;
		toast('Patterns found');
		await refresh();
		$('#pat-head').scrollIntoView({ behavior: 'smooth', block: 'start' });
	} catch (err) { toast(err.message, true); setBusy(btn, false); renderLibrary(); }
});

// ---------- remake dialog ----------
let remakeSource = null;
function openRemake(x) {
	if (!state.brands.length) { toast('Add your business first, then remake reels for it.', true); showOnboarding(true); return; }
	remakeSource = x;
	$('#rm-from').textContent = `From ${x.label}: ${x.breakdown.pacing.beats} beats, ${secs(x.breakdown.pacing.seconds)}.`;
	$('#rm-brand').replaceChildren(...state.brands.map((b) => el('option', { value: b.id, selected: b.id === state.brandId }, b.name)));
	document.querySelector('input[name="rm-mode"][value="format"]').checked = true;
	$('#rm-rights').checked = false; $('#rm-rights-row').hidden = true;
	const d = new Date(Date.now() + 86400000); d.setHours(18, 0, 0, 0);
	$('#rm-when').value = localInput(d.toISOString());
	$('#remake-dialog').showModal();
}
$('#remake-form').addEventListener('change', () => { $('#rm-rights-row').hidden = document.querySelector('input[name="rm-mode"]:checked').value !== 'exact'; $('#rm-rights-row').classList.remove('need'); });
$('#rm-send').addEventListener('click', (e) => {
	if (document.querySelector('input[name="rm-mode"]:checked').value === 'exact' && !$('#rm-rights').checked) {
		e.preventDefault(); $('#rm-rights-row').classList.add('need'); $('#rm-rights').focus();
	}
});
$('#remake-dialog').addEventListener('close', async () => {
	if ($('#remake-dialog').returnValue !== 'send' || !remakeSource) return;
	const mode = document.querySelector('input[name="rm-mode"]:checked').value;
	const brandId = $('#rm-brand').value;
	toast(mode === 'exact' ? 'Setting up the exact remake…' : 'Writing the remake…');
	try {
		const when = $('#rm-when').value ? new Date($('#rm-when').value).toISOString() : undefined;
		const reel = await api(`/api/sources/${remakeSource.id}/remake`, { method: 'POST', body: { brandId, mode, rightsConfirmed: mode === 'exact' ? true : undefined, scheduledAt: when } });
		state.brandId = brandId; state.selectedId = reel.id;
		try { localStorage.setItem('ootto.brand', brandId); } catch {}
		toast('Remake created. Rendering now.');
		setTab('plan');
		await refresh();
		select(reel.id);
	} catch (e) { toast(e.message, true); }
});

// ---------- patterns ----------
function renderProfiles() {
	const list = $('#profiles');
	if (!state.profiles.length) { list.replaceChildren(el('li', { class: 'card empty' }, 'No patterns yet. Compare two or more watched reels to find what they share.')); return; }
	list.replaceChildren(...state.profiles.map((pr) => {
		const p = pr.profile; const open = pr.id === state.profileId;
		const m = p.measured || {};
		const count = el('select', { 'aria-label': 'How many reels' }, [3, 5, 7].map((n) => el('option', { selected: n === 5 }, String(n))));
		return el('li', { class: `card profile${open ? ' open' : ''}` },
			el('button', { class: 'profile-head', type: 'button', 'aria-expanded': open ? 'true' : 'false', onclick: () => { state.profileId = open ? null : pr.id; renderProfiles(); } },
				el('div', {}, el('h3', {}, pr.name), el('div', { class: 'meta' },
					el('span', {}, `${m.reels} reels`), el('span', {}, `avg ${secs(m.avg_seconds)}`), el('span', {}, `beats ~${secs(m.avg_beat_seconds)}`),
					m.total_views != null ? el('span', {}, `${compact(m.total_views)} views studied`) : null)),
				el('span', { class: 'chev', 'aria-hidden': 'true' }, open ? '−' : '+')),
			open ? el('div', { class: 'profile-body' },
				p.summary ? el('p', { style: 'margin:0' }, p.summary) : null,
				p.hook_patterns.length ? field('Hooks that repeat', el('ul', { class: 'plain' }, p.hook_patterns.map((h) => el('li', {}, el('span', { class: 'tag approved' }, HOOK[h.type] || words(h.type)), ' ', h.template)))) : null,
				p.structure.length ? field('Structure', el('div', { class: 'chain' }, p.structure.map((s) => el('span', { class: `chip-s p-${s}` }, purpose(s))))) : null,
				el('div', { class: 'stats' }, stat('Target length', secs(p.length_seconds)), stat('Beat length', secs(p.beat_seconds)), stat('Text', cap(p.text_position)), stat('Formats', p.formats.map(cap).join(', ') || '—')),
				p.do.length ? field('Do', el('ul', { class: 'plain' }, p.do.map((t) => el('li', {}, t)))) : null,
				p.avoid.length ? field('Avoid', el('ul', { class: 'plain' }, p.avoid.map((t) => el('li', {}, t)))) : null,
				p.cta_patterns.length ? field('Calls to action', el('ul', { class: 'plain' }, p.cta_patterns.map((t) => el('li', {}, t)))) : null,
				el('div', { class: 'actions' },
					count,
					el('button', { class: 'btn btn-accent btn-sm', type: 'button', onclick: (e) => planFromPatterns(pr, Number(count.value), e.currentTarget) }, 'Plan new reels from these patterns'),
					el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: async () => { if (!confirm('Delete these patterns?')) return; try { await api(`/api/patterns/${pr.id}`, { method: 'DELETE' }); } catch (e) { toast(e.message, true); } refresh(); } }, 'Delete')),
			) : null,
		);
	}));
}

async function planFromPatterns(pr, count, btn) {
	if (!state.brandId) { toast('Add your business first.', true); showOnboarding(true); return; }
	try {
		setBusy(btn, true, 'Writing…');
		await api(`/api/brands/${state.brandId}/week`, { method: 'POST', body: { count, startDate: isoDay(new Date(Date.now() + 86400000)), profileId: pr.id } });
		toast(`${count} new reels planned from “${pr.name}”. Rendering now.`);
		setTab('plan');
		await refresh(true);
	} catch (e) { toast(e.message, true); setBusy(btn, false, 'Plan new reels from these patterns'); }
}

// ---------- data loop ----------
let pollTimer;
async function refresh(pickFirst = false) {
	clearTimeout(pollTimer);
	try {
		const [status, brands, sources, profiles] = await Promise.all([api('/api/status'), api('/api/brands'), api('/api/sources'), api('/api/patterns')]);
		state.status = status; state.brands = brands; state.sources = sources; state.profiles = profiles;
		for (const id of state.picked) if (!sources.some((x) => x.id === id && x.status === 'ready')) state.picked.delete(id);
		if (!sources.some((x) => x.id === state.sourceId)) state.sourceId = sources[0]?.id || null;
		if (!profiles.some((x) => x.id === state.profileId)) state.profileId = profiles[0]?.id || null;
		if (!state.brandId || !brands.some((b) => b.id === state.brandId)) {
			let saved = null; try { saved = localStorage.getItem('ootto.brand'); } catch {}
			state.brandId = brands.some((b) => b.id === saved) ? saved : brands.at(-1)?.id || null;
		}
		state.reels = state.brandId ? await api(`/api/reels?brandId=${encodeURIComponent(state.brandId)}`) : [];
		if (pickFirst || !state.reels.some((r) => r.id === state.selectedId)) {
			state.selectedId = (state.reels.find((r) => r.status === 'ready') || state.reels[0])?.id || null;
		}
		try { if (state.brandId) localStorage.setItem('ootto.brand', state.brandId); } catch {}
		renderStatus(); renderBrandPicker();
		applyView();
		renderWeek(); renderStage(); renderDetail();
		if (state.tab === 'watch') renderWatch();
	} catch (e) { toast(`Cannot reach the studio server: ${e.message}`, true); }
	const working = state.reels.some((r) => BUSY.has(r.status)) || state.sources.some((x) => SBUSY.has(x.status));
	pollTimer = setTimeout(() => refresh(), working ? 2500 : 15000);
}

const t = new Date(Date.now() + 86400000);
$('#f-start').value = isoDay(t); $('#more-start').value = isoDay(t);
try { state.tab = localStorage.getItem('ootto.tab') === 'watch' ? 'watch' : 'plan'; } catch {}
if (location.hash === '#watch') state.tab = 'watch';
for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => setTab(b.dataset.tab));
refresh(true);
