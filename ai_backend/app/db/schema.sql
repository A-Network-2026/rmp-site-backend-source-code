CREATE TABLE IF NOT EXISTS ai_users (
  id UUID PRIMARY KEY,
  email VARCHAR(320) UNIQUE NOT NULL,
  hashed_password VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_user_profiles (
  id UUID PRIMARY KEY,
  user_id UUID UNIQUE NOT NULL REFERENCES ai_users(id) ON DELETE CASCADE,
  display_name VARCHAR(120),
  personality_prompt TEXT NOT NULL DEFAULT 'Be helpful, concise, and safe.',
  private_context TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS ai_conversations (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES ai_users(id) ON DELETE CASCADE,
  title VARCHAR(250),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES ai_users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_memory_items (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES ai_users(id) ON DELETE CASCADE,
  source_type VARCHAR(50) NOT NULL,
  source_ref VARCHAR(255),
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_training_examples (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES ai_users(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  ideal_response TEXT NOT NULL,
  tags JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_ai_users_email ON ai_users(email);
CREATE INDEX IF NOT EXISTS ix_ai_conversations_user_id ON ai_conversations(user_id);
CREATE INDEX IF NOT EXISTS ix_ai_messages_user_id ON ai_messages(user_id);
CREATE INDEX IF NOT EXISTS ix_ai_messages_conversation_id ON ai_messages(conversation_id);
CREATE INDEX IF NOT EXISTS ix_ai_messages_user_conversation ON ai_messages(user_id, conversation_id);
CREATE INDEX IF NOT EXISTS ix_ai_memory_items_user_id ON ai_memory_items(user_id);
CREATE INDEX IF NOT EXISTS ix_ai_training_examples_user_id ON ai_training_examples(user_id);
