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
  const isLive = /"isLive"\s*:\s*true/.test(html) || /"isLiveNow"\s*:\s*true/.test(html);
  if (!isLive) return null;
  const m =
    html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/) ||
    html.match(/"videoId"\s*:\s*"([\w-]{11})"/);
  if (!m) return null;
  const titleMatch = html.match(/<meta name="title" content="([^"]*)"/);
  return {
    videoId: m[1],
    title: titleMatch ? decodeHtml(titleMatch[1]) : '',
  };
}

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
