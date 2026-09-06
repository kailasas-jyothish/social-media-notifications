import crypto from 'node:crypto';

const bool = (v, dflt = false) => {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};
const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
const list = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

export const config = {
  port: num(process.env.PORT, 3000),
  publicUrl,
  dataDir: process.env.DATA_DIR || './data',
  logLevel: process.env.LOG_LEVEL || 'info',

  slack: {
    botToken: process.env.SLACK_BOT_TOKEN || '',
    channel: process.env.SLACK_CHANNEL_ID || '',
    webhookUrl: process.env.SLACK_WEBHOOK_URL || '',
    startupPing: bool(process.env.SLACK_STARTUP_PING, false),
  },

  youtube: {
    enabled: bool(process.env.YOUTUBE_ENABLED, true),
    // Either a handle (@name), a channel URL, or a raw UC... id.
    channel: process.env.YOUTUBE_CHANNEL || '@kailasasanjoseus',
    apiKey: process.env.YOUTUBE_API_KEY || '',
    // Secret used for the WebSub HMAC. Auto-generated if unset (regenerates on
    // restart, which only means the next re-subscribe rotates it).
    websubSecret: process.env.YOUTUBE_WEBSUB_SECRET || crypto.randomBytes(24).toString('hex'),
    hubUrl: process.env.YOUTUBE_HUB_URL || 'https://pubsubhubbub.appspot.com/subscribe',
    leaseSeconds: num(process.env.YOUTUBE_LEASE_SECONDS, 432000),
    resubscribeSeconds: num(process.env.YOUTUBE_RESUBSCRIBE_SECONDS, 12 * 3600),
    livePollSeconds: num(process.env.YOUTUBE_LIVE_POLL_SECONDS, 20),
    liveProbeSeconds: num(process.env.YOUTUBE_LIVE_PROBE_SECONDS, 30),
    rssPollSeconds: num(process.env.YOUTUBE_RSS_POLL_SECONDS, 60),
    shortMaxSeconds: num(process.env.YOUTUBE_SHORT_MAX_SECONDS, 180),
    notifyUpcoming: bool(process.env.YOUTUBE_NOTIFY_UPCOMING, true),
  },

  facebook: {
    // Graph API path. Requires a Page access token — no cookies, no scraping.
    enabled: bool(process.env.FACEBOOK_ENABLED, false),
    pageId: process.env.FACEBOOK_PAGE_ID || '',
    pageToken: process.env.FACEBOOK_PAGE_ACCESS_TOKEN || '',
    appSecret: process.env.FACEBOOK_APP_SECRET || '',
    verifyToken: process.env.FACEBOOK_VERIFY_TOKEN || '',
    graphVersion: process.env.FACEBOOK_GRAPH_VERSION || 'v21.0',
    pollSeconds: num(process.env.FACEBOOK_POLL_SECONDS, 60),
    pollEnabled: bool(process.env.FACEBOOK_POLL_ENABLED, true),
  },

  // Token-protected generic inbox so anything (Zapier / Make / IFTTT / a curl
  // from another box) can push an event into the same Slack pipeline.
  ingest: {
    tokens: list(process.env.INGEST_TOKENS),
  },

  admin: {
    token: process.env.ADMIN_TOKEN || '',
  },
};

export function configProblems() {
  const p = [];
  if (!config.slack.botToken && !config.slack.webhookUrl) {
    p.push('No Slack destination: set SLACK_BOT_TOKEN (+ SLACK_CHANNEL_ID) or SLACK_WEBHOOK_URL.');
  }
  if (config.slack.botToken && !config.slack.channel) {
    p.push('SLACK_BOT_TOKEN is set but SLACK_CHANNEL_ID is missing.');
  }
  if (config.youtube.enabled && !config.publicUrl) {
    p.push('PUBLIC_URL is not set — YouTube WebSub push cannot be subscribed; falling back to polling only.');
  }
  if (config.facebook.enabled && (!config.facebook.pageId || !config.facebook.pageToken)) {
    p.push('FACEBOOK_ENABLED=true but FACEBOOK_PAGE_ID / FACEBOOK_PAGE_ACCESS_TOKEN are missing.');
  }
  return p;
}
