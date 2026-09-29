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

const state = { status: null, brands: [], brandId: null, reels: [], selectedId: null, busy: false };
const BUSY = new Set(['queued', 'rendering', 'posting']);
const LABEL = { queued: 'Queued', rendering: 'Rendering', ready: 'Needs review', approved: 'Approved', posting: 'Posting', posted: 'Posted', failed: 'Failed' };
const FORMAT = { tips: 'Tips', myth_vs_fact: 'Myth vs fact', behind_the_scenes: 'Behind the scenes', customer_story: 'Customer story', how_to: 'How-to', offer: 'Offer', faq: 'FAQ' };

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

function showOnboarding(show) {
	$('#onboard').hidden = !show;
	$('#workspace').hidden = show || !state.brandId;
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
	if ($('#fb-dialog').open || e.target.closest('input, textarea, select, video')) return;
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
		await refresh(true);
		showOnboarding(false);
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

// ---------- data loop ----------
let pollTimer;
async function refresh(pickFirst = false) {
	clearTimeout(pollTimer);
	try {
		const [status, brands] = await Promise.all([api('/api/status'), api('/api/brands')]);
		state.status = status; state.brands = brands;
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
		if (!state.brands.length) showOnboarding(true);
		else if ($('#onboard').hidden) { $('#workspace').hidden = false; }
		renderWeek(); renderStage(); renderDetail();
	} catch (e) { toast(`Cannot reach the studio server: ${e.message}`, true); }
	const working = state.reels.some((r) => BUSY.has(r.status));
	pollTimer = setTimeout(() => refresh(), working ? 2500 : 15000);
}

const t = new Date(Date.now() + 86400000);
$('#f-start').value = isoDay(t); $('#more-start').value = isoDay(t);
refresh(true);
