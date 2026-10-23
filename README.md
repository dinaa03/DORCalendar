# Bridgewater PTC – Site Visibility Calendar

A shared calendar for **Events**, **Contractors**, and **PTO / OOO**. It's built for a 16:9 Smart TV and also works on laptops, tablets, and phones.

## Files
| File | Purpose |
|---|---|
| `index.html` | Page layout |
| `styles.css` | Look and feel (beige / brown / blue theme) |
| `app.js` | App logic. **Your settings go at the top of this file** |
| `README.md` | These instructions, including the database setup |

## Try it first (no setup)
1. Put all four files in one folder.
2. Open a terminal in that folder and run `python -m http.server`.
3. Go to http://localhost:8000 and use the passkey **demo**.

In demo mode, data saves only on that one computer.

## Make it shared (Supabase free database, about 5 minutes)
1. Go to supabase.com, create a free account, and click **New project**.
2. Open **SQL Editor > New query** and paste in the SQL below.
3. At the very bottom, replace `CHANGE-ME-PASSKEY` with your site passkey, then click **Run**.
4. Go to **Project Settings > API** and copy the **Project URL** and the **anon public** key.
5. Paste both into the `SETTINGS` block at the top of `app.js`.

After that, every device using the site sees the same calendar. The TV refreshes every 60 seconds.

```sql
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.app_config (
  id int primary key default 1 check (id = 1),
  passkey_hash text not null
);

create table if not exists public.app_sessions (
  token uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

create table if not exists public.entries (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('event','contractor','pto')),
  title text not null check (length(trim(title)) > 0),
  purpose text,
  start_date date not null,
  end_date date not null,
  all_day boolean not null default false,
  start_time time,
  end_time time,
  location text,
  host text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date)
);
create index if not exists entries_range_idx on public.entries (start_date, end_date);

-- Lock tables: the public key cannot read/write them directly
alter table public.app_config   enable row level security;
alter table public.app_sessions enable row level security;
alter table public.entries      enable row level security;
revoke all on public.app_config, public.app_sessions, public.entries from anon, authenticated;

create or replace function public._app_check(p_token uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update app_sessions set last_seen = now()
   where token = p_token and last_seen > now() - interval '180 days';
  if not found then raise exception 'INVALID_SESSION'; end if;
end $$;

create or replace function public.app_login(p_passkey text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare t uuid;
begin
  if not exists (select 1 from app_config where id = 1 and passkey_hash = crypt(p_passkey, passkey_hash)) then
    perform pg_sleep(1);
    return null;
  end if;
  insert into app_sessions default values returning token into t;
  return t;
end $$;

create or replace function public.app_check(p_token uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin perform _app_check(p_token); return true; end $$;

create or replace function public.app_logout(p_token uuid)
returns void language sql security definer set search_path = public as $$
  delete from app_sessions where token = p_token;
$$;

create or replace function public.app_list(p_token uuid, p_from date, p_to date)
returns setof public.entries language plpgsql security definer set search_path = public as $$
begin
  perform _app_check(p_token);
  return query select * from entries
   where start_date <= p_to and end_date >= p_from
   order by start_date, all_day desc, start_time nulls first, title;
end $$;

create or replace function public.app_save(p_token uuid, p_entry jsonb)
returns public.entries language plpgsql security definer set search_path = public as $$
declare
  r entries;
  v_start date := (p_entry->>'start_date')::date;
  v_end   date := coalesce(nullif(p_entry->>'end_date','')::date, (p_entry->>'start_date')::date);
begin
  perform _app_check(p_token);
  if coalesce(p_entry->>'id','') = '' then
    insert into entries (type, title, purpose, start_date, end_date, all_day, start_time, end_time, location, host, notes)
    values (p_entry->>'type', trim(p_entry->>'title'), nullif(p_entry->>'purpose',''), v_start, v_end,
            coalesce((p_entry->>'all_day')::boolean, false),
            nullif(p_entry->>'start_time','')::time, nullif(p_entry->>'end_time','')::time,
            nullif(p_entry->>'location',''), nullif(p_entry->>'host',''), nullif(p_entry->>'notes',''))
    returning * into r;
  else
    update entries set
      type = p_entry->>'type', title = trim(p_entry->>'title'), purpose = nullif(p_entry->>'purpose',''),
      start_date = v_start, end_date = v_end, all_day = coalesce((p_entry->>'all_day')::boolean, false),
      start_time = nullif(p_entry->>'start_time','')::time, end_time = nullif(p_entry->>'end_time','')::time,
      location = nullif(p_entry->>'location',''), host = nullif(p_entry->>'host',''),
      notes = nullif(p_entry->>'notes',''), updated_at = now()
    where id = (p_entry->>'id')::uuid
    returning * into r;
  end if;
  return r;
end $$;

create or replace function public.app_delete(p_token uuid, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin perform _app_check(p_token); delete from entries where id = p_id; end $$;

revoke all on function public._app_check(uuid) from public, anon, authenticated;
grant execute on function public.app_login(text)            to anon;
grant execute on function public.app_check(uuid)            to anon;
grant execute on function public.app_logout(uuid)           to anon;
grant execute on function public.app_list(uuid, date, date) to anon;
grant execute on function public.app_save(uuid, jsonb)      to anon;
grant execute on function public.app_delete(uuid, uuid)     to anon;

-- SET THE SITE PASSKEY (only a bcrypt hash is stored)
insert into public.app_config (id, passkey_hash)
values (1, extensions.crypt('CHANGE-ME-PASSKEY', extensions.gen_salt('bf')))
on conflict (id) do update set passkey_hash = excluded.passkey_hash;
```

## Managing access
- **Change the passkey:** edit the last `insert` statement and run only that part again.
- **Sign out every device:** run `delete from public.app_sessions;`
- The passkey never appears in the website code. Each device stays signed in for up to 180 days after it was last used.
- Only the **anon public** key goes in `app.js`. Never use the `service_role` key.

## Publishing
These are plain static files, so any web host or internal web server can serve them. Just upload all four files together. Don't open `index.html` by double-clicking it; it has to be served over http/https.

## Customizing
- **Colors:** change the variables at the top of `styles.css`.
- **Refresh rate:** change `REFRESH_SECONDS` at the top of `app.js`.
