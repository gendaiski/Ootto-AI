// Pull readable text from a business website so the planner knows what the business sells.
const MAX_BYTES = 1_500_000;

export async function fetchSiteText(url) {
	let u;
	try { u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`); } catch { throw new Error('That website address is not valid.'); }
	if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https websites are supported.');
	const res = await fetch(u, {
		headers: { 'User-Agent': 'OottoStudio/0.1 (+reel planner)', Accept: 'text/html,*/*' },
		redirect: 'follow',
		signal: AbortSignal.timeout(12_000),
	});
	if (!res.ok) throw new Error(`The website answered ${res.status}.`);
	const reader = res.body.getReader();
	let html = '', size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		html += Buffer.from(value).toString('utf8');
		if (size > MAX_BYTES) { reader.cancel(); break; }
	}
	return { url: u.toString(), ...htmlToText(html) };
}

export function htmlToText(html) {
	const pick = (re) => (html.match(re)?.[1] || '').replace(/\s+/g, ' ').trim();
	const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const description = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
		|| pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i);
	const text = html
		.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|section|article|tr)>/gi, '\n')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n\s*\n+/g, '\n')
		.trim();
	return { title, description, text: text.slice(0, 6000) };
}
