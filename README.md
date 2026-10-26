# Room Reset — MVP

One photo (or one spot) in, three tiny steps out. Built to validate the PRD's Phase 1 at **£0**.

## What's in the box

| File | What it does |
| --- | --- |
| `index.html` | The page shell |
| `styles.css` | Mobile-first styles, light and dark |
| `app.js` | All screens: home, spot picker, choose, do (with optional 2-minute timer), celebrate, stop, resume, progress photos, analytics |
| `steps-library.js` | Built-in tiny steps for each spot, plus starter steps used whenever the AI is unavailable |
| `api/steps.js` | Vercel serverless function: sends the compressed photo to Google Gemini's free tier and returns 3 steps |

No build step, no npm packages, no database.

## Why it costs nothing

- **Hosting:** Vercel Hobby plan (free).
- **AI:** Google Gemini API free tier. Create the key in Google AI Studio **without** adding a billing account, so it can never charge you. If the free quota runs out or Gemini is too busy (it can be slow at peak times), the app shows built-in steps and tells the tester they are general, not from their photo.
- **Spot picker:** no AI at all.
- **Analytics:** events are kept on each device (open `?debug=1` to see and download them). Optionally, connect PostHog's free plan to collect them from every tester in one place.

> Privacy trade-off: on Gemini's free tier, Google may use what you send to improve its products. The app tells testers this before they take a photo. Before a public launch, move to a paid tier or another provider that doesn't train on your data.

## Open it in Antigravity

1. In Antigravity, choose **Open Folder** and select this `room-reset` folder.
2. Paste this into the agent if you want it to check the project first:

```text
This is a no-build static web app (index.html, styles.css, app.js, steps-library.js)
with one Vercel serverless function in api/steps.js. Read every file, explain how
the flow works, and do not add frameworks, npm packages or a build step. Then help
me run it locally with `npx vercel dev` so /api/steps works.
```

## Run it locally

You need Node.js (free, from nodejs.org) for the API to work locally.

```bash
npx vercel dev
```

Then open http://localhost:3000. Without `GEMINI_API_KEY`, photos fall back to built-in steps, which is useful for testing that path.

## Get a free Gemini key

1. Go to https://aistudio.google.com and sign in with a Google account.
2. Click **Get API key** → **Create API key**. Do not set up billing.
3. Keep the key private. Never put it in `app.js` or commit it to GitHub.

## Put it on GitHub

Use Antigravity's Source Control panel, or GitHub Desktop (free):

1. Create a new **private** repository called `room-reset`.
2. Commit all files in this folder and push.

## Deploy on Vercel

1. Sign in at https://vercel.com with GitHub (Hobby plan).
2. **Add New → Project**, import `room-reset`. Framework preset: **Other**. No build command.
3. Under **Environment Variables**, add `GEMINI_API_KEY` = your key.
4. Optional: add `GEMINI_MODEL` if you want a different free model (tried first; then `gemini-flash-lite-latest`, `gemini-flash-latest` and `gemini-3.5-flash-lite`).
5. Deploy. Every push to GitHub redeploys automatically.

## Optional: collect test data with PostHog (free)

1. Create a free PostHog Cloud **EU** account and project.
2. Copy the project API key into `POSTHOG_KEY` at the top of `app.js` (this key is designed to be public).
3. Build a funnel: `app_open` → `steps_shown` → `step_chosen` → `step_done`, broken down by `arm`.

## Map to the PRD metrics

| PRD metric | Event(s) |
| --- | --- |
| Key: first-step completion | `app_open` (new_user) → `step_done` with `first: true`, by `arm` |
| Time to first "Done" | `ms_since_open` on `step_done` (first) |
| Activation: aha in under 2 minutes (R10) | `step_done` with `first_ever: true` and `ms_since_open` under 120000 |
| Add to Home Screen | `install_hint_shown`, `install_prompt_result`, `install_hint_dismissed`, `app_installed`; returning from the icon shows `from_homescreen: true` on `app_open` |
| 7-day return | a second `app_open` session from the same person within 7 days |
| Steps per session | `n` on the last `step_done` per `session` |
| Guardrail: 3× easier then leave | `step_easier` with `n: 3` followed by `page_hide` |
| Guardrail: feeling | `feeling` (better / same / worse) |
| Guardrail: suggestion failures | `steps_fallback` and `photo_unclear` ÷ `photo_submitted` |
| Step quality | `step_feedback` (up / down) with the step text |

## Testing tips

- Force a test group: `?arm=photo_first` or `?arm=picker_first` (only for your own testing; real testers are split 50/50 automatically).
- See events on a device: `?debug=1`.
- Daily free photo starts: `DAILY_PHOTO_CAP` in `app.js` (default 5).

## When a photo gets general steps

Open the site with `?debug=1` and look at the `steps_fallback` event. It lists every model tried and what it said:

| You see | Meaning |
| --- | --- |
| `:timeout` or `:503` on every model | Gemini's free tier is busy; try again later or at an off-peak time |
| `:429` | That model's free quota is used up; it resets at midnight Pacific time (8am UK) |
| `:404` | Google retired that model name; set `GEMINI_MODEL` to the replacement it names |

## Photo AI providers

Photos go to **Cloudflare Workers AI** first (Mistral Small 3.1, free daily allowance), then fall back to **Google Gemini** if Cloudflare fails. In live tests on 26 October 2026, Gemini's free tier refused or timed out on every model, while Cloudflare answered real room photos in 7–10 seconds with accurate steps.

| Vercel variable | What it is |
| --- | --- |
| `CF_ACCOUNT_ID` | The 32-character code in your Cloudflare dashboard address (`dash.cloudflare.com/<this>/home`) |
| `CF_API_TOKEN` | A Cloudflare API token with **Account · Workers AI · Edit** for your account (use the Workers AI template) |
| `CF_MODEL` | Optional; defaults to `@cf/mistralai/mistral-small-3.1-24b-instruct` |
| `GEMINI_API_KEY` | Backup provider |

Check the setup at `/api/steps?models=1`: the `config` block shows yes/no for each setting (never values) and Cloudflare's own token check. Workers AI's free allowance resets daily at 00:00 UTC; watch usage in the Cloudflare dashboard under Workers AI.
