const jwt = require('jsonwebtoken');
const db = require('../db');
const verifyToken = require('../middleware/auth');

const MAX_MEMORY_ITEMS = Math.max(10, Number(process.env.AI_MAX_MEMORY_ITEMS || 200));
const MAX_CONTEXT_ITEMS = Math.max(5, Number(process.env.AI_MAX_CONTEXT_ITEMS || 20));
const MAX_CONTEXT_CHARS = Math.max(2000, Number(process.env.AI_MAX_CONTEXT_CHARS || 16000));
const MAX_TRAINING_EXAMPLES = Math.max(20, Number(process.env.AI_MAX_TRAINING_EXAMPLES || 500));
const MAX_PROMPT_EXAMPLES = Math.max(2, Number(process.env.AI_MAX_PROMPT_EXAMPLES || 8));
const RUN_CHATBOT_SCHEMA_SYNC_STARTUP = String(process.env.RUN_CHATBOT_SCHEMA_SYNC_STARTUP || 'false').trim().toLowerCase() === 'true';

let chatbotSchemaInitPromise = null;

const ISO_LANG_RE = /^[a-z]{2,3}(-[A-Z]{2})?$/;

function normalizeText(value, maxLen = 12000) {
  return String(value || '').trim().slice(0, maxLen);
}

function normalizeMimeType(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeLanguageCode(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  if (!ISO_LANG_RE.test(raw)) {
    return '';
  }
  return raw;
}

function normalizeLanguageList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const out = [];
  for (const item of value) {
    const normalized = normalizeLanguageCode(item);
    if (normalized && !out.includes(normalized)) {
      out.push(normalized);
    }
  }
  return out.slice(0, 20);
}

