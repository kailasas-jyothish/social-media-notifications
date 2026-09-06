#!/usr/bin/env node
/**
 * Offline sanity check — no deploy needed.
 *   node --env-file=.env scripts/selftest.mjs
 *
 * Verifies: channel resolution, Atom feed parsing, Shorts detection, the
 * cookie-free /live probe, YouTube API key validity, Slack credentials, and
 * (if configured) the Facebook Page token.
 */
import { config } from '../src/config.js';
import { resolveChannelId, hasApiKey, videosList, isShort, probeChannelLive } from '../src/youtube/api.js';
import { fetchFeed } from '../src/youtube/feed.js';
import { postPlain } from '../src/slack.js';
import { graph } from '../src/facebook/graph.js';

const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push(['PASS', name, detail ?? '']);
  } catch (err) {
    results.push(['FAIL', name, err.message]);
  }
};

let channelId;
let latest;

await check('resolve YouTube channel', async () => {
  channelId = await resolveChannelId(config.youtube.channel);
  return `${config.youtube.channel} -> ${channelId}`;
});

await check('fetch + parse Atom feed', async () => {
  const { entries } = await fetchFeed(channelId);
  latest = entries[0];
  return `${entries.length} entries, newest: ${latest?.videoId} "${latest?.title}"`;
});

await check('Shorts redirect probe', async () => {
  const short = await isShort(latest.videoId);
  return `${latest.videoId} is ${short ? 'a Short' : 'not a Short'}`;
});

await check('channel /live probe (no API key needed)', async () => {
  const live = await probeChannelLive(channelId);
  return live ? `LIVE NOW: ${live.videoId} "${live.title}"` : 'not currently live';
});

await check('YouTube Data API key', async () => {
  if (!hasApiKey()) return 'skipped (YOUTUBE_API_KEY unset — live detection falls back to the free probe)';
  const items = await videosList([latest.videoId]);
  const it = items[0];
  return it ? `videos.list ok: liveBroadcastContent=${it.snippet.liveBroadcastContent}, duration=${it.contentDetails?.duration}` : 'no items returned';
});

await check('Slack credentials', async () => {
  if (!config.slack.botToken && !config.slack.webhookUrl) return 'skipped (no Slack destination configured)';
  await postPlain(':white_check_mark: social-media-notifications selftest — Slack delivery works.');
  return `posted to ${config.slack.channel || 'incoming webhook'}`;
});

await check('Facebook Page token', async () => {
  if (!config.facebook.enabled) return 'skipped (FACEBOOK_ENABLED=false)';
  const me = await graph(config.facebook.pageId, { fields: 'id,name,fan_count' });
  return `${me.name} (${me.id})`;
});

console.log('');
for (const [status, name, detail] of results) {
  console.log(`${status === 'PASS' ? '  ok  ' : ' FAIL '} ${name.padEnd(38)} ${detail}`);
}
console.log('');
process.exit(results.some(([s]) => s === 'FAIL') ? 1 : 0);
