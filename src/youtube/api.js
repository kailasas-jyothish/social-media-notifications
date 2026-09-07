import { config } from '../config.js';
import { getJson, getText, get } from '../http.js';
import { log } from '../log.js';

const API = 'https://www.googleapis.com/youtube/v3';

export const hasApiKey = () => Boolean(config.youtube.apiKey);

/**
 * Resolve "@handle", a channel URL, or a raw UC... id to a channel id.
 * Works without an API key by scraping the public channel page for the
 * canonical /channel/UC... URL — no cookies, no login.
 */
export async function resolveChannelId(input) {
  const raw = String(input || '').trim();

  const direct = raw.match(/(UC[\w-]{22})/);
  if (direct) return direct[1];

  let handle = raw;
  const fromUrl = raw.match(/youtube\.com\/(@[\w.\-]+)/i);
  if (fromUrl) handle = fromUrl[1];
  if (!handle.startsWith('@')) handle = `@${handle.replace(/^\/+/, '')}`;

  if (hasApiKey()) {
    try {
      const data = await getJson(
        `${API}/channels?part=id,snippet&forHandle=${encodeURIComponent(handle)}&key=${config.youtube.apiKey}`,
      );
      const id = data?.items?.[0]?.id;
      if (id) return id;
      log.warn(`channels.list?forHandle=${handle} returned no items; falling back to page scrape`);
    } catch (err) {
      log.warn(`channels.list failed (${err.message}); falling back to page scrape`);
    }
  }

  const html = await getText(`https://www.youtube.com/${handle}`);
  const m =
    html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/) ||
    html.match(/"externalId":"(UC[\w-]{22})"/) ||
    html.match(/"channelId":"(UC[\w-]{22})"/);
  if (!m) throw new Error(`could not resolve channel id for ${raw}`);
  return m[1];
}

/**
 * videos.list — 1 quota unit per call, up to 50 ids. This is the cheap way to
 * watch for a live stream actually starting (search.list costs 100/call).
 */
export async function videosList(ids, parts = 'snippet,contentDetails,liveStreamingDetails') {
  if (!hasApiKey() || ids.length === 0) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const url = `${API}/videos?part=${parts}&id=${chunk.join(',')}&key=${config.youtube.apiKey}`;
    const data = await getJson(url);
    out.push(...(data.items || []));
  }
  return out;
}

/** Best thumbnail available from a snippet. */
export function bestThumb(snippet) {
  const t = snippet?.thumbnails || {};
  return (t.maxres || t.standard || t.high || t.medium || t.default || {}).url;
}

/** ISO-8601 duration (PT1M30S) -> seconds. */
export function isoDurationSeconds(iso) {
  if (!iso) return null;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso);
  if (!m) return null;
  const [, d, h, min, s] = m;
  return (Number(d || 0) * 86400) + (Number(h || 0) * 3600) + (Number(min || 0) * 60) + Number(s || 0);
}

/**
 * Definitive Shorts test: /shorts/<id> returns 200 for a real Short and
 * redirects to /watch?v=<id> for anything else. Free, no quota.
 */
export async function isShort(videoId) {
  try {
    const res = await get(`https://www.youtube.com/shorts/${videoId}`, {
      redirect: 'manual',
      retries: 0,
      timeoutMs: 8000,
    });
    return res.status === 200;
  } catch (err) {
    log.debug(`shorts probe failed for ${videoId}: ${err.message}`);
    return false;
  }
}

/**
 * Cookie-free probe of https://www.youtube.com/channel/<id>/live.
 * Catches streams that went live without ever existing as a scheduled video,
 * and works even with no API key at all.
 */
export async function probeChannelLive(channelId) {
  const html = await getText(`https://www.youtube.com/channel/${channelId}/live`, { retries: 0 });
  const read = readLivePage(html);
  return read.live ? { videoId: read.videoId, title: read.title, via: read.via } : null;
}