async function ensureAiTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ai_user_memory (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      owner_key TEXT NOT NULL,
      category VARCHAR(64) NOT NULL DEFAULT 'general',
      memory_text TEXT NOT NULL,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS ai_user_knowledge_files (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      owner_key TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type VARCHAR(120) NOT NULL,
      storage_url TEXT,
      extracted_text TEXT,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_user_memory_user_created
    ON ai_user_memory(user_id, created_at DESC)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_user_files_user_created
    ON ai_user_knowledge_files(user_id, created_at DESC)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_user_memory_owner_key
    ON ai_user_memory(owner_key)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_user_files_owner_key
    ON ai_user_knowledge_files(owner_key)
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS ai_user_language_profiles (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      owner_key TEXT NOT NULL,
      preferred_language VARCHAR(16) DEFAULT 'en',
      auto_detect BOOLEAN NOT NULL DEFAULT FALSE,
      allowed_languages JSONB DEFAULT '[]'::jsonb,
      response_style TEXT,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Enforce English-first default for existing installations as well.
  await db.query(`
    ALTER TABLE ai_user_language_profiles
    ALTER COLUMN preferred_language SET DEFAULT 'en'
  `);

  await db.query(`
    ALTER TABLE ai_user_language_profiles
    ALTER COLUMN auto_detect SET DEFAULT FALSE
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS ai_user_training_examples (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      owner_key TEXT NOT NULL,
      language_code VARCHAR(16) DEFAULT 'en',
      input_text TEXT NOT NULL,
      ideal_response TEXT NOT NULL,
      tags JSONB DEFAULT '[]'::jsonb,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_language_profile_user
    ON ai_user_language_profiles(user_id)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_training_examples_user
    ON ai_user_training_examples(user_id, created_at DESC)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_training_examples_lang
    ON ai_user_training_examples(user_id, language_code)
  `);
}

async function loadOwnerIdentity(userId) {
  const userRes = await db.query(
    `SELECT
       id,
       email,
       referral_code,
       referred_by,
       custom_wallet_address,
       wallet_address,
       evm_connected_address
     FROM users
     WHERE id = $1
       AND COALESCE(is_deleted, FALSE) = FALSE`,
    [userId]
  );

  const user = userRes.rows[0];
  if (!user) {
    return null;
  }

  const migrationWallet =
    String(user.custom_wallet_address || '').trim() ||
    String(user.wallet_address || '').trim() ||
    String(user.evm_connected_address || '').trim() ||
    '';

  const referralCode = String(user.referral_code || '').trim();
  const colonyBase = referralCode || (user.referred_by ? `upline-${user.referred_by}` : 'solo');

  const ownerKey = [
    `uid:${user.id}`,
    `mw:${migrationWallet || 'none'}`,
    `ref:${referralCode || 'none'}`,
    `colony:${colonyBase}`,
  ].join('|');

  return {
    userId: user.id,
    email: user.email,
    migrationWallet,
    referralCode,
    colonyBase,
    ownerKey,
  };
}

function buildContextPayload({ owner, memoryRows, fileRows }) {
  const memoryItems = [];
  const fileItems = [];
  let usedChars = 0;

  for (const row of memoryRows) {
    if (memoryItems.length >= MAX_CONTEXT_ITEMS) {
      break;
    }
    const text = normalizeText(row.memory_text, 2400);
    if (!text) {
      continue;
    }
    if ((usedChars + text.length) > MAX_CONTEXT_CHARS) {
      break;
    }
    usedChars += text.length;
    memoryItems.push({
      id: row.id,
      category: row.category,
      text,
      createdAt: row.created_at,
      metadata: row.metadata || {},
    });
  }

  for (const row of fileRows) {
    if (fileItems.length >= MAX_CONTEXT_ITEMS) {
      break;
    }
    const extractedText = normalizeText(row.extracted_text, 2400);
    if (!extractedText) {
      continue;
    }
    if ((usedChars + extractedText.length) > MAX_CONTEXT_CHARS) {
      break;
    }
    usedChars += extractedText.length;
    fileItems.push({
      id: row.id,
      fileName: row.file_name,
      mimeType: row.mime_type,
      extractedText,
      storageUrl: row.storage_url || null,
      createdAt: row.created_at,
      metadata: row.metadata || {},
    });
  }

  return {
    owner,
    limits: {
      maxContextItems: MAX_CONTEXT_ITEMS,
      maxContextChars: MAX_CONTEXT_CHARS,
      usedChars,
    },
    memoryItems,
    fileItems,
  };
}

function buildSystemInstruction({ owner, languageProfile, trainingExamples }) {
  const preferredLanguage = languageProfile?.preferred_language || 'en';
  const autoDetect = Boolean(languageProfile?.auto_detect ?? false);
  const allowedLanguages = Array.isArray(languageProfile?.allowed_languages)
    ? languageProfile.allowed_languages
    : [];
  const responseStyle = normalizeText(languageProfile?.response_style || '', 300);

  const lines = [
    'You are the in-app A-Network AI assistant.',
    `Owner identity key: ${owner.ownerKey}`,
    'Always preserve owner context and never mix context with another user.',
    autoDetect
      ? 'Detect the user language automatically from the latest message and respond in that language.'
      : `Use preferred language by default: ${preferredLanguage}.`,
    'Support multilingual interactions, including mixed-language messages, while keeping factual consistency.',
    'If the user asks for translation, provide direct translation without changing core meaning.',
  ];

  if (allowedLanguages.length > 0) {
    lines.push(`Prioritized languages: ${allowedLanguages.join(', ')}.`);
  }

  if (responseStyle) {
    lines.push(`Preferred response style: ${responseStyle}`);
  }

  if (trainingExamples.length > 0) {
    lines.push('Follow these user-provided training examples as behavior guidance:');
    trainingExamples.forEach((example, idx) => {
      lines.push(`Example ${idx + 1} [${example.language_code || 'en'}]`);
      lines.push(`User input pattern: ${normalizeText(example.input_text, 500)}`);
      lines.push(`Preferred response pattern: ${normalizeText(example.ideal_response, 700)}`);
    });
  }

  return lines.join('\n');
}

function startChatbotSchemaSetup(fastify) {
  if (!chatbotSchemaInitPromise) {
    chatbotSchemaInitPromise = ensureAiTables().catch((err) => {
      chatbotSchemaInitPromise = null;
      throw err;
    });

    if (fastify) {
      chatbotSchemaInitPromise
        .then(() => {
          fastify.log.info('Chatbot startup schema checks completed');
        })
        .catch((err) => {
          fastify.log.error(err, 'Chatbot startup schema checks failed');
        });
    }
  }

  return chatbotSchemaInitPromise;
}

module.exports = async function (fastify) {
  const CHATBASE_BOT_ID = process.env.CHATBASE_BOT_ID || 'U4UFbbJofKx_YPZ8xVxbh';

  if (RUN_CHATBOT_SCHEMA_SYNC_STARTUP) {
    await startChatbotSchemaSetup(fastify);
  } else {
    fastify.log.info('Chatbot startup schema checks skipped (RUN_CHATBOT_SCHEMA_SYNC_STARTUP=false)');
  }

  fastify.addHook('preHandler', async (req, reply) => {
    if (!RUN_CHATBOT_SCHEMA_SYNC_STARTUP) {
      return;
    }

    if (String(req.url || '').includes('/widget')) {
      return;
    }

    try {
      await startChatbotSchemaSetup(fastify);
    } catch (_) {
      return reply.code(503).send({ error: 'AI service is temporarily busy. Please retry.' });
    }
  });

  /// GET /chatbot/widget — serves the Chatbase AI Support page
  fastify.get('/widget', async (req, reply) => {
    const identityToken = String(req.query.token || '').trim();

    const identifySnippet = identityToken
      ? `window.chatbase("identify", { token: ${JSON.stringify(identityToken)} });`
      : '';

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <title>A-Network AI Support</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:100%;height:100%;background:#07111F;overflow:hidden;font-family:Arial,sans-serif}
    .loading{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#D9F7FF;letter-spacing:.04em;background:radial-gradient(circle at top,#0F1C2E 0%,#07111F 70%);z-index:9999;transition:opacity .3s}
    .spinner{width:36px;height:36px;border:3px solid rgba(74,184,255,.2);border-top:3px solid #4AB8FF;border-radius:50%;animation:spin .8s linear infinite;margin-bottom:16px}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style>
</head>
<body>
  <div class="loading" id="lo"><div class="spinner"></div><div>Loading AI Support...</div></div>
  <script>
    (function(){
      if(!window.chatbase||window.chatbase("getState")!=="initialized"){
        window.chatbase=function(){if(!window.chatbase.q)window.chatbase.q=[];window.chatbase.q.push(arguments)};
        window.chatbase=new Proxy(window.chatbase,{get:function(t,p){return p==="q"?t.q:function(){return t(p,...arguments)}}});
      }
      var s=document.createElement("script");
      s.src="https://www.chatbase.co/embed.min.js";
      s.id="${CHATBASE_BOT_ID}";
      s.domain="www.chatbase.co";
      s.defer=true;
      s.onload=function(){
        var el=document.getElementById("lo");
        if(el){el.style.opacity="0";setTimeout(function(){el.style.display="none"},300)}
        ${identifySnippet}
      };
      document.body.appendChild(s);
    })();
  </script>
</body>
</html>`;

    reply.type('text/html').send(html);
  });

  /// GET /chatbot/token — returns a signed JWT for Chatbase identity verification (authenticated)
  fastify.get('/token', { preHandler: verifyToken }, async (req, reply) => {
    const secret = process.env.CHATBOT_IDENTITY_SECRET;
    if (!secret) {
      return reply.code(503).send({ error: 'Chatbot identity not configured' });
    }

    const userId = req.user?.userId || req.user?.id;
    if (!userId) {
      return reply.code(401).send({ error: 'Invalid session' });
    }

    const userRes = await db.query(
      `SELECT id, email, referral_code FROM users WHERE id = $1 AND COALESCE(is_deleted, FALSE) = FALSE`,
      [userId]
    );
    const user = userRes.rows[0];
    if (!user) {
      return reply.code(404).send({ error: 'User not found' });
    }

    const payload = {
      user_id: String(user.id),
      email: user.email,
      referral_code: user.referral_code || null,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    const chatToken = jwt.sign(payload, secret, { algorithm: 'HS256' });
    return { token: chatToken };
  });

  /// GET /chatbot/owner-profile — stable AI ownership identity (wallet + referral + colony base)
  fastify.get('/owner-profile', { preHandler: verifyToken }, async (req, reply) => {
    const userId = req.user?.userId || req.user?.id;
    const owner = await loadOwnerIdentity(userId);
    if (!owner) {
      return reply.code(404).send({ error: 'User not found' });
    }

    return owner;
  });

  /// GET /chatbot/language-profile — get multilingual AI behavior profile
  fastify.get('/language-profile', { preHandler: verifyToken }, async (req, reply) => {
    const userId = req.user?.userId || req.user?.id;
    const owner = await loadOwnerIdentity(userId);
    if (!owner) {
      return reply.code(404).send({ error: 'User not found' });
    }

    const profileRes = await db.query(
      `SELECT preferred_language, auto_detect, allowed_languages, response_style, metadata, created_at, updated_at
       FROM ai_user_language_profiles
       WHERE user_id = $1
       LIMIT 1`,
      [owner.userId]
    );

    if (!profileRes.rows[0]) {
      return {
        owner,
        profile: {
          preferred_language: 'en',
          auto_detect: false,
          allowed_languages: [],
          response_style: null,
          metadata: {},
        },
      };
    }

    return { owner, profile: profileRes.rows[0] };
  });

  /// POST /chatbot/language-profile — set multilingual AI behavior profile
  fastify.post('/language-profile', { preHandler: verifyToken }, async (req, reply) => {
    const userId = req.user?.userId || req.user?.id;
    const owner = await loadOwnerIdentity(userId);
    if (!owner) {
      return reply.code(404).send({ error: 'User not found' });
    }

    const preferredLanguage = normalizeLanguageCode(req.body?.preferredLanguage || 'en') || 'en';
    const autoDetect = req.body?.autoDetect === true;
    const allowedLanguages = normalizeLanguageList(req.body?.allowedLanguages);
    const responseStyle = normalizeText(req.body?.responseStyle, 500);
    const metadata = req.body?.metadata && typeof req.body.metadata === 'object'
      ? req.body.metadata
      : {};

    const upsertRes = await db.query(
      `INSERT INTO ai_user_language_profiles
       (user_id, owner_key, preferred_language, auto_detect, allowed_languages, response_style, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb)
       ON CONFLICT (user_id)
       DO UPDATE SET
         owner_key = EXCLUDED.owner_key,
         preferred_language = EXCLUDED.preferred_language,
         auto_detect = EXCLUDED.auto_detect,
         allowed_languages = EXCLUDED.allowed_languages,
         response_style = EXCLUDED.response_style,
         metadata = EXCLUDED.metadata,
         updated_at = CURRENT_TIMESTAMP
       RETURNING preferred_language, auto_detect, allowed_languages, response_style, metadata, created_at, updated_at`,
      [
        owner.userId,
        owner.ownerKey,
        preferredLanguage,
        autoDetect,
        JSON.stringify(allowedLanguages),
        responseStyle || null,
        JSON.stringify(metadata),
      ]
    );

    return { ok: true, owner, profile: upsertRes.rows[0] };
  });

  /// POST /chatbot/train — add user-provided AI training example
  fastify.post('/train', { preHandler: verifyToken }, async (req, reply) => {
    const userId = req.user?.userId || req.user?.id;
    const owner = await loadOwnerIdentity(userId);
    if (!owner) {
      return reply.code(404).send({ error: 'User not found' });
    }

    const languageCode = normalizeLanguageCode(req.body?.languageCode || 'en') || 'en';
    const inputText = normalizeText(req.body?.inputText, 4000);
    const idealResponse = normalizeText(req.body?.idealResponse, 8000);
    const tags = Array.isArray(req.body?.tags)
      ? req.body.tags.map((v) => normalizeText(v, 64)).filter(Boolean).slice(0, 20)
      : [];
    const metadata = req.body?.metadata && typeof req.body.metadata === 'object'
      ? req.body.metadata
      : {};

    if (!inputText || !idealResponse) {
      return reply.code(400).send({ error: 'inputText and idealResponse are required' });
    }

    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM ai_user_training_examples WHERE user_id = $1`,
      [owner.userId]
    );
    const currentCount = Number(countRes.rows[0]?.total || 0);
    if (currentCount >= MAX_TRAINING_EXAMPLES) {
      return reply.code(429).send({
        error: `Training example limit reached (${MAX_TRAINING_EXAMPLES}). Remove old examples first.`,
      });
    }

    const insertRes = await db.query(
      `INSERT INTO ai_user_training_examples
       (user_id, owner_key, language_code, input_text, ideal_response, tags, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
       RETURNING id, language_code, input_text, ideal_response, tags, metadata, created_at, updated_at`,
      [
        owner.userId,
        owner.ownerKey,
        languageCode,
        inputText,
        idealResponse,
        JSON.stringify(tags),
        JSON.stringify(metadata),
      ]
    );

    return { ok: true, owner, item: insertRes.rows[0] };
  });

  /// GET /chatbot/train — list user AI training examples
  fastify.get('/train', { preHandler: verifyToken }, async (req, reply) => {
    const userId = req.user?.userId || req.user?.id;
    const owner = await loadOwnerIdentity(userId);
    if (!owner) {
      return reply.code(404).send({ error: 'User not found' });
    }

    const limit = Math.max(1, Math.min(200, Number(req.query?.limit || 50)));
    const languageCode = normalizeLanguageCode(req.query?.languageCode || '');

    let rowsRes;
    if (languageCode) {
      rowsRes = await db.query(
        `SELECT id, language_code, input_text, ideal_response, tags, metadata, created_at, updated_at
         FROM ai_user_training_examples
         WHERE user_id = $1 AND language_code = $2
         ORDER BY created_at DESC
         LIMIT $3`,
        [owner.userId, languageCode, limit]
      );
    } else {
      rowsRes = await db.query(
        `SELECT id, language_code, input_text, ideal_response, tags, metadata, created_at, updated_at
         FROM ai_user_training_examples
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [owner.userId, limit]
      );
    }

    return {
      owner,
      total: rowsRes.rows.length,
      items: rowsRes.rows,
    };
  });

  /// POST /chatbot/memory — persist user AI memory (survives app cache/data clear)
  fastify.post('/memory', { preHandler: verifyToken }, async (req, reply) => {
    const userId = req.user?.userId || req.user?.id;
    const owner = await loadOwnerIdentity(userId);
    if (!owner) {
      return reply.code(404).send({ error: 'User not found' });
    }

    const category = normalizeText(req.body?.category || 'general', 64).toLowerCase();
    const memoryText = normalizeText(req.body?.memoryText || req.body?.text, 12000);
    const metadata = req.body?.metadata && typeof req.body.metadata === 'object'
      ? req.body.metadata
      : {};

    if (!memoryText) {
      return reply.code(400).send({ error: 'memoryText is required' });
    }

    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM ai_user_memory WHERE user_id = $1`,
      [owner.userId]
    );
    const currentCount = Number(countRes.rows[0]?.total || 0);
    if (currentCount >= MAX_MEMORY_ITEMS) {
      return reply.code(429).send({
        error: `Memory limit reached (${MAX_MEMORY_ITEMS}). Archive or delete old memory first.`,
      });
    }

    const insertRes = await db.query(
      `INSERT INTO ai_user_memory (user_id, owner_key, category, memory_text, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id, user_id, owner_key, category, memory_text, metadata, created_at, updated_at`,
      [owner.userId, owner.ownerKey, category || 'general', memoryText, JSON.stringify(metadata)]
    );

    return { ok: true, item: insertRes.rows[0], owner };
  });

  /// GET /chatbot/memory — list user AI memory
  fastify.get('/memory', { preHandler: verifyToken }, async (req, reply) => {
    const userId = req.user?.userId || req.user?.id;
    const owner = await loadOwnerIdentity(userId);
    if (!owner) {
      return reply.code(404).send({ error: 'User not found' });
    }

    const limit = Math.max(1, Math.min(200, Number(req.query?.limit || 50)));
    const rowsRes = await db.query(
      `SELECT id, category, memory_text, metadata, created_at, updated_at
       FROM ai_user_memory
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [owner.userId, limit]
    );

    return {
      owner,
      total: rowsRes.rows.length,
      items: rowsRes.rows,
    };
  });

  /// POST /chatbot/files — persist AI knowledge file metadata + extracted text (pdf/image)
  fastify.post('/files', { preHandler: verifyToken }, async (req, reply) => {
    const userId = req.user?.userId || req.user?.id;
    const owner = await loadOwnerIdentity(userId);
    if (!owner) {
      return reply.code(404).send({ error: 'User not found' });
    }

    const fileName = normalizeText(req.body?.fileName, 300);
    const mimeType = normalizeMimeType(req.body?.mimeType);
    const storageUrl = normalizeText(req.body?.storageUrl, 1200);
    const extractedText = normalizeText(req.body?.extractedText, 25000);
    const metadata = req.body?.metadata && typeof req.body.metadata === 'object'
      ? req.body.metadata
      : {};

    const allowedMime = new Set([
      'application/pdf',
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp',
      'image/gif',
    ]);

    if (!fileName) {
      return reply.code(400).send({ error: 'fileName is required' });
    }
    if (!allowedMime.has(mimeType)) {
      return reply.code(400).send({ error: 'Unsupported mimeType. Use PDF or image mime types.' });
    }
    if (!storageUrl && !extractedText) {
      return reply.code(400).send({ error: 'Provide at least storageUrl or extractedText' });
    }

    const insertRes = await db.query(
      `INSERT INTO ai_user_knowledge_files
       (user_id, owner_key, file_name, mime_type, storage_url, extracted_text, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING id, file_name, mime_type, storage_url, extracted_text, metadata, created_at, updated_at`,
      [
        owner.userId,
        owner.ownerKey,
        fileName,
        mimeType,
        storageUrl || null,
        extractedText || null,
        JSON.stringify(metadata),
      ]
    );

    return { ok: true, item: insertRes.rows[0], owner };
  });

  /// GET /chatbot/files — list AI knowledge files owned by authenticated user
  fastify.get('/files', { preHandler: verifyToken }, async (req, reply) => {
    const userId = req.user?.userId || req.user?.id;
    const owner = await loadOwnerIdentity(userId);
    if (!owner) {
      return reply.code(404).send({ error: 'User not found' });
    }

    const limit = Math.max(1, Math.min(200, Number(req.query?.limit || 50)));
    const rowsRes = await db.query(
      `SELECT id, file_name, mime_type, storage_url, metadata, created_at, updated_at
       FROM ai_user_knowledge_files
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [owner.userId, limit]
    );

    return {
      owner,
      total: rowsRes.rows.length,
      items: rowsRes.rows,
    };
  });

  /// POST /chatbot/context — retrieve merged memory + knowledge context for model prompts
  fastify.post('/context', { preHandler: verifyToken }, async (req, reply) => {
    const userId = req.user?.userId || req.user?.id;
    const owner = await loadOwnerIdentity(userId);
    if (!owner) {
      return reply.code(404).send({ error: 'User not found' });
    }

    const memoryRes = await db.query(
      `SELECT id, category, memory_text, metadata, created_at
       FROM ai_user_memory
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [owner.userId, MAX_CONTEXT_ITEMS * 2]
    );

    const filesRes = await db.query(
      `SELECT id, file_name, mime_type, storage_url, extracted_text, metadata, created_at
       FROM ai_user_knowledge_files
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [owner.userId, MAX_CONTEXT_ITEMS * 2]
    );

    const payload = buildContextPayload({
      owner,
      memoryRows: memoryRes.rows,
      fileRows: filesRes.rows,
    });

    return {
      ok: true,
      query: normalizeText(req.body?.query || '', 1000),
      context: payload,
    };
  });

  /// POST /chatbot/prepare-prompt — compile multilingual system instruction + context + user training examples
  fastify.post('/prepare-prompt', { preHandler: verifyToken }, async (req, reply) => {
    const userId = req.user?.userId || req.user?.id;
    const owner = await loadOwnerIdentity(userId);
    if (!owner) {
      return reply.code(404).send({ error: 'User not found' });
    }

    const requestLanguage = normalizeLanguageCode(req.body?.languageCode || '');
    const query = normalizeText(req.body?.query || '', 2000);

    const profileRes = await db.query(
      `SELECT preferred_language, auto_detect, allowed_languages, response_style, metadata
       FROM ai_user_language_profiles
       WHERE user_id = $1
       LIMIT 1`,
      [owner.userId]
    );
    const languageProfile = profileRes.rows[0] || {
      preferred_language: 'en',
      auto_detect: false,
      allowed_languages: [],
      response_style: null,
      metadata: {},
    };

    let trainingRes;
    if (requestLanguage) {
      trainingRes = await db.query(
        `SELECT language_code, input_text, ideal_response, tags, metadata, created_at
         FROM ai_user_training_examples
         WHERE user_id = $1 AND language_code = $2
         ORDER BY created_at DESC
         LIMIT $3`,
        [owner.userId, requestLanguage, MAX_PROMPT_EXAMPLES]
      );

      if (trainingRes.rows.length === 0) {
        trainingRes = await db.query(
          `SELECT language_code, input_text, ideal_response, tags, metadata, created_at
           FROM ai_user_training_examples
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT $2`,
          [owner.userId, MAX_PROMPT_EXAMPLES]
        );
      }
    } else {
      trainingRes = await db.query(
        `SELECT language_code, input_text, ideal_response, tags, metadata, created_at
         FROM ai_user_training_examples
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [owner.userId, MAX_PROMPT_EXAMPLES]
      );
    }

    const memoryRes = await db.query(
      `SELECT id, category, memory_text, metadata, created_at
       FROM ai_user_memory
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [owner.userId, MAX_CONTEXT_ITEMS * 2]
    );

    const filesRes = await db.query(
      `SELECT id, file_name, mime_type, storage_url, extracted_text, metadata, created_at
       FROM ai_user_knowledge_files
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [owner.userId, MAX_CONTEXT_ITEMS * 2]
    );

    const context = buildContextPayload({
      owner,
      memoryRows: memoryRes.rows,
      fileRows: filesRes.rows,
    });

    const systemInstruction = buildSystemInstruction({
      owner,
      languageProfile,
      trainingExamples: trainingRes.rows,
    });

    return {
      ok: true,
      prompt: {
        owner,
        requestLanguage: requestLanguage || null,
        query,
        languageProfile,
        systemInstruction,
        trainingExamples: trainingRes.rows,
        context,
      },
    };
  });
};
