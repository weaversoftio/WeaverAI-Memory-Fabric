# Team Memory Control Web

The web management UI of Team Memory Control. It talks to the stateless Control service in the same repository.

## Tech stack

- React 18
- TypeScript
- Vite
- React Router
- Zustand
- Tailwind CSS

## Local development

First start Control from the repository root:

```bash
pnpm install
cp .env.example .env
cp config/metadata-instances.example.json config/metadata-instances.json
pnpm dev
```

Then start the frontend:

```bash
cd web
npm install
cp .env.example .env
npm run dev
```

Open `http://127.0.0.1:5173` in the browser.

## Dev proxy

Defaults in `vite.config.ts`:

| Request prefix | Default target | Environment variable |
|----------|----------|----------|
| `/api/v1`, `/health` | `http://127.0.0.1:8123` | `VITE_TMC_BACKEND_URL` |
| `/v3` | `http://127.0.0.1:8420` | `VITE_SKILL_GATEWAY_URL` |

To connect to another dev environment, put the real addresses in an uncommitted `web/.env`. Never write internal addresses, accounts or credentials into the README, the source or tracked env files.

## Build

```bash
npm run build
```

The output goes to `web/dist/`. Control can serve these static files from the same origin with `UI_DIST_DIR=./web/dist`.

## Languages

The UI ships in English (`en-US`) and Hebrew (`he-IL`, right-to-left). The strings live in `src/i18n/`; use the language switcher in the header to change language.

## API boundary

The frontend uses these Control APIs:

- `/api/v1/meta/*`
- `/api/v1/skill/*`
- `/api/v1/chat-memory/*`
- `/api/v1/knowledge/*`
- `/api/v1/agent-overview/*`
- `/api/v1/agent/*`

Login credentials are kept in the browser's `localStorage`; business requests send them in the `X-Wamf-Service-Id` and `X-Wamf-User-Key` headers. The frontend must never log, display or upload the full credentials.

The public contracts under `docs/api/` are authoritative for API integration; external service endpoints not listed there are outside the frontend's scope.

## Common commands

| Command | Description |
|------|------|
| `npm run dev` | start the dev server |
| `npm run build` | type-check and build |
| `npm run preview` | preview the build output |
| `npm run lint:check` | run ESLint |
| `npm run format:check` | check formatting |