/**
 * Extract the live video from a /live page.
 *
 * Only page-level markers are trusted. A live watch page carries ~30 unrelated
 * `"videoId"` values in its recommendation rail, so matching the first one
 * anywhere in the HTML returns some stranger's video — that is precisely how
 * this probe once flooded Slack with links to Sadhguru and handpan music.
 * When the channel is not live the /live URL does not redirect, so the absence
 * of a page-level watch id is itself the "not live" answer.
 *
 * Exported for the /admin/probe diagnostic, which shows what the deployed
 * container sees (YouTube serves datacenter IPs a different page shape than a
 * laptop, so guessing is not good enough).
 */
export function readLivePage(html) {
  const canonical = html.match(
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/,
  );
  const ogVideo = html.match(
    /<meta property="og:video:url" content="https:\/\/www\.youtube\.com\/embed\/([\w-]{11})/,
  );
  // "videoDetails":{"videoId":"…"} — the player's own record of what is playing.
  const details = html.match(/"videoDetails"\s*:\s*\{[^{}]*?"videoId"\s*:\s*"([\w-]{11})"/);

  const hit = canonical || ogVideo || details;
  const via = canonical ? 'canonical' : ogVideo ? 'og:video:url' : details ? 'videoDetails' : null;
  const isLive = /"isLive"\s*:\s*true/.test(html) || /"isLiveNow"\s*:\s*true/.test(html);
  const titleMatch = html.match(/<meta name="title" content="([^"]*)"/);

  return {
    live: Boolean(hit && isLive),
    videoId: hit ? hit[1] : null,
    via,
    isLive,
    title: titleMatch ? decodeHtml(titleMatch[1]) : '',
    htmlLength: html.length,
  };
}

/**
 * oEmbed — free, keyless, no cookies, ~400 bytes. `author_url` names the
 * owning channel, which makes this the cheapest ownership check available
 * without an API key. Also supplies the title the /live probe cannot read.
 */
export async function oembed(videoId) {
  try {
    const data = await getJson(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl(videoId))}&format=json`,
      { retries: 1, timeoutMs: 8000 },
    );
    return {
      title: data.title || '',
      author: data.author_name || '',
      handle: handleFromUrl(data.author_url),
      thumbnail: data.thumbnail_url,
    };
  } catch (err) {
    log.debug(`oembed failed for ${videoId}: ${err.message}`);
    return null;
  }
}

/** The @handle a channel id canonically lives at, or null if it has none. */
export async function resolveChannelHandle(channelId) {
  const html = await getText(`https://www.youtube.com/channel/${channelId}`);
  const m =
    html.match(/"canonicalBaseUrl"\s*:\s*"\/(@[\w.\-]+)"/) ||
    html.match(/"vanityChannelUrl"\s*:\s*"https?:\/\/www\.youtube\.com\/(@[\w.\-]+)"/);
  return m ? m[1].toLowerCase() : null;
}

/**
 * The owning channel id of a single video, read from the player's own record
 * rather than from anywhere in the page (see readLivePage). Last-resort check
 * for channels with no @handle and no API key.
 */
export async function fetchVideoChannelId(videoId) {
  try {
    const html = await getText(watchUrl(videoId), { retries: 0 });
    const at = html.indexOf('"videoDetails"');
    const scope = at === -1 ? html : html.slice(at, at + 4000);
    const m = scope.match(/"channelId"\s*:\s*"(UC[\w-]{22})"/);
    return m ? m[1] : null;
  } catch (err) {
    log.debug(`channel-id lookup failed for ${videoId}: ${err.message}`);
    return null;
  }
}

const handleFromUrl = (u) => {
  const m = String(u || '').match(/youtube\.com\/(@[\w.\-]+)/i);
  return m ? m[1].toLowerCase() : null;
};

function decodeHtml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;
export const shortsUrl = (id) => `https://www.youtube.com/shorts/${id}`;
export const thumbUrl = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
