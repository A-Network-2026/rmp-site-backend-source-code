A-Network AI Backend Copy-Paste Deployment

1) PostgreSQL: Create dedicated AI database and load schema

Copy and run in psql as admin user:

CREATE DATABASE anetwork_ai;

Then run:

\c anetwork_ai;
\i app/db/schema.sql;

If you are running from shell directly:

psql "postgresql://postgres:postgres@localhost:5432/anetwork_ai" -f app/db/schema.sql

2) Render: New service settings (AI only)

Service type:
- Web Service (Docker)

Root directory:
- rmp-site/ai_backend

Health check path:
- /api/v1/health

Persistent disk:
- mount path: /data
- size: 5 GB (or higher)

3) Render env vars (copy-paste)

APP_NAME=A-Network AI Backend
APP_ENV=production
API_V1_PREFIX=/api/v1
JWT_SECRET_KEY=REPLACE_WITH_LONG_RANDOM_SECRET
JWT_ALGORITHM=HS256
JWT_ACCESS_TOKEN_EXPIRE_MINUTES=10080
POSTGRES_DSN=postgresql+asyncpg://AI_DB_USER:AI_DB_PASSWORD@AI_DB_HOST:5432/anetwork_ai
CHROMA_PERSIST_DIRECTORY=/data/chroma
CHROMA_COLLECTION=anet_user_memory
OLLAMA_BASE_URL=https://ollama.a-network.net
OLLAMA_CHAT_MODEL=llama3
OLLAMA_EMBED_MODEL=nomic-embed-text
RAG_TOP_K=6
CHUNK_SIZE=900
CHUNK_OVERLAP=180

4) Ollama host prep

Run on your Ollama host:

ollama pull llama3
ollama pull nomic-embed-text

See the full setup guide here:

- SELF_HOSTED_OLLAMA.md

5) Smoke tests after deploy

Health:

curl -X GET "https://YOUR_AI_RENDER_URL/api/v1/health"

Register:

curl -X POST "https://YOUR_AI_RENDER_URL/api/v1/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"StrongPass123"}'

Login:

curl -X POST "https://YOUR_AI_RENDER_URL/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"StrongPass123"}'

Add memory text:

curl -X POST "https://YOUR_AI_RENDER_URL/api/v1/memory/text" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"My preferred response style is concise and action-oriented.","source_type":"manual"}'

Add training example:

curl -X POST "https://YOUR_AI_RENDER_URL/api/v1/memory/training-example" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"How do I prepare a release?","ideal_response":"Use checklist, test, build, and verify artifacts.","tags":{"domain":"devops"}}'

Chat:

curl -X POST "https://YOUR_AI_RENDER_URL/api/v1/chat/message" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"How should you answer me?"}'

6) Mining-side safety rules

- Do not edit existing mining service env vars.
- Do not point mining backend to AI database.
- Keep mining and AI as separate Render services.
- Keep existing mining route prefixes unchanged.
