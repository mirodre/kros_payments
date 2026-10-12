create table organizations (
  id text primary key,
  name text not null,
  webhook_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table users (
  id text primary key,
  email text not null,
  name text,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);

create table kros_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations(id),
  kros_company_id text not null,
  company_name text not null,
  token_enc text not null,
  webhook_secret_enc text,
  invalid_at timestamptz,
  created_by_user_id text not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, kros_company_id)
);

create table kros_consent_requests (
  state text primary key,
  organization_id text not null references organizations(id),
  user_id text not null references users(id),
  expires_at timestamptz not null,
  used_at timestamptz
);

create table kros_payment_callbacks (
  id bigserial primary key,
  organization_id text not null references organizations(id),
  connection_id uuid references kros_connections(id) on delete set null,
  received_at timestamptz not null default now(),
  signature_header text,
  signature_valid boolean not null,
  payload jsonb not null
);
create index kros_payment_callbacks_org_id on kros_payment_callbacks (organization_id, id);

create table sessions (
  sid text primary key,
  data text not null,
  expires_at timestamptz not null
);
create index sessions_expires_at on sessions (expires_at);
