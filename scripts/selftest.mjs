#!/usr/bin/env node
/**
 * Offline sanity check — no deploy needed.
 *   node --env-file=.env scripts/selftest.mjs
 *
 * Verifies: YouTube API discovery and classification, Shorts detection, Slack
 * credentials, and (if configured) the Facebook Page token.
 */
import { config } from '../src/config.js';
import {
  resolveChannelId,
  videosList,
  isShort,
  recentUploads,
} from '../src/youtube/api.js';
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

await check('recent uploads via API', async () => {
  const items = await recentUploads(channelId);
  const foreign = items.filter((item) => item.channelId !== channelId);
  if (foreign.length) {
    throw new Error(
      `${foreign.length} item(s) are not from ${channelId}: ` +
        foreign.map((item) => `${item.videoId}:${item.channelId || 'missing'}`).join(', '),
    );
  }
  latest = items[0];
  if (!latest) throw new Error('playlistItems.list returned no uploads');
  return `${items.length} uploads, newest: ${latest.videoId} "${latest.title}"`;
});

await check('YouTube Data API key', async () => {
  const items = await videosList([latest.videoId]);
  const it = items[0];
  return it ? `videos.list ok: liveBroadcastContent=${it.snippet.liveBroadcastContent}, duration=${it.contentDetails?.duration}` : 'no items returned';
});

await check('Shorts redirect probe', async () => {
  const short = await isShort(latest.videoId);
  if (short === null) return `${latest.videoId}: inconclusive`;
  return `${latest.videoId} is ${short ? 'a Short' : 'not a Short'}`;
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
