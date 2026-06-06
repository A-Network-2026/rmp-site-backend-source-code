# A-Network AI Backend (FastAPI)

This service replaces third-party chat platforms with your own secure, multi-tenant AI backend.

Mining-side safety:
- This AI backend is isolated in its own folder and service.
- SQL tables are namespaced with ai_ prefixes to avoid collisions.
- Use a dedicated AI PostgreSQL database URL for zero risk to mining data.

## Backend Folder Structure

```text
ai_backend/
	app/
		api/
			deps.py
			routes/
				auth.py
				chat.py
				health.py
				memory.py
				profile.py
		core/
			config.py
			security.py
		db/
			base.py
			models.py
			schema.sql
			session.py
		schemas/
			auth.py
			chat.py
			memory.py
			profile.py
		services/
			auth_service.py
			chat_service.py
			chroma_service.py
			memory_service.py
			ollama_service.py
		utils/
			text_chunking.py
		main.py
	.env.example
	Dockerfile
	render.yaml
	requirements.txt
```

## What This Service Includes

- FastAPI async REST API
- PostgreSQL for users, profiles, chat history, and long-term memory records
- ChromaDB vector memory per user for RAG
- Ollama integration using one shared base model
- JWT auth and secure user isolation
- File upload ingestion into user-private memory
- Docker + Render deployment support

## Quick Start

1. Copy env file and update values.
2. Start PostgreSQL and Ollama.
3. Create database schema.
4. Install dependencies.
5. Start API.

```bash
cp .env.example .env
pip install -r requirements.txt

# Use the sync DSN for psql CLI (for example):
# postgresql://postgres:postgres@localhost:5432/anetwork_ai
psql "postgresql://postgres:postgres@localhost:5432/anetwork_ai" -f app/db/schema.sql

uvicorn app.main:app --reload
```

## Run With Docker

```bash
docker build -t anetwork-ai-backend .
docker run --env-file .env -p 8000:8000 anetwork-ai-backend
```

## Required Ollama Models

```bash
ollama pull llama3
ollama pull nomic-embed-text
```

## API Docs

- Swagger: `/docs`
- OpenAPI JSON: `/openapi.json`

## Core Endpoints

- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `GET /api/v1/profile/me`
- `PATCH /api/v1/profile/me`
- `POST /api/v1/chat/message`
- `GET /api/v1/chat/conversations/{conversation_id}/messages`
- `POST /api/v1/memory/text`
- `POST /api/v1/memory/upload`
- `POST /api/v1/memory/training-example`

## Notes for Scale

- Chroma is persisted to disk; move to managed vector infra later if needed.
- PostgreSQL tables are indexed by `user_id` and conversation keys.
- Prompt and memory retrieval are strictly scoped to authenticated user IDs.

## Keep Mining Stable

1. Deploy this AI backend as a separate Render service from the mining backend.
2. Keep mining backend env and routes unchanged.
3. Point this service to a dedicated `POSTGRES_DSN` database.
4. Keep AI traffic on a separate API base URL (or subdomain).
