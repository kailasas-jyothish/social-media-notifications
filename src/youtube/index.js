import { config } from '../config.js';
import { log } from '../log.js';
import { every } from '../http.js';
import { isSeeded, setSeeded, setMeta, watchIds, dropWatch, watchInfo, flushIfDirty } from '../store.js';
import { parseAtom } from './feed.js';
import { resolveChannelId, recentUploads, videosList } from './api.js';
import { handleItem, handleIds, alreadyHandled } from './detect.js';
import { subscribe } from './websub.js';

/**
 * Two API pollers, nothing else.
 *
 *   uploads  playlistItems.list — new videos, Shorts and streams all appear here
 *   pending  videos.list        — watch a scheduled stream flip to live
 *
 * Both cost 1 quota unit per call. There is deliberately no HTML scraping:
 * this container is served throttled and unparseable pages by youtube.com,
 * which is what made an earlier scrape-based probe post unrelated channels'
 * videos into Slack.
 */

let channelId = null;
const timers = [];

export const getChannelId = () => channelId;

export async function start() {
  channelId = await resolveChannelId(config.youtube.channel);
  setMeta('youtubeChannelId', channelId);
  log.info(`youtube channel resolved: ${config.youtube.channel} -> ${channelId}`);

  // Seeding is not done here: pollUploads owns it. A transient API error
  // during a boot-time seed used to leave the flag unset while the pollers
  // started anyway, and the next successful poll would then post the entire
  // back catalogue to Slack. Folding it into the poller makes it retry until
  // it genuinely succeeds.

  // Push is a bonus, never the mechanism. Google's hub needs a public callback
  // it will accept and currently answers 503 to this deployment, so it stays
  // off unless explicitly enabled.
  if (config.youtube.websubEnabled) {
    await subscribe(channelId).catch((err) => log.error(`websub subscribe failed: ${err.message}`));
    timers.push(
      every(config.youtube.resubscribeSeconds, 'yt-resubscribe', () => subscribe(channelId)),
    );
  }

  const uploads = every(config.youtube.uploadsPollSeconds, 'yt-uploads', pollUploads);
  const pending = every(config.youtube.livePollSeconds, 'yt-pending', pollPending);
  timers.push(uploads, pending);

  // setInterval does not fire on entry, and a redeploy should not blind us for
  // a whole interval. Both swallow their own errors.
  uploads.runNow();
  pending.runNow();

  log.info(
    `youtube detectors running: uploads every ${config.youtube.uploadsPollSeconds}s, ` +
      `pending streams every ${config.youtube.livePollSeconds}s`,
  );
}

export function stop() {
  timers.forEach((t) => t.stop());
  timers.length = 0;
}

/** Handle a WebSub push body (raw Atom XML). Only reachable when enabled. */
export async function handlePush(xml) {
  const { entries, deleted } = parseAtom(xml);
  try {
    for (const id of deleted) {
      dropWatch(id);
      log.debug(`feed reports deleted video ${id}`);
    }
    await handleIds(entries.map((e) => e.videoId), { source: 'websub push' });
    return entries.length;
  } finally {
    flushIfDirty();
  }
}

/** Discovery. One call, plus one more only when something new showed up. */
async function pollUploads() {
  if (!channelId) return;
  try {
    const uploads = await recentUploads(channelId);

    // Until the back catalogue has been recorded once, everything found is
    // history rather than news.
    const seeding = !isSeeded('youtube');

    // A null channelId means playlistItems did not state the uploader; that is
    // "unknown", so let it through to the videos.list ownership check rather
    // than assuming either way. Only a known foreign owner is filtered here.
    const candidates = uploads
      .filter((u) => !u.channelId || u.channelId === channelId)
      .filter((u) => seeding || !alreadyHandled(u.videoId));

    if (candidates.length) {
      log.debug(`uploads poll: ${candidates.length} id(s) to ${seeding ? 'seed' : 'check'}`);
      await handleIds(
        candidates.map((u) => u.videoId),
        { source: seeding ? 'seed' : 'uploads poll' },
        seeding ? 'seed' : 'notify',
      );
    }

    if (seeding) {
      setSeeded('youtube');
      log.info(`youtube seeded with ${uploads.length} existing uploads (no Slack posts)`);
    }
  } finally {
    flushIfDirty();
  }
}

/**
 * Scheduled streams and premieres. WebSub fires when a broadcast is created,
 * not when it starts, and the uploads playlist can lag — so anything known to
 * be upcoming is polled directly until it goes live.
 */
async function pollPending() {
  const ids = watchIds();
  if (ids.length === 0) return;

  try {
    const items = await videosList(ids);
    const found = new Set();
    for (const item of items) {
      found.add(item.id);
      await handleItem(item, { source: 'stream watch' });
    }

    for (const id of ids) {
      // Gone from the API entirely: deleted or made private.
      if (!found.has(id)) {
        dropWatch(id);
        continue;
      }
      // Otherwise age out on when the stream is DUE, not when we found it. A
      // stream scheduled months ahead would be evicted long before it starts,
      // and its 'upcoming' dedupe key stops pollUploads rediscovering it — so
      // the go-live would be lost with nothing watching for it.
      const info = watchInfo(id);
      const scheduled = Date.parse(info?.scheduledStartTime ?? '');
      const expires = Number.isFinite(scheduled)
        ? scheduled + 7 * 24 * 3600 * 1000
        : (info?.addedAt ?? 0) + 30 * 24 * 3600 * 1000;
      if (expires < Date.now()) {
        log.debug(`dropping stale watch ${id}`);
        dropWatch(id);
      }
    }
  } finally {
    flushIfDirty();
  }
}

/** What the API reports right now, for /admin/recent. */
export async function recentReport() {
  if (!channelId) return { error: 'channel not resolved yet' };
  const uploads = await recentUploads(channelId);
  const items = await videosList(uploads.map((u) => u.videoId));
  return {
    channelId,
    watching: watchIds(),
    uploads: items.map((it) => ({
      id: it.id,
      title: it.snippet?.title,
      state: it.snippet?.liveBroadcastContent,
      duration: it.contentDetails?.duration,
      handled: alreadyHandled(it.id),
    })),
  };
}
