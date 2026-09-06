# social-media-notifications

Watches a YouTube channel and a Facebook Page and drops the link into Slack the
moment anything goes out — a video, a Short/Reel, a post, or a live stream
starting.

No cookies. No browser session. No logged-in scraping.

Default target: [`@kailasasanjoseus`](https://www.youtube.com/@kailasasanjoseus)
→ Slack channel `C0C0PGXT46L`.

---

## Straight answer on what works

| Platform | Detection | Latency | What it needs |
|---|---|---|---|
| YouTube — new video / Short / premiere | WebSub (PubSubHubbub) **push** from Google | seconds | a public HTTPS URL. That's it. |
| YouTube — **live stream start** | `videos.list` watchlist poll + free `/live` page probe | ~20–30 s | a free YouTube Data API key (optional but recommended) |
| YouTube — dropped pushes | RSS backstop poll | 60 s | nothing |
| Facebook — posts / photos / videos / reels | Graph API `feed` **webhook** | 1–5 s | a Page access token |
| Facebook — live start | Graph API `live_videos` webhook | 1–5 s | a Page access token |
| Facebook — missed webhooks | Graph edge poll | 60 s | a Page access token |

**The YouTube half is fully solved and needs nothing from you but a domain.**

**The Facebook half has one hard requirement and there is no way around it:**
a Page access token, which means someone with **admin (or editor) rights on the
Page** has to click through a one-time OAuth on a free Meta developer app. That
is *not* a cookie and *not* a scraped session — it is the official API — but it
does need Page rights.

Without that token, the honest options are:

1. **Get the token.** ~20 minutes, free, permanent, instant and reliable. See
   [Facebook setup](#facebook-setup) below. This is the recommendation.
2. **Bridge something else into `POST /ingest`.** Make.com / Zapier / IFTTT have
   Facebook Page triggers where *they* own the Meta app — you still OAuth as a
   Page admin, and you get 1–15 minute lag instead of seconds, but you write no
   Meta code. The `/ingest` endpoint exists exactly for this.
3. **Paid third-party scraper APIs** (Apify, ScrapeCreators, Bright Data). These
   do work on public Pages with no admin rights, but: they cost money per poll,
   they lag by minutes so live-start detection is poor, they break whenever
   Facebook changes its markup, and they violate Meta's Platform Terms. Not
   built in — deliberately.
4. **RSSHub / rss-bridge / mbasic.facebook.com.** These are dead. Facebook walls
   logged-out page content now. Don't waste a day on them.

The Facebook code path (option 1) is written and ready. It stays dormant until
`FACEBOOK_ENABLED=true` and a token are set, so YouTube ships today and Facebook
switches on the day the token exists.

---

## How it works

```
                    ┌──────────────────────────────────────────┐
  Google WebSub ───►│ POST /websub/youtube   (HMAC-SHA1 check) │
       hub          └──────────────────────────────────────────┘
                                     │
  /live probe ──────┐                │
  videos.list ──────┼──────────────► dedupe store ────► Slack Block Kit card
  RSS backstop ─────┘                │                  (chat.postMessage)
                                     │
  Meta webhooks ───►┌──────────────────────────────────────────┐
                    │ POST /webhooks/facebook (HMAC-SHA256)    │
  Graph poll ──────►└──────────────────────────────────────────┘
  Make/Zapier ─────► POST /ingest  (bearer token)
```

Every detector funnels through one `announce()` call keyed on
`platform:kind:id`, so overlapping detectors can never double-post. State lives
in a JSON file under `DATA_DIR`, so restarts and redeploys don't replay old
content. First boot seeds the store from the existing feed silently — you will
not get a flood of the last 15 videos.

### Endpoints

| Route | Purpose |
|---|---|
| `GET /healthz` | container health check |
| `GET  /websub/youtube` | hub verification handshake |
| `POST /websub/youtube` | signed content push from Google |
| `GET  /webhooks/facebook` | Meta verification handshake |
| `POST /webhooks/facebook` | signed page events from Meta |
| `POST /ingest` | generic inbox (`x-ingest-token` header) |
| `GET  /status` | full runtime state (`x-admin-token`) |
| `POST /admin/test` | post a test message to Slack |
| `POST /admin/resubscribe` | force a WebSub lease renewal |

---

## Setup

### 1. Slack

1. https://api.slack.com/apps → **Create New App** → From scratch.
2. **OAuth & Permissions** → Bot Token Scopes: `chat:write`, `links:read`.
3. **Install to Workspace**, copy the `xoxb-…` token → `SLACK_BOT_TOKEN`.
4. In Slack, open the target channel and run `/invite @YourBotName`.
5. `SLACK_CHANNEL_ID=C0C0PGXT46L` is already set.

### 2. YouTube API key (optional, recommended)

https://console.cloud.google.com → new project → enable **YouTube Data API v3**
→ Credentials → **API key** → `YOUTUBE_API_KEY`.

The bot polls at 1 quota unit per call (never `search.list`, which costs 100),
so the default 10,000 units/day is roughly 5× more headroom than it uses.
Without a key, everything still works except live-start detection falls back to
the free page probe and Shorts are detected by redirect only.

### 3. Deploy on Dokploy

The app is named **`Social-media-notifications`** in your Dokploy instance.

1. Push this repo to GitHub, then in the Dokploy app:
   - **Provider** → GitHub (or Git URL) → this repo, branch `main`
   - **Build Type** → `Dockerfile`, path `Dockerfile`
2. **Domains** → add a hostname, port `3000`, HTTPS on (Traefik gets the cert).
   Put that exact URL in `PUBLIC_URL` — WebSub and Meta call back to it.
3. **Advanced → Volumes** → mount a volume at `/data` so the dedupe store
   survives redeploys.
4. **Environment** → paste the contents of `.env` (minus the `DOKPLOY_*` lines).
5. Deploy. Then, from your machine:

```bash
curl -X POST "$PUBLIC_URL/admin/test" -H "x-admin-token: $ADMIN_TOKEN"
curl     "$PUBLIC_URL/status"      -H "x-admin-token: $ADMIN_TOKEN"
```

Or drive it through the API instead of the UI:

```bash
node scripts/dokploy.mjs probe      # discover the API surface
node scripts/dokploy.mjs show       # find the app, print its config
node scripts/dokploy.mjs setup      # push .env, then deploy
```

**Uptime:** Dokploy runs the container under Docker with a restart policy and
its own healthcheck, on your always-on server. Nothing depends on your laptop.

### 4. Facebook setup

Only after someone with Page admin rights is available.

1. https://developers.facebook.com/apps → **Create App** → *Business*.
   Leave it in **Development mode** — no App Review needed for your own Page.
2. Add the **Webhooks** product → object **Page**:
   - Callback URL: `https://<your-domain>/webhooks/facebook`
   - Verify Token: the `FACEBOOK_VERIFY_TOKEN` from `.env`
   - Subscribe to fields: **`feed`** and **`live_videos`**
3. Add **Facebook Login** → Graph API Explorer → request
   `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`.
4. Exchange for a long-lived token, then `GET /me/accounts` to get the Page
   token (Page tokens derived from a long-lived user token do not expire):
   ```bash
   curl "https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=SHORT_TOKEN"
   curl "https://graph.facebook.com/v21.0/me/accounts?access_token=LONG_LIVED_USER_TOKEN"
   ```
5. Subscribe the app to the Page:
   ```bash
   curl -X POST "https://graph.facebook.com/v21.0/PAGE_ID/subscribed_apps?subscribed_fields=feed,live_videos&access_token=PAGE_TOKEN"
   ```
6. Fill `FACEBOOK_PAGE_ID`, `FACEBOOK_PAGE_ACCESS_TOKEN`, `FACEBOOK_APP_SECRET`,
   set `FACEBOOK_ENABLED=true`, redeploy.

### Bridging Facebook via Make/Zapier instead

Point the automation at:

```
POST https://<your-domain>/ingest
x-ingest-token: <INGEST_TOKENS value>
{"platform":"facebook","kind":"post","id":"{{post_id}}","url":"{{permalink}}","title":"{{message}}"}
```

`kind` is one of `post photo video reel live share link`. Same dedupe, same card.

---

## Local development

```bash
npm install
npm run selftest          # checks channel, feed, Shorts probe, live probe, Slack
npm run dev               # runs with --env-file=.env and --watch
docker compose up --build # full container run
```

`npm run selftest` is the fastest way to confirm credentials before deploying —
it posts one message to Slack if a token is configured, and skips cleanly if not.

---

## Configuration

Every variable is documented in [`.env.example`](.env.example). The ones that
matter: `PUBLIC_URL`, `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, `YOUTUBE_CHANNEL`,
`YOUTUBE_API_KEY`, and the Facebook block.

Notable defaults: live watchlist poll 20 s, `/live` probe 30 s, RSS backstop
60 s, Facebook poll 60 s, WebSub lease renewed every 12 h (Google caps leases at
5 days).
