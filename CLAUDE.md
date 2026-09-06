# CLAUDE.md — project context for `social-media-notifications`

This file carries the full context of the conversation that created this repo, so
any future Claude Code session in this folder can pick up mid-stream without
re-deriving decisions or re-researching dead ends.

Created: 2026-09-05 → 2026-09-06. Working dir: `C:\Users\GD\Desktop\GD\social-media-notifications`.

---

## 1. The original request

> "I need you to create a repo which can give the link of any post / reel /
> video / live that happens on this channel. Moment the live stream starts /
> post is posted / reel is posted it should immediately send the link of that
> post / reel / live stream to the slack channel `C0C0PGXT46L`.
>
> Here is the reference yt channel — https://www.youtube.com/@kailasasanjoseus
>
> This repo should be able to do the same for facebook too, without the usage of
> any cookies / separate login.
>
> Use codex cli for your sub-agents."

Follow-ups, in order:

1. *"I want you to setup in Docker, but how do I run it continuously, it shd not
   be dependent on me"* — hosting had to be always-on and laptop-independent.
2. Slack delivery: **bot token + rich Block Kit cards**.
3. Facebook: **"Not an admin / public page only"** (this is the crux — see §3).
4. Triggers: **everything** — uploads, Shorts, premieres, live starts, FB posts,
   photos, videos, reels, live.
5. *"I have a dokploy instance. I'll give you the API key... I've created an
   application named `Social-media-notifications`, that is the one I need you to
   work with. Tell me if this solution will work or I'll have to figure out
   something else."*
6. *"First create the repo, then I'll give you the dokploy API key, so you can
   look around and see how to work it out."*

---

## 2. Decisions locked in

| Decision | Choice | Why |
|---|---|---|
| Runtime | Node 22 ESM, 2 deps (`express`, `fast-xml-parser`) | small attack surface, fast cold start, `fetch` is built in |
| Hosting | **Dokploy** app named `Social-media-notifications` | user already runs it; Traefik supplies the public HTTPS URL that webhooks require, Docker supplies 24/7 restart. This is what unblocked the whole design. |
| Slack | bot token `chat:write` + Block Kit cards, channel `C0C0PGXT46L` | user's explicit choice; richer than an incoming webhook and allows future editing/threading |
| State | JSON file under `DATA_DIR` (`/data` volume) | dedupe must survive redeploys; a DB would be overkill for a few hundred keys |
| Dedupe | single `announce()` keyed `platform:kind:id` | lets multiple overlapping detectors run without double-posting |
| Facebook | official Graph API path, written but **dormant** behind `FACEBOOK_ENABLED=false` | no Page admin today; see §3 |

---

## 3. The Facebook problem — read this before revisiting it

The user is **not a Page admin**. This is the one requirement that cannot be
engineered around, and it was stated plainly to them:

- A Graph API **Page access token** is the only instant + reliable + legitimate
  path. It is *not* a cookie and *not* a scraped session — it is the official
  API — but obtaining it requires someone with **admin or editor rights on the
  Page** to complete a one-time OAuth against a free Meta app (app can stay in
  Development mode; no App Review needed for a Page you administer).
- **Dokploy did not change this.** Hosting was never the FB blocker.

Cookie-free alternatives, evaluated and rejected:

| Option | Verdict |
|---|---|
| `mbasic.facebook.com` / `m.facebook.com` logged-out HTML | **dead** — Facebook walls logged-out Page content |
| RSSHub `/facebook/page/:id` | **broken** — blocked/rate-limited, self-hosting doesn't help |
| rss-bridge `FacebookBridge` | **broken** upstream |
| Paid scrapers (Apify, ScrapeCreators, Bright Data) | works, but costs per poll, lags minutes (poor for live starts), breaks on markup changes, and **violates Meta Platform Terms**. Deliberately not built in. |
| Page Public Content Access (PPCA) | *more* gated than a Page token — needs App Review + Business Verification |
| Make/Zapier/IFTTT Facebook Pages trigger | viable middle ground: they own the Meta app, but a Page admin still OAuths, and lag is 1–15 min. `POST /ingest` exists for exactly this. |

