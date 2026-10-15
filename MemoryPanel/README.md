# WeaverAI Memory Fabric — control panel

The **WeaverAI Memory Fabric** control panel (Team Memory Control) is a stateless console for managing team memory: teams, users, Agents, tasks and their Skill, Wiki, Code Graph and Chat Memory assets.

## What it does

Control is responsible for:

- serving the web management UI and the public Control API;
- checking caller credentials and forwarding authorized requests;
- aggregating metadata, memory assets and knowledge assets;
- managing asset assignment, binding and display.

Control keeps no server-side login sessions and no local user database. Business data is persisted by the external services configured at deploy time.

## Tech stack

- Backend: Node.js 22+, TypeScript, Hono, tsx
- Frontend: React 18, Vite, TypeScript, Tailwind CSS, Zustand
- Tests: Vitest
- Package managers: pnpm (backend) and npm (frontend)

## Layout

```text
src/
├── index.ts                  # service entry point
└── panel/
    ├── config/               # configuration and instance registry
    ├── domain/               # domain rules
    ├── http/                 # middleware and public routes
    ├── infra/                # logging and other infrastructure
    ├── kernel/               # external service adapters
    └── startup/              # startup tasks

web/                          # React management UI
config/                       # instance registry example and notes
docker/                       # container build files
docs/api/                     # public API contracts
scripts/                      # generation, test and security-check scripts
tests/                        # unit and E2E tests
```

## Local development

### Prerequisites

- Node.js 22 or later
- pnpm
- npm
- a reachable Memory Gateway
- a reachable Knowledge Service when you use Wiki or Code Graph

### 1. Install dependencies

```bash
pnpm install
cd web
npm install
cd ..
```

### 2. Prepare the config

```bash
cp .env.example .env
cp config/metadata-instances.example.json config/metadata-instances.json
```

Edit `config/metadata-instances.json` with the instance ID, Gateway address and API key of your deployment. The file contains credentials, is ignored by Git and must not be committed.

Environment variables are described in `.env.example`; the instance registry fields in `config/metadata-instances.README.md`.

### 3. Start the backend

```bash
pnpm dev
```

It listens on `http://127.0.0.1:8123` by default; the health check is `GET /health`.

### 4. Start the frontend

```bash
cd web
npm run dev
```

Open `http://127.0.0.1:5173` in the browser. The dev server forwards `/api/v1` and `/health` to the local Control by default.

## Common commands

| Command | Description |
|------|------|
| `pnpm dev` | start the backend dev server |
| `pnpm build` | compile the backend into `dist/` |
| `pnpm typecheck` | run the TypeScript type check |
| `pnpm test` | run the unit tests |
| `pnpm generate:meta-openapi` | generate the Meta OpenAPI document |
| `pnpm test:panel:e2e` | run the Panel Meta E2E |
| `pnpm test:knowledge:e2e` | run the Knowledge E2E |
| `cd web && npm run dev` | start the frontend dev server |
| `cd web && npm run build` | build the frontend into `web/dist/` |
| `bash scripts/secret-scan.sh` | scan for secrets |

## Public API

All public Control endpoints live under `/api/v1`:

- `/api/v1/meta/*`: instances, identity and metadata management
- `/api/v1/skill/*`: Skill management
- `/api/v1/chat-memory/*`: Chat Memory management
- `/api/v1/knowledge/*`: Wiki and Code Graph management
- `/api/v1/agent-overview/*`: Agent asset aggregation
- `/api/v1/agent/*`: Agent lifecycle operations

When integrating, the public contracts under `docs/api/` and the route registrations in the source are authoritative. External service endpoints not listed in the public contracts are not covered by Control's compatibility promise.

## Container deployment

The repository provides a single-service Control image; the default port is `8123`. See `docker/README.md` for building and running it.

At deploy time `metadata-instances.json` must be provided through a read-only mount; never bake real API keys into the image, example files or the repository.

## Security rules

- `user_key` is a user credential. Pass it only in a request header; never write it to logs, docs or frontend static assets.
- The `api_key` in the instance registry is only for server-side calls to external services and must never be returned to the browser.
- Never commit `.env`, real instance registries, smoke environment files, logs or test reports.
- Docs and examples may only use `example.com`, loopback addresses and obvious placeholders.
- Run `bash scripts/secret-scan.sh --strict` before committing.

If a credential ever entered the Git history, rotate it immediately and clean the history before publishing the repository.

## Docs

- Frontend development: `web/README.md`
- Meta API: `docs/api/meta-api.openapi.yaml`
- Knowledge API: `docs/api/knowledge-panel-api.md`
- Chat Memory API: `docs/api/chat-memory.md`
- Docker: `docker/README.md`
