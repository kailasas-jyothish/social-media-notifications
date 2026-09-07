import { config } from '../config.js';
import { log } from '../log.js';
import { announce, suppress } from '../notify.js';
import { addWatch, dropWatch, hasSeen } from '../store.js';
import { verify } from './owner.js';
import {
  hasApiKey,
  videosList,
  isShort,
  isoDurationSeconds,
  bestThumb,
  watchUrl,
  shortsUrl,
  thumbUrl,
} from './api.js';

/**
 * Turn a YouTube video id into a classified event and announce it.
 *
 * `mode` = 'notify' (default) or 'seed' (record as handled, post nothing).
 */
export async function handleVideo(videoId, hint = {}, mode = 'notify') {
  const owner = await verify(videoId, hint);
  if (!owner.own) {
    log.debug(`ignoring ${videoId}: not published by the watched channel`);
    return false;
  }

  const item = hasApiKey() ? (await videosList([videoId]))[0] : null;
  const event = await classify(videoId, item, {
    ...hint,
    title: hint.title || owner.title,
    author: hint.author || owner.author,
  });
  if (!event) return false;

  if (mode === 'seed') {
    suppress(event);
    return false;
  }

  // A stream we already announced as LIVE must not re-announce as a plain
  // video when the feed re-fires or the VOD lands.
  if ((event.kind === 'video' || event.kind === 'upcoming') && hasSeen(`youtube:live:${videoId}`)) {
    log.debug(`skipping ${event.kind} for ${videoId}: already announced live`);
    return false;
  }

  return announce(event);
}

async function classify(videoId, item, hint) {
  const snippet = item?.snippet || {};
  const live = item?.liveStreamingDetails;
  const title = snippet.title || hint.title || '';
  const author = snippet.channelTitle || hint.author || '';
  const publishedAt = snippet.publishedAt || hint.published || undefined;
  const thumbnail = bestThumb(snippet) || thumbUrl(videoId);
  const base = { platform: 'youtube', id: videoId, title, author, publishedAt, thumbnail, source: hint.source };

  if (item) {
    const lbc = snippet.liveBroadcastContent; // 'live' | 'upcoming' | 'none'

    if (lbc === 'live' || (live?.actualStartTime && !live?.actualEndTime)) {
      dropWatch(videoId);
      return { ...base, kind: 'live', url: watchUrl(videoId) };
    }

    if (lbc === 'upcoming') {
      addWatch(videoId, { title, scheduledStartTime: live?.scheduledStartTime });
      if (!config.youtube.notifyUpcoming) return null;
      return { ...base, kind: 'upcoming', url: watchUrl(videoId) };
    }

    dropWatch(videoId);

    // Finished broadcast: only interesting if we never caught the live start.
    if (live?.actualEndTime && hasSeen(`youtube:live:${videoId}`)) return null;

    const seconds = isoDurationSeconds(item.contentDetails?.duration);
    if (seconds !== null && seconds > 0 && seconds <= config.youtube.shortMaxSeconds) {
      if (await isShort(videoId)) return { ...base, kind: 'short', url: shortsUrl(videoId) };
    }
    return { ...base, kind: 'video', url: watchUrl(videoId) };
  }

  // No API key: the Shorts redirect probe is the only free discriminator.
  // Live detection in this mode comes from the channel /live probe instead.
  if (await isShort(videoId)) return { ...base, kind: 'short', url: shortsUrl(videoId) };
  return { ...base, kind: 'video', url: watchUrl(videoId) };
}

/** Announce a live stream detected by the channel /live probe (no API key needed). */
export async function handleLiveDetected(videoId, hint = {}) {
  const owner = await verify(videoId, hint);
  if (!owner.own) {
    log.warn(`live probe surfaced ${videoId}, which is not on the watched channel — ignored`);
    return false;
  }

  dropWatch(videoId);
  return announce({
    platform: 'youtube',
    kind: 'live',
    id: videoId,
    url: watchUrl(videoId),
    title: hint.title || owner.title || '',
    author: hint.author || owner.author || '',
    thumbnail: thumbUrl(videoId),
    source: hint.source || 'live-probe',
  });
}
