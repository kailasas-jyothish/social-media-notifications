import { log } from '../log.js';
import {
  hasApiKey,
  videosList,
  oembed,
  resolveChannelHandle,
  fetchVideoChannelId,
} from './api.js';

/**
 * Ownership gate for YouTube ids.
 *
 * Only the Atom feed is channel-scoped by construction. The /live probe, the
 * watchlist and the generic ingest route all hand over bare video ids, and a
 * bare id from a scraped page can belong to anyone — the probe used to surface
 * recommendation-rail videos and every one of them was announced as a live
 * stream on this channel. Nothing gets announced without passing through here.
 *
 * Fails closed: an id we cannot attribute is not announced.
 */

let channelId = null;
let handle = null;
const cache = new Map(); // videoId -> { own, title, author, thumbnail }

export async function setOwner(id) {
  channelId = id;
  cache.clear();
  try {
    handle = await resolveChannelHandle(id);
    log.info(`youtube owner: ${id}${handle ? ` (${handle})` : ' (no @handle)'}`);
  } catch (err) {
    handle = null;
    log.warn(`could not resolve the channel @handle (${err.message}); ownership checks will use the watch page`);
  }
}

export const ownerHandle = () => handle;

/**
 * Attribute a video. Returns { own, title, author, thumbnail } — the metadata
 * is a free by-product of the oEmbed lookup and is worth keeping, since the
 * /live probe cannot read a title off the page it scrapes.
 */
export async function verify(videoId, hint = {}) {
  if (!channelId) return { own: false };

  // The feed states the owning channel outright; no network call needed.
  if (hint.channelId) return { own: hint.channelId === channelId };

  const cached = cache.get(videoId);
  if (cached) return cached;

  const result = await attribute(videoId);
  cache.set(videoId, result);
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return result;
}

export const isOwnVideo = async (videoId, hint) => (await verify(videoId, hint)).own;

async function attribute(videoId) {
  if (hasApiKey()) {
    const item = (await videosList([videoId], 'snippet'))[0];
    if (item) {
      return {
        own: item.snippet?.channelId === channelId,
        title: item.snippet?.title,
        author: item.snippet?.channelTitle,
      };
    }
  }

  const meta = await oembed(videoId);
  if (meta?.handle && handle) {
    return { own: meta.handle === handle, title: meta.title, author: meta.author, thumbnail: meta.thumbnail };
  }

  // No handle to compare against (or oEmbed refused): read the owner off the
  // watch page. Exact, but a ~1MB fetch, so it is the last resort.
  const owner = await fetchVideoChannelId(videoId);
  if (!owner) {
    log.warn(`cannot attribute video ${videoId}; not announcing it`);
    return { own: false };
  }
  return { own: owner === channelId, title: meta?.title, author: meta?.author, thumbnail: meta?.thumbnail };
}
