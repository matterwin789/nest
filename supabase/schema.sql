create extension if not exists pgcrypto;

create table if not exists public.todos (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) > 0 and char_length(title) <= 120),
  is_completed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trigger_set_todos_updated_at on public.todos;
create trigger trigger_set_todos_updated_at
before update on public.todos
for each row
execute function public.set_updated_at();

create index if not exists todos_created_at_idx on public.todos (created_at desc);

alter table public.todos enable row level security;

drop policy if exists "todos_public_select" on public.todos;
create policy "todos_public_select"
on public.todos
for select
to anon
using (true);

drop policy if exists "todos_public_insert" on public.todos;
create policy "todos_public_insert"
on public.todos
for insert
to anon
with check (true);

drop policy if exists "todos_public_update" on public.todos;
create policy "todos_public_update"
on public.todos
for update
to anon
using (true)
with check (true);

drop policy if exists "todos_public_delete" on public.todos;
create policy "todos_public_delete"
on public.todos
for delete
to anon
using (true);