**Conclusion communicated to the user:** YouTube ships today and is fully
solved; Facebook is one env flag away from working the day a Page token exists.
Don't re-litigate this without new information (e.g. the user gains admin
rights).

---

## 4. Research findings worth keeping

Two `codex-delegate` subagents were dispatched (per the user's "use codex cli"
instruction) to research YouTube and Facebook detection. **Both failed to
actually invoke the `codex` CLI** — that agent type was provisioned without a
shell tool, so it fell back to its own knowledge. Flagged honestly to the user.
A later attempt to run `codex exec` directly was interrupted by the user, who
redirected to building the repo first. **The `codex` CLI has never actually run
in this project.** `codex-cli 0.152.1` is installed if a future session wants it.

Technical facts that were verified empirically and matter:

- **The documented YouTube feed URL is wrong now.** `https://www.youtube.com/xml/feeds/videos.xml?channel_id=…`
  returns a 463-byte **static placeholder with zero entries**. The working path
  is `https://www.youtube.com/feeds/videos.xml?channel_id=…` (confirmed: 15
  entries, correct `<link rel="self">`). This was a real bug caught by the
  selftest, not a theoretical one.
  - Mitigation: `topicUrls()` in `src/youtube/feed.js` registers **both** forms
    with the hub, since Google's hub has historically keyed on the `/xml/` form
    while the served document self-identifies as `/feeds/`. Duplicate pushes are
    deduped downstream, so subscribing to both is free insurance.
- **`search.list` is a quota trap** — 100 units/call means the default 10,000/day
  budget allows only one poll every 14.4 minutes. Never use it for polling.
  `videos.list` costs **1 unit** and accepts up to 50 ids per call; at a 20s
  interval that is ~4,300 units/day. This is why the watchlist design exists.
- **WebSub does not fire when a stream actually goes live.** It fires when the
  broadcast object is created/scheduled, then goes silent at `actualStartTime`.
  Hence the two supplements: a `videos.list` watchlist poll (for streams that
  existed as `upcoming`) and a free `/channel/<id>/live` HTML probe (for instant
  go-lives that were never scheduled).
- Google's hub signs with **HMAC-SHA1** (`X-Hub-Signature`), Meta with
  **HMAC-SHA256** (`X-Hub-Signature-256`). Both must be computed over the **raw
  request body bytes** — hence `express.raw()` on those two routes only.
- WebSub lease caps at 5 days; re-subscribe is idempotent, so it runs on boot
  and every 12h.
- Shorts have no API flag. Cheap filter: `contentDetails.duration` ≤ 180s (the
  limit rose from 60s in Oct 2024). Definitive test: `GET /shorts/<id>` with
  redirects disabled — 200 means Short, 303 means not.
- The channel resolves without any API key by scraping the public channel page
  for the canonical `/channel/UC…` link. `@kailasasanjoseus` → **`UCT08Oyc76TM1Cn84mzwuGaA`**.

---

## 5. What was built

```
src/index.js          boot, graceful shutdown, periodic state flush
src/config.js         env parsing + configProblems() warnings
src/server.js         all HTTP routes (raw-body handling for signed webhooks)
src/store.js          JSON dedupe/watchlist store, atomic writes, 45-day prune
src/notify.js         announce() — the single dedupe gate; re-arms on Slack failure
src/slack.js          chat.postMessage + Block Kit cards, rate-limit retry
src/http.js           fetch with timeout/retry/browser UA, every() safe interval
src/youtube/api.js    channel resolve, videos.list, Shorts probe, /live probe
src/youtube/feed.js   Atom parse; feedUrl vs topicUrls (see §4)
src/youtube/detect.js classify a videoId -> live/upcoming/short/video, announce
src/youtube/websub.js subscribe/renew both topic forms, HMAC-SHA1 verify
src/youtube/index.js  orchestration: seed, subscribe, 3 pollers
src/facebook/graph.js Graph client, HMAC-SHA256 verify, permalink builders
src/facebook/index.js feed + live_videos webhook handling, Graph edge poll
scripts/selftest.mjs  offline credential/behaviour check
scripts/dokploy.mjs   Dokploy API driver: probe / show / push-env / deploy / setup
Dockerfile            node:22-alpine, /data volume, healthcheck on /healthz
```

