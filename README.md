# LinkedIn Poster

A small, self-hosted approval workflow: a draft gets added, you review/edit it on a simple
password-protected dashboard, and clicking **"Approve & Post"** publishes it to your own
personal LinkedIn profile. Nothing posts automatically without that click.

This does **not** auto-reply to comments — LinkedIn's public API doesn't offer a reliable
way to do that for third-party apps, and automating replies risks your account's standing.
Keep replies manual.

---

## 1. Create a LinkedIn Developer app (free, same-day for personal posting)

1. Go to [linkedin.com/developers/apps](https://www.linkedin.com/developers/apps) and click **Create app**.
2. Fill in the required fields (app name, your LinkedIn Page — you can use your personal
   profile's associated page, or create a simple one if required).
3. Once created, go to the **Products** tab and add **"Share on LinkedIn"**. This is the
   self-serve product — no lengthy partner review needed, since you're only posting to your
   own profile.
4. Go to the **Auth** tab:
   - Copy your **Client ID** and **Client Secret** — you'll need these in step 3.
   - Under **Authorized redirect URLs**, add the callback URL you'll use (see step 2).

## 2. Configure this project

1. Copy `.env.example` to `.env`:
   ```
   cp .env.example .env
   ```
2. Fill in:
   - `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` — from step 1.
   - `LINKEDIN_REDIRECT_URI` — must **exactly** match what you added in LinkedIn's
     Auth settings. For local testing: `http://localhost:3000/auth/linkedin/callback`.
   - `DASHBOARD_PASSWORD` — make up a long, random password. This protects the
     dashboard so nobody else can post to your LinkedIn from it.

## 3. Run it locally (to test)

```bash
npm install
npm start
```

Then:
1. Visit `http://localhost:3000/auth/linkedin` and authorize your LinkedIn account.
2. Visit `http://localhost:3000` — you'll be prompted for the dashboard password
   (username can be left blank).
3. Add a draft, review it, and click **Approve & Post** to publish for real.

## 4. Deploy it somewhere permanent

Running it only on your laptop means it's only reachable while your laptop is on and
connected. To actually use this day-to-day, deploy it to a small always-on host — any of
these have a free tier suitable for this:

- **Render** (render.com) — easiest for a small Node app like this.
- **Railway** (railway.app)
- **Fly.io**

The steps are the same everywhere:
1. Push this project to a GitHub repo (keep `.env` out of it — it's already gitignored-style;
   double check before pushing).
2. Connect the repo to your chosen host.
3. Set the same environment variables from your `.env` file in the host's dashboard/secrets
   settings — **do not commit real credentials to GitHub.**
4. Update `LINKEDIN_REDIRECT_URI` to your new live URL (e.g.
   `https://your-app.onrender.com/auth/linkedin/callback`) — and add that exact URL to your
   LinkedIn app's Authorized redirect URLs too.
5. Re-run the one-time `/auth/linkedin` authorization against the live URL.

## Where drafts come from

Right now, drafts are added manually through the dashboard's "New draft" box — paste in
whatever text (and optional image URL) you want to post. If you want Claude to push drafts
here directly instead of you copy-pasting, the `POST /api/drafts` endpoint (used by the
dashboard itself) can be called from anywhere with the right password — that's a natural
next integration once this is deployed and running.

## Rate limits

LinkedIn allows roughly 100–150 posts per member per day — irrelevant for a once-a-day
posting cadence, just worth knowing it exists.

## Security notes

- `token-store.json` holds your live LinkedIn access token in plain text. This is fine for
  a personal, single-user deployment on a host only you control. If this ever needs to
  support multiple people or a more sensitive setup, replace it with a real secrets
  manager or encrypted database before going further.
- Keep `DASHBOARD_PASSWORD` private — anyone with it can post to your LinkedIn account
  through this dashboard.
