import pg from 'pg'
import type { ServerConfig } from './config'

const { Pool } = pg

export type Db = pg.Pool

export function createDb(config: ServerConfig): Db {
  return new Pool({ connectionString: config.databaseUrl })
}

export async function migrateDb(db: Db) {
  await db.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL UNIQUE,
      password_hash text NOT NULL,
      is_admin boolean NOT NULL DEFAULT false,
      disabled_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at timestamptz;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS storage_quota_bytes bigint;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS task_quota_count integer;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS registration_status text NOT NULL DEFAULT 'approved';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS registration_requested_at timestamptz;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS registration_reviewed_at timestamptz;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS registration_reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL;
    UPDATE users SET registration_status = 'approved' WHERE registration_status IS NULL OR registration_status = '';
    UPDATE users SET registration_requested_at = created_at WHERE registration_requested_at IS NULL;

    CREATE TABLE IF NOT EXISTS sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      settings jsonb NOT NULL DEFAULT '{}'::jsonb,
      params jsonb NOT NULL DEFAULT '{}'::jsonb,
      workspace jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS api_profiles (
      id text NOT NULL,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      profile jsonb NOT NULL,
      encrypted_api_key text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, id)
    );

    CREATE TABLE IF NOT EXISTS images (
      id text NOT NULL,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      task_id text,
      source text NOT NULL,
      storage_key text NOT NULL,
      mime_type text NOT NULL,
      byte_size integer NOT NULL,
      width integer,
      height integer,
      upload_status text NOT NULL DEFAULT 'done',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, id)
    );

    CREATE TABLE IF NOT EXISTS image_thumbnails (
      image_id text NOT NULL,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      storage_key text NOT NULL,
      mime_type text NOT NULL,
      width integer,
      height integer,
      thumbnail_version integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, image_id)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id text NOT NULL,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      record jsonb NOT NULL,
      status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, id)
    );

    CREATE TABLE IF NOT EXISTS agent_conversations (
      id text NOT NULL,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      target_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      action text NOT NULL,
      details jsonb NOT NULL DEFAULT '{}'::jsonb,
      ip text,
      user_agent text,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS platform_settings (
      key text PRIMARY KEY,
      value jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_images_user_created ON images(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_user_created ON tasks(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_conversations_user_updated ON agent_conversations(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs(target_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_users_registration_status ON users(registration_status, created_at DESC);
  `)
}

export async function markInterruptedRunningTasks(db: Db) {
  const now = Date.now()
  const result = await db.query(
    `
      UPDATE tasks
      SET
        status = 'error',
        record = record || jsonb_build_object(
          'status', 'error',
          'error', '服务重启，任务已中断，请重试',
          'finishedAt', $1::bigint,
          'elapsed', CASE
            WHEN record->>'createdAt' ~ '^[0-9]+$'
              THEN GREATEST(0, $1::bigint - (record->>'createdAt')::bigint)
            ELSE 0
          END,
          'falRecoverable', false,
          'customRecoverable', false
        ),
        updated_at = now()
      WHERE status = 'running'
    `,
    [now],
  )
  return result.rowCount ?? 0
}
