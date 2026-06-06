A-Network AI Backend Deployment Guide (Render + PostgreSQL)

Goal
- Deploy AI backend without breaking mining backend.
- Keep data isolation strict between mining and AI features.

Architecture (safe)
- Existing mining backend stays as-is (separate Render service).
- New AI backend is a separate Render service from this folder.
- AI uses dedicated PostgreSQL database (recommended) or isolated DB schema/user.
- Chroma persistence uses mounted disk in Render.
- Ollama runs outside Render (recommended on a VM) and AI backend calls it over HTTPS.

Why this protects mining
- AI code lives in ai_backend only.
- AI SQL tables are namespaced with ai_ prefix.
- Mining routes in backend/server.js are untouched.
- Separate environment variables and service endpoints.

Step 1: PostgreSQL setup
1. Create a new PostgreSQL database for AI, for example: anetwork_ai.
2. Create least-privileged DB user for AI service.
3. Run schema:
   psql "postgresql://AI_DB_USER:AI_DB_PASS@HOST:5432/anetwork_ai" -f app/db/schema.sql
4. Keep mining database and mining user unchanged.

Recommended (if sharing same PostgreSQL cluster)
- Use separate DB for AI instead of sharing mining DB.
- If you must share one DB instance, use separate schema and restricted user permissions.

Step 2: Ollama setup
1. Provision a small VM with enough RAM/CPU (or GPU if available).
2. Install Ollama and pull models:
   ollama pull llama3
   ollama pull nomic-embed-text
3. Expose Ollama behind TLS/reverse proxy and IP restrictions.
4. Set OLLAMA_BASE_URL in Render to your Ollama HTTPS endpoint.

Step 3: Deploy AI backend on Render
1. Create a new Web Service in Render pointing to rmp-site/ai_backend.
2. Use Docker environment (Dockerfile is included).
3. Add persistent disk mounted at /data.
4. Set health check path: /api/v1/health
5. Add environment variables:
   APP_NAME=A-Network AI Backend
   APP_ENV=production
   API_V1_PREFIX=/api/v1
   JWT_SECRET_KEY=<long-random-secret>
   JWT_ALGORITHM=HS256
   JWT_ACCESS_TOKEN_EXPIRE_MINUTES=10080
   POSTGRES_DSN=postgresql+asyncpg://AI_DB_USER:AI_DB_PASS@HOST:5432/anetwork_ai
   CHROMA_PERSIST_DIRECTORY=/data/chroma
   CHROMA_COLLECTION=anet_user_memory
   OLLAMA_BASE_URL=https://your-ollama-endpoint
   OLLAMA_CHAT_MODEL=llama3
   OLLAMA_EMBED_MODEL=nomic-embed-text
   RAG_TOP_K=6
   CHUNK_SIZE=900
   CHUNK_OVERLAP=180

Optional
- You can apply render.yaml in this folder as baseline config.

Step 4: Smoke test after deploy
1. GET /api/v1/health should return status ok.
2. Register test user on /api/v1/auth/register.
3. Login and call /api/v1/chat/message.
4. Add memory with /api/v1/memory/text and confirm future responses use context.

Step 5: Mining-side protection checks
1. Mining service URL and env vars unchanged.
2. No changes to backend routes or mining DB schema.
3. Mining API test still passes:
   - auth
   - mining start/claim
   - leaderboard

Rollback plan
- If AI deployment fails, disable only AI service in Render.
- Mining service remains unaffected.

Production hardening checklist
- Use strong JWT secret and rotate periodically.
- Restrict CORS to mobile app domains/app origins.
- Add request rate limiting at gateway/reverse proxy.
- Enable PostgreSQL backups for AI database.
- Monitor API latency and Ollama response time.
- Add structured logs and alerting.
