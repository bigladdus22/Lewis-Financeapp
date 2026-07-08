# tradingbot.ai

AI market signals for authorised, paying users. Static frontend + Supabase backend
(auth, Postgres with row-level security, edge functions), deployed via GitHub Actions.

## Architecture

```
Browser (index.html + assets/app.js, supabase-js)
   │
   ├─ Supabase Auth ──────────── email/password sign-in & sign-up
   ├─ Postgres (RLS) ─────────── profiles · signals · api_keys · api_key_usage
   ├─ RPC create_api_key ─────── mints keys server-side, stores SHA-256 hash only
   ├─ RPC activate_account ───── marks the account paid (demo checkout)
   │
   ├─ Edge fn generate-signal ── JWT-authed; fetches 3-month Yahoo Finance closes,
   │                             scores momentum, stores + returns the signal & series
   └─ Edge fn public-api ─────── x-api-key authed; 30 req/min per key; serves the
                                 key owner's signals as JSON
```

Live backend: `https://ogvhprlgugrpzrocmqft.supabase.co` (already migrated & deployed).

## Run locally

No build step. Serve the folder over HTTP (ES modules won't load from `file://`):

```bash
npx serve .        # or: python3 -m http.server 8000
```

Open the printed URL, create an account, pay the demo fee, generate signals.

> Email confirmation is **disabled** on sign-up (`enable_confirmations = false` in
> `supabase/config.toml`) and new accounts are auto-confirmed at the database level.
> Supabase's built-in email service is rate-limited to a few messages per hour, so
> requiring an emailed OTP blocked every user after the first from signing in. To run
> a confirmed-email flow in production, configure **custom SMTP** under
> **Authentication → Emails** first, then re-enable confirmation.

## GitHub setup (one time)

1. Create a repo and push:
   ```bash
   git init && git add -A && git commit -m "tradingbot.ai v1"
   git branch -M main
   git remote add origin git@github.com:YOU/tradingbot-ai.git
   git push -u origin main
   ```
2. **Settings → Pages** → Source: *GitHub Actions*. The `deploy-pages.yml` workflow
   publishes the site on every push to `main`.
3. **Settings → Secrets and variables → Actions** → add:

   | Secret                  | Where to get it                                              |
   |-------------------------|--------------------------------------------------------------|
   | `SUPABASE_ACCESS_TOKEN` | supabase.com → Account → Access Tokens → Generate new token  |
   | `SUPABASE_DB_PASSWORD`  | Your project's database password (Project Settings → Database) |
   | `SUPABASE_PROJECT_ID`   | `ogvhprlgugrpzrocmqft`                                        |

## CI/CD

| Workflow              | Trigger                          | What it does                                        |
|-----------------------|----------------------------------|-----------------------------------------------------|
| `ci.yml`              | every PR and push to `main`      | JS syntax checks, repo structure check, `deno check` on both edge functions |
| `deploy-pages.yml`    | push to `main`                   | Deploys the static site to GitHub Pages             |
| `supabase-deploy.yml` | push to `main` touching `supabase/**` | `supabase db push` (new migrations) + redeploys both edge functions |

Day-to-day flow: branch → PR (CI runs) → merge to `main` → site and backend deploy
automatically. New schema changes go in `supabase/migrations/` as timestamped files;
existing files match the versions already applied in production, so `db push` only
applies what's new.

## Security model

- API keys are never stored — only SHA-256 hashes. The full key is shown once at creation.
- All tables have row-level security; users can only read/write their own rows.
- `public-api` uses the service-role key server-side only and authenticates callers
  by hashed API key with a 30 req/min per-key rate limit.
- The publishable key in `config.js` is designed to be public; RLS protects the data.

## Production TODOs

- **Payment**: `activate_account` is a demo. Replace with Stripe Checkout + a webhook
  edge function that sets `profiles.paid`. Stripe's GBP minimum charge is **£0.30**,
  so a literal £0.01 fee can't be card-processed.
- **Market data licence**: Yahoo Finance's endpoints are unofficial and not licensed
  for commercial use. For a paid product, switch `generate-signal` to a licensed
  provider (Polygon, Twelve Data, Finnhub — mostly a one-URL change).
- **Custom domain**: point one at GitHub Pages, then add it to Supabase Auth's
  allowed redirect URLs.

## Disclaimer

Signals are AI-generated from public market data for demonstration purposes only and
are not investment advice.
