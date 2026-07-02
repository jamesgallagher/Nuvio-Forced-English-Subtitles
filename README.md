# Nuvio Forced English Subtitles

A self-hosted, multi-user addon for [Nuvio Media Player](https://nuvio.tv) that automatically provides English **forced** subtitles for foreign dialogue in otherwise-English content. If no forced subtitle exists for a title, it returns nothing — keeping subtitles off so you're not reading subtitles for content you can already understand.

**Example:** Playing *Black Hawk Down* → Somali dialogue scenes get subtitled. Playing *The Bear* → no subtitles at all.

This is a Nuvio-focused reimagining of [Stremio-Forced-English-Subtitles](https://github.com/jamesgallagher/Stremio-Forced-English-Subtitles). It targets Nuvio only — no Stremio backwards compatibility.

---

## Multi-user & security model

Each user gets a **private, tokenised manifest URL** — this is both the user separation and the access control:

- A visitor opens the landing page and enters *their own* OpenSubtitles credentials (validated live before anything is saved). Everyone uses their own account and their own 20-downloads/day quota.
- The server generates an unguessable 128-bit token and returns a personal manifest URL: `https://your-host/u/<token>/manifest.json`. All addon endpoints (subtitle lookup, subtitle download, configure page) live under that token.
- **The token is the authentication.** Bare endpoints (`/manifest.json`, `/subtitles/...`, `/subs/...`) return 404, as does any invalid token — probing reveals nothing.
- If a user's URL leaks, they can hit **Regenerate token** on their configure page; the old URL dies instantly.
- Credentials are stored server-side in `users.json` (mode 0600, inside the `/data` volume) — never in the URL itself.
- An optional **/admin** page (enabled by setting `ADMIN_PASSWORD`) lists users and lets you delete them. Unset, it 404s.

Upgrading from v1: an existing single-user `config.json` is migrated automatically on first start — the container log prints your new personal manifest URL. Reinstall the addon in Nuvio with that URL; the old bare `/manifest.json` no longer works.

## How it differs from the Stremio version

Nuvio installs addons through the same manifest-URL mechanism as Stremio, but handles subtitles very differently on the player side. This addon is built around those differences:

- **Nuvio fetches subtitle files directly.** There is no local Stremio proxy (`127.0.0.1:11470`) converting SRT→VTT. This addon serves clean, BOM-stripped, LF-normalised UTF-8 SRT with CORS headers, at a `.srt` URL so Nuvio's parser detects the format.
- **Nuvio has native forced-subtitle preferences.** Instead of relying on "disable every other subtitle addon", the subtitle is labelled so Nuvio's *Use Forced Subtitles* setting recognises it (`lang: en`, name "English (Forced)").
- **Nuvio is TMDB-centric.** Requests may arrive with IMDb IDs (`tt0265086`, `tt0903747:1:5`) or TMDB IDs (`tmdb:855`, `tmdb:1396:1:5`). Both are handled — OpenSubtitles supports both natively, so no extra API keys are needed.
- **Auto-apply at playback start** is handled by Nuvio's *Addon Subtitle Startup → Preferred only* setting, which fetches addon subtitles matching your preferred language as soon as a stream starts.

## How it decides a subtitle is "forced"

Same rules as the original:

1. Query OpenSubtitles for English subtitles for the title (by IMDb or TMDB ID, plus season/episode for series), ordered by download count.
2. Accept candidates with the `foreign_parts_only` metadata flag, or a release name containing forced-style keywords (`forced`, `foreign.parts`, …) while excluding SDH/HI/full-subs style names.
3. Verify by line count — a real forced track is short. Over 800 text lines → rejected, next candidate tried.
4. Return exactly **one** subtitle, or **none**.

---

## Requirements

- Each user needs an [OpenSubtitles.com](https://www.opensubtitles.com) account (free) and a free API consumer key
- A server to host the addon (Unraid recommended, or any machine that's always on)
- A public HTTPS URL (Cloudflare Tunnel recommended — free). **Note:** Nuvio's player downloads subtitle files straight from this URL on every device, so it must be publicly reachable.

---

## Step 1 — Deploy on Unraid

### Option A — Using docker-compose (recommended)

Open an Unraid terminal and run:

```
cd /mnt/user/appdata
git clone https://github.com/jamesgallagher/Nuvio-Forced-English-Subtitles.git nuvio-forced-subs
cd nuvio-forced-subs
PUBLIC_URL=https://nuvio-subs.yourdomain.com ADMIN_PASSWORD=pick-a-password docker compose up -d --build
```

### Option B — Using the Unraid Docker UI

Add a new container with these settings:

| Setting                  | Value                                      |
| ------------------------ | ------------------------------------------ |
| Container Port           | `7001`                                     |
| Host Port                | `7001`                                     |
| Container Path           | `/data`                                    |
| Host Path                | `/mnt/user/appdata/nuvio-forced-subs/data` |
| `PUBLIC_URL` env var     | `https://nuvio-subs.yourdomain.com`        |
| `ADMIN_PASSWORD` env var | optional — enables `/admin`                |

> The `/data` volume mapping is required — without it all user accounts are lost every time the container restarts.
>
> `PUBLIC_URL` is required in production — it's baked into the manifest and subtitle URLs handed to Nuvio.

## Step 2 — Set up a public HTTPS URL (Cloudflare Tunnel)

1. In [Cloudflare Zero Trust](https://one.cloudflare.com) → Networks → Tunnels → Create a tunnel
2. Add a public hostname, e.g. `nuvio-subs.yourdomain.com`
3. Point it at `http://localhost:7001`
4. Install the cloudflared connector on Unraid (available in Community Applications)

## Step 3 — Create your addon URL

1. Browse to your public URL, e.g. `https://nuvio-subs.yourdomain.com`
2. Enter your OpenSubtitles **API key** ([get one here](https://www.opensubtitles.com/en/consumers)), **username** (not your email) and **password**
3. Credentials are validated live; you're then given your **private manifest URL** — bookmark that page, the URL is the only way back to it

Anyone you share the addon with does the same with their own OpenSubtitles account and gets their own URL and quota.

## Step 4 — Install in Nuvio

1. Open Nuvio → **Settings** → **Addons**
2. Paste your personal manifest URL: `https://nuvio-subs.yourdomain.com/u/<your-token>/manifest.json`
3. Add the addon

### Recommended Nuvio settings

In **Settings → Playback → Subtitle and Audio**:

| Setting                       | Value              | Why                                                          |
| ----------------------------- | ------------------ | ------------------------------------------------------------ |
| Preferred Language            | **English**        | Lets Nuvio match this addon's subtitle to your preference    |
| Use Forced Subtitles          | **On**             | Prioritises forced tracks that match your preferred language |
| Addon Subtitle Startup        | **Preferred only** | Auto-fetches this addon's subtitle as playback starts        |
| Show Only Preferred Languages | On (optional)      | Keeps the subtitle menu clean                                 |

Also **remove the built-in OpenSubtitles v3 addon** (or move this addon above it) so full English subtitles don't compete with the forced track. When this addon returns nothing, that's intentional — the content has no forced subtitle and needs none.

---

## Updating

```
cd /mnt/user/appdata/nuvio-forced-subs
git pull
docker compose up -d --build
```

User accounts are stored in `/data/users.json` and are preserved across updates.

---

## Troubleshooting

**No subtitles appearing at all**
Check the container logs (`docker logs -f nuvio-forced-subs`). You should see `[Request]` lines when you play something. If not, check the addon is installed in Nuvio and that *Addon Subtitle Startup* is not set to **Fast startup** (that mode skips automatic addon fetching).

**Manifest URL returns 404**
The token in the URL is wrong or was regenerated/deleted. Get back to your configure page via your bookmarked URL, or create a new account from the landing page.

**Subtitle listed in Nuvio but fails to load**
Check the logs for `[Proxy]` lines. Nuvio downloads the subtitle directly from your `PUBLIC_URL`, so confirm that URL is reachable from the device running Nuvio (phone/TV), not just from the server.

**Signup says "Login failed"**
Use your OpenSubtitles **username**, not your email address.

**Subtitles showing for fully-English content**
The subtitle file on OpenSubtitles has the "forced" flag set incorrectly. The logs will show a warning about high line count. This is an OpenSubtitles data quality issue.

**Quota exceeded**
Each user's free account allows 20 downloads/day. The logs show per-user remaining quota after each download.
