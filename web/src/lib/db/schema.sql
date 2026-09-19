-- game_log — CONTRACTS.md §6. Applied by infra/deploy.sh via psql.
-- Idempotent: safe to run against a database that already has this schema.

create table if not exists game_log (
  id            bigserial primary key,
  game          text        not null check (game in ('connect4', 'racer')),
  checkpoint_id text        not null,
  outcome       text        not null check (outcome in ('human_win','ai_win','draw','dnf')),
  moves         jsonb,            -- connect4: [3,3,4,...]. racer: null.
  lap_ms        integer,          -- racer only. null for connect4.
  duration_ms   integer     not null,
  client_hash   text        not null,
  created_at    timestamptz not null default now()
);

create index if not exists game_log_game_checkpoint_idx on game_log (game, checkpoint_id);
create index if not exists game_log_created_at_idx      on game_log (created_at desc);
