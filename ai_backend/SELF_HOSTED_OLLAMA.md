# Self-Hosted Ollama Setup

This guide runs Ollama on your own Linux server and connects the A-Network AI backend on Render to it.

## Architecture

- `anetwork-ai-backend` runs on Render.
- Ollama runs on a separate Ubuntu server.
- Render calls your Ollama server over HTTPS.

Do not set `OLLAMA_BASE_URL` to `localhost` in Render. `localhost` inside Render points to the Render container, not your Ollama machine.

## Recommended Server

Minimum for light testing:

- Ubuntu 22.04 or 24.04
- 4 vCPU
- 16 GB RAM
- 80+ GB SSD

Better for smoother usage:

- 8 vCPU
- 32 GB RAM

## 1. Install Ollama on Ubuntu

SSH into your server and run:

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Verify install:

```bash
ollama --version
```

## 2. Pull Required Models

```bash
ollama pull llama3
ollama pull nomic-embed-text
```

## 3. Allow Remote Access

Create a systemd override:

```bash
sudo systemctl edit ollama
```

Paste this:

```ini
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
```

Then reload and restart:

```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
sudo systemctl status ollama
```

## 4. Open Firewall Port (Temporary Direct Access)

If using UFW:

```bash
sudo ufw allow 11434/tcp
sudo ufw status
```

Temporary test URL format:

```text
http://YOUR_SERVER_IP:11434
```

## 5. Production HTTPS Reverse Proxy

Use a domain like `ollama.a-network.net` and proxy it to `127.0.0.1:11434`.

Example Nginx config:

```nginx
server {
    listen 80;
    server_name ollama.a-network.net;

    location / {
        proxy_pass http://127.0.0.1:11434;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then add TLS using Certbot.

Final production URL example:

```text
https://ollama.a-network.net
```

## 6. Test Ollama API

From your server:

```bash
curl http://127.0.0.1:11434/api/tags
```

From outside the server after proxy/TLS:

```bash
curl https://ollama.a-network.net/api/tags
```

You should get a JSON response listing installed models.

## 7. Render Environment Variable

Set this in the Render AI service:

```env
OLLAMA_BASE_URL=https://ollama.a-network.net
OLLAMA_CHAT_MODEL=llama3
OLLAMA_EMBED_MODEL=nomic-embed-text
```

## 8. Final Render AI Env Block

```env
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
```

## 9. Health Checks

Check your Ollama server:

```bash
curl https://ollama.a-network.net/api/tags
```

Check your AI backend:

```bash
curl https://YOUR_RENDER_AI_URL/api/v1/health
```

## 10. Operational Notes

- Keep Ollama on a separate host from mining services.
- Do not expose mining credentials on the Ollama server.
- Monitor RAM use when multiple chats run concurrently.
- If usage grows, move to a bigger instance or GPU-backed server.