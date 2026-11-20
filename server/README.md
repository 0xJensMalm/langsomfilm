# langsomfilm-api

Small password-protected API that lets the site's edit mode save films, bio and images.
Runs on the Vultr server in `/root/langsomfilm-api`, behind Caddy at `https://api.langsomfilm.no`.

- `POST /login {username, password}` → `{token}` (valid 60 days)
- `GET /content` → current `site` + `films` from the repo
- `POST /save {site, films}` → new images (data URLs) are written to `assets/uploads/`, JSON to `content/`,
  committed and pushed to `main`; GitHub Pages republishes in about a minute.

Secrets live only on the server: `.env` (ADMIN_USERNAME, ADMIN_PASSWORD, SESSION_SECRET) and `keys/id_ed25519`
(a write deploy key for this repo only).

Deploy: copy `server.mjs`, `Dockerfile`, `compose.yml` to the server, then `docker compose up -d --build`.
Change password: edit `ADMIN_PASSWORD` in `.env`, then `docker compose up -d`.
