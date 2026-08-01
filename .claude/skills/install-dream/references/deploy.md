# Deploying Dream

Three paths. Ask which fits (or infer: mentioned Fly → Fly; non-technical user → Render; "my server"/VPS → Docker). Every path ends with the same verification block at the bottom.

## Path A — Fly.io (primary)

Preconditions to check IN THIS ORDER before any deploy command:

1. `fly version` — installed? If not: `curl -L https://fly.io/install.sh | sh`
2. `fly auth whoami` — logged in? If not: `fly auth login`
3. **Billing**: a brand-new Fly organization cannot place ANY machine until a payment method is on file. If you skip this, the deploy fails with `requested machine count exceeds organization limit`. Have the user add a card at https://fly.io/dashboard → Billing first. (A single shared-cpu-1x/512MB machine is a few dollars/month.)

Then, from the repo root:

```bash
fly apps create <unique-name>        # then set that name as `app` in fly.toml
fly volumes create dream_data --size 1 --region <region>   # match primary_region in fly.toml (currently ams)
fly secrets set DREAM_ACCESS_TOKEN=<generate a strong random token for them>
fly deploy --ha=false
```

Rules:
- **Never `fly launch`.** It re-plans the config and proposes a 2-machine HA setup — that both breaks Dream (SQLite on one volume; two machines = two divergent brains) and trips org machine limits.
- **Always `--ha=false`** on `fly deploy`, and never scale above 1 machine.
- If the user picks a different region, update `primary_region` in `fly.toml` AND create the volume in that region — they must match.
- Generate the access token yourself (e.g. `openssl rand -hex 24`), set it, and tell the user to save it — it's the dashboard password.

**Auto-deploy on push (optional):** the repo's GitHub Actions workflow already tests + deploys. The user adds a repo secret `FLY_API_TOKEN` (create with `fly tokens create deploy`) under GitHub → Settings → Secrets → Actions. Without the secret the workflow still runs tests and skips deploy cleanly.

## Path B — Render (one-click, no terminal — best for non-techies)

1. The repo has `render.yaml`; the button URL is `https://render.com/deploy?repo=https://github.com/<owner>/<repo>` (README has it).
2. Caveat: works directly only if the repo is public; for a private repo the user must connect their GitHub account to Render first.
3. Render generates `DREAM_ACCESS_TOKEN` automatically — tell the user it's in their service under **Environment → DREAM_ACCESS_TOKEN**; that's what the dashboard will ask for.
4. The config uses the Starter plan because memory needs a persistent disk; the free tier would wipe memory on every restart.

## Path C — Docker (any server)

```bash
docker build -t dream .
docker run -d --name dream -p 8082:8082 -v dream-data:/data \
  -e DREAM_ACCESS_TOKEN=<strong-token> dream
```

- Behind a TLS-intercepting corporate proxy, the image build supports an optional CA secret: `docker build --secret id=npm_ca,src=/path/to/ca.pem -t dream .`
- Run exactly one container per data volume.
- Put a TLS-terminating reverse proxy (Caddy/nginx) in front if it's internet-facing.

## Verification (every path, always)

1. `curl -s https://<host>/healthz` → `{"ok":true,...}`
2. `curl -s https://<host>/stats` → must be **401** (if it returns JSON with `"accessTokenSet":false`, STOP and set the token — transcripts would be public).
3. Open `https://<host>/ui/` → "Get started" page loads, unlock with the token.
4. End-to-end: in the dashboard Playground, paste a real model API key and send one message; confirm a reply and that the stats bar appears. (Without a key: at least confirm `/v1/messages` with no key returns the upstream's own `authentication_error`, proving passthrough.)
5. Crawler block: `curl -s https://<host>/robots.txt` begins `User-agent: *` / `Disallow: /`.
