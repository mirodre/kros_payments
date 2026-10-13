create table automation_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id text not null references organizations(id),
  connection_id uuid not null references kros_connections(id) on delete cascade,
  kind text not null check (kind in ('invoice_payment', 'transfer')),
  enabled boolean not null default true,
  partner_text text not null default '',
  doc_types text not null default 'all' check (doc_types in ('all', 'invoices', 'expenses')),
  account_id bigint not null,
  target_account_id bigint,
  start_date date not null,
  watermark timestamptz,
  last_run_at timestamptz,
  last_status text,
  last_error text,
  last_summary jsonb,
  created_by_user_id text not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'transfer' or (target_account_id is not null and target_account_id <> account_id))
);
create index automation_rules_org on automation_rules (organization_id, connection_id);

create table automation_items (
  id bigserial primary key,
  rule_id uuid references automation_rules(id) on delete set null,
  connection_id uuid not null references kros_connections(id) on delete cascade,
  item_key text not null,
  source_type text not null,
  source_id text not null,
  label text,
  amount numeric(18, 2),
  currency text,
  payload jsonb not null,
  request_id text,
  status text not null,
  attempts int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, item_key)
);
create index automation_items_rule on automation_items (rule_id, id desc);
create index automation_items_request on automation_items (request_id) where request_id is not null;
