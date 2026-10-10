// Publishes a rendered reel through the Instagram Graph API (content publishing for Reels):
// 1. create a REELS media container from a public video URL
// 2. poll the container until Instagram has processed the video
// 3. publish the container
// Requires an Instagram professional (Business/Creator) account connected to a Facebook Page,
// a long-lived access token with instagram_content_publish, and a publicly reachable video URL.

export class InstagramError extends Error {}

async function graph(cfg, method, pathname, params) {
	const ig = cfg.instagram;
	const url = new URL(`${ig.graphBaseUrl}/${ig.graphVersion}/${pathname}`);
	const body = new URLSearchParams({ ...params, access_token: ig.accessToken });
	const res = method === 'GET'
		? await fetch(`${url}?${body}`, { signal: AbortSignal.timeout(30_000) })
		: await fetch(url, { method, body, signal: AbortSignal.timeout(60_000) });
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data.error) {
		throw new InstagramError(`Instagram ${pathname} failed (${res.status}): ${data.error?.message || 'unknown error'}`);
	}
	return data;
}

export function captionFor(plan) {
	const tags = (plan.hashtags || []).map((h) => `#${h}`).join(' ');
	return [plan.caption, tags].filter(Boolean).join('\n\n').slice(0, 2200);
}

export async function publishReel(cfg, { videoUrl, caption, onProgress = () => {} }) {
	const ig = cfg.instagram;
	onProgress('Uploading to Instagram');
	const container = await graph(cfg, 'POST', `${ig.userId}/media`, {
		media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: 'true',
	});
	const started = Date.now();
	for (;;) {
		const st = await graph(cfg, 'GET', container.id, { fields: 'status_code,status' });
		if (st.status_code === 'FINISHED') break;
		if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') {
			throw new InstagramError(`Instagram could not process the video: ${st.status || st.status_code}`);
		}
		if (Date.now() - started > ig.pollTimeoutMs) throw new InstagramError('Instagram took too long to process the video.');
		onProgress('Instagram is processing the video');
		await new Promise((r) => setTimeout(r, ig.pollIntervalMs));
	}
	onProgress('Publishing');
	const published = await graph(cfg, 'POST', `${ig.userId}/media_publish`, { creation_id: container.id });
	return { containerId: container.id, mediaId: published.id, postedAt: new Date().toISOString() };
}
