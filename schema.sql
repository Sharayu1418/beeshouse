-- The Bee's House — Phase 1 schema
--
-- Paste this whole file into the Supabase SQL editor and run it once.
--
-- The security model in one sentence: browsers get NO direct read on any
-- table. Everything goes through the API, which redacts. RLS is on
-- everywhere with no permissive policies, so even a leaked anon key
-- cannot read a single card.

-- ---------------------------------------------------------------- games

create table if not exists games (
  id             uuid primary key default gen_random_uuid(),
  code           text unique not null,               -- short join code, e.g. 'AB12'
  host_player_id uuid,
  status         text not null default 'lobby',      -- lobby | playing | done
  settings       jsonb not null default '{}'::jsonb, -- rounds, turn clock, feast on/off
  created_at     timestamptz not null default now()
);

-- --------------------------------------------------------------- players

create table if not exists players (
  id           uuid primary key default gen_random_uuid(),
  game_id      uuid not null references games(id) on delete cascade,
  animal       text not null,                        -- bee | deer | snake | rhino | giraffe
  display_name text not null,
  seat         int  not null,
  phone        text,                                 -- E.164, for the wa.me nudge link
  token_hash   text,                                 -- sha256 of the device token; never the token
  claimed_at   timestamptz,
  last_seen_at timestamptz,
  unique (game_id, seat),
  unique (game_id, animal)
);

-- ---------------------------------------------------------------- rounds
-- The secret table. deck/discard/hands never leave the server.

create table if not exists rounds (
  id         uuid primary key default gen_random_uuid(),
  game_id    uuid not null references games(id) on delete cascade,
  n          int  not null,
  version    bigint not null default 0,              -- optimistic concurrency
  state      jsonb not null,                         -- the full engine state
  updated_at timestamptz not null default now(),
  unique (game_id, n)
);

-- ----------------------------------------------------------------- moves
-- Append-only. The Tab and the briefing are both queries over this, which
-- is why they can never disagree with what actually happened.

create table if not exists moves (
  id         bigserial primary key,
  game_id    uuid not null references games(id) on delete cascade,
  round_n    int  not null,
  seat       int  not null,
  type       text not null,
  payload    jsonb not null default '{}'::jsonb,
  public_text text,                                  -- the Tab line, values already stripped
  actor_id   text,
  victim_ids text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists moves_game_idx    on moves (game_id, id desc);
create index if not exists moves_seat_idx    on moves (game_id, seat, id desc);
create index if not exists players_game_idx  on players (game_id);
create index if not exists rounds_game_idx   on rounds (game_id, n desc);

-- ---------------------------------------------------------------- scores

create table if not exists scores (
  game_id   uuid not null references games(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  round_n   int  not null,
  score     int  not null,
  primary key (game_id, player_id, round_n)
);

-- ------------------------------------------------------------------- RLS
-- On for every table, with deliberately NO policies. The service-role key
-- used by the API bypasses RLS; the anon key the browser holds can read
-- nothing at all. If you ever find yourself adding a policy here, stop and
-- ask whether the API should be doing that read instead.

alter table games   enable row level security;
alter table players enable row level security;
alter table rounds  enable row level security;
alter table moves   enable row level security;
alter table scores  enable row level security;

revoke all on games, players, rounds, moves, scores from anon, authenticated;

-- ------------------------------------------------------ realtime pings
-- Realtime is optional (WhatsApp is the notification layer), but if it is
-- enabled, publish ONLY the games table. Never rounds — its rows contain
-- every player's cards.
--
--   alter publication supabase_realtime add table games;
