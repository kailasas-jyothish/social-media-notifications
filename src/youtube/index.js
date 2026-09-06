import { config } from '../config.js';
import { log } from '../log.js';
import { every } from '../http.js';
import { isSeeded, setSeeded, setMeta, getMeta, watchIds, dropWatch, watchInfo, flushIfDirty } from '../store.js';
import { fetchFeed, parseAtom } from './feed.js';
import { resolveChannelId, hasApiKey, videosList, probeChannelLive } from './api.js';
import { handleVideo, handleLiveDetected } from './detect.js';
import { subscribe } from './websub.js';

let channelId = null;
const timers = [];

export const getChannelId = () => channelId;

export async function start() {
  channelId = await resolveChannelId(config.youtube.channel);
  setMeta('youtubeChannelId', channelId);
  log.info(`youtube channel resolved: ${config.youtube.channel} -> ${channelId}`);

  // First run: mark everything currently in the feed as handled so we don't
  // dump the last 15 videos into Slack.
  if (!isSeeded('youtube')) {
    try {
      const { entries } = await fetchFeed(channelId);
      for (const e of entries) {
        await handleVideo(e.videoId, { title: e.title, author: e.author, published: e.published }, 'seed');
      }
      setSeeded('youtube');
      flushIfDirty();
      log.info(`youtube seeded with ${entries.length} existing entries (no Slack posts)`);
    } catch (err) {
      log.error(`youtube seeding failed: ${err.message}`);
    }
  }

  await subscribe(channelId).catch((err) => log.error(`websub subscribe failed: ${err.message}`));
  timers.push(
    every(config.youtube.resubscribeSeconds, 'yt-resubscribe', () => subscribe(channelId)),
  );

  // Cheap live-start detection for scheduled streams/premieres (1 quota unit
  // per poll, batched over the whole watchlist).
  if (hasApiKey()) {
    timers.push(every(config.youtube.livePollSeconds, 'yt-live-watchlist', pollWatchlist));
  } else {
    log.warn('YOUTUBE_API_KEY unset — using the free /live probe only (slightly less precise)');
  }

  // Catches instant go-lives that never existed as a scheduled video. Free.
  timers.push(every(config.youtube.liveProbeSeconds, 'yt-live-probe', pollChannelLive));

  // Backstop for dropped WebSub deliveries.
  timers.push(every(config.youtube.rssPollSeconds, 'yt-rss', pollRss));

  log.info('youtube detectors running');
}

export function stop() {
  timers.forEach((t) => t.stop());
  timers.length = 0;
}

/** Handle a WebSub push body (raw Atom XML). */
export async function handlePush(xml) {
  const { entries, deleted } = parseAtom(xml);
  for (const id of deleted) {
    dropWatch(id);
    log.debug(`feed reports deleted video ${id}`);
  }
  for (const e of entries) {
    await handleVideo(
      e.videoId,
      { title: e.title, author: e.author, published: e.published, source: 'websub push' },
      'notify',
    );
  }
  return entries.length;
}

async function pollWatchlist() {
  const ids = watchIds();
  if (ids.length === 0) return;
  const items = await videosList(ids, 'snippet,liveStreamingDetails');
  const found = new Set();
  for (const item of items) {
    found.add(item.id);
    const lbc = item.snippet?.liveBroadcastContent;
    const live = item.liveStreamingDetails;
    if (lbc === 'live' || (live?.actualStartTime && !live?.actualEndTime)) {
      await handleLiveDetected(item.id, {
        title: item.snippet?.title,
        author: item.snippet?.channelTitle,
        source: 'live watchlist',
      });
    } else if (live?.actualEndTime || lbc === 'none') {
      dropWatch(item.id);
    }
  }
  // Evict ids the API no longer returns (deleted/private) and stale entries.
  const staleCutoff = Date.now() - 30 * 24 * 3600 * 1000;
  for (const id of ids) {
    if (!found.has(id) || (watchInfo(id)?.addedAt ?? 0) < staleCutoff) dropWatch(id);
  }
  flushIfDirty();
}

async function pollChannelLive() {
  if (!channelId) return;
  const live = await probeChannelLive(channelId);
  if (!live) return;
  await handleLiveDetected(live.videoId, { title: live.title, source: 'channel /live probe' });
}

async function pollRss() {
  if (!channelId) return;
  const { entries } = await fetchFeed(channelId);
  const lastSeenId = getMeta('youtubeLastFeedId');
  for (const e of entries) {
    await handleVideo(
      e.videoId,
      { title: e.title, author: e.author, published: e.published, source: 'rss backstop' },
      'notify',
    );
  }
  if (entries[0] && entries[0].videoId !== lastSeenId) setMeta('youtubeLastFeedId', entries[0].videoId);
  flushIfDirty();
}