Detection layers, YouTube: WebSub push (seconds) → `videos.list` watchlist poll
(20s) → free `/live` probe (30s) → RSS backstop (60s).
Facebook: `feed` + `live_videos` webhooks (1–5s) → Graph edge poll (60s).

**First boot seeds silently** from the existing feed, so deploying does not dump
the last 15 videos into Slack.

`scripts/dokploy.mjs` is written defensively on purpose — the Dokploy API shape
was never verified (no key yet). It first tries `/swagger`, `/swagger/json`,
`/api/openapi.json`, `/openapi.json` and dumps the spec to
`dokploy-openapi.json`; failing that it probes candidate tRPC-style routes
(`project.all`, `application.saveEnvironment`, `application.deploy`, …) and
prints every attempt with its status code. Auth is sent as both `x-api-key` and
`Authorization: Bearer`. Adjust once real responses are in hand.

---

## 6. Verification actually performed

`node --env-file=.env scripts/selftest.mjs` against the live channel:

```
ok  resolve YouTube channel     @kailasasanjoseus -> UCT08Oyc76TM1Cn84mzwuGaA
ok  fetch + parse Atom feed     15 entries, newest: Gb1nzSiN5HE "#live : SRI KRISHNA JANMASHTAMI CELEBRATIONS 2026"
ok  Shorts redirect probe       Gb1nzSiN5HE is not a Short
ok  channel /live probe         not currently live
ok  YouTube Data API key        skipped (unset)
ok  Slack credentials           skipped (no token yet)
ok  Facebook Page token         skipped (disabled)
```

Full boot also exercised: channel resolved, 15 entries seeded with no Slack
posts, detectors started, `/healthz` and `/status` both answered correctly.

**Not yet verified** (blocked on credentials/deploy): WebSub end-to-end handshake
and push delivery, live-start detection against a real stream, Slack posting,
the entire Facebook path, and every Dokploy API call.

---

## 7. Open items / next steps

1. **Dokploy** — user to fill `DOKPLOY_URL` + `DOKPLOY_API_KEY` in `.env`, then
   run `node scripts/dokploy.mjs probe` and adapt the script to the real API.
2. **Slack bot token** — `xoxb-…` with `chat:write`, then `/invite` the bot into
   `C0C0PGXT46L`. Confirm with `POST /admin/test`.
3. **YouTube Data API key** — optional, free; makes live-start detection ~20s
   precise instead of ~30s and classifies Shorts reliably.
4. **Push to git** — Dokploy needs a git source. `gh` 2.83.0 is installed.
   **Nothing has been pushed anywhere yet** — the user was asked and has not
   answered. Do not push without explicit go-ahead.
5. **Facebook** — dormant until a Page token exists (§3).
6. Set `PUBLIC_URL` to the Dokploy domain and mount a volume at `/data`.

---

## 8. Conventions for future sessions

- Comment density is low and explanatory-only — comments justify *why*
  (quota math, the feed-URL trap, HMAC algorithm differences), never restate
  *what*. Match that.
- Every new detector must route through `announce()` in `src/notify.js`. Never
  call `postEvent`/`postMessage` directly from a detector.
- Never introduce a cookie-based or logged-in-scraping approach. That was an
  explicit, load-bearing constraint of the original request.
- Prefer 1-unit YouTube API calls. If a change would add a `search.list` poll,
  it's wrong — re-read §4.
- `.env` is gitignored and holds real secrets; keep `.env.example` in sync when
  adding a variable.
- Secrets generated for this project (already in `.env`): `YOUTUBE_WEBSUB_SECRET`,
  `FACEBOOK_VERIFY_TOKEN`, `ADMIN_TOKEN`, `INGEST_TOKENS`. Keep them stable —
  rotating `YOUTUBE_WEBSUB_SECRET` invalidates the current WebSub lease until the
  next re-subscribe.
- The user values a straight answer about what will and won't work over an
  optimistic one. They asked directly whether the approach would work; the
  honest split answer (YouTube yes, Facebook blocked on Page rights) is what
  they wanted.
