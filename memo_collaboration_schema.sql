-- =============================================================
-- Memo 협업 기능 확장 SQL
-- 실행 순서: 1) memo_schema.sql  2) 이 파일
-- =============================================================
begin;

-- 초기 파일을 과거 버전으로 실행한 경우에도 이메일 열을 보완합니다.
alter table public.profiles add column if not exists email text;
create unique index if not exists uq_profiles_email on public.profiles(email) where email is not null;

create table if not exists public.workspaces (
  id bigint generated always as identity primary key,
  name text not null check (char_length(trim(name)) between 1 and 100),
  owner_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_workspaces_owner on public.workspaces(owner_id);
drop trigger if exists trg_workspaces_updated_at on public.workspaces;
create trigger trg_workspaces_updated_at before update on public.workspaces
for each row execute function public.set_updated_at();

create table if not exists public.workspace_members (
  workspace_id bigint not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'viewer' check (role in ('viewer', 'editor', 'admin')),
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index if not exists idx_workspace_members_user on public.workspace_members(user_id);

alter table public.memos add column if not exists workspace_id bigint references public.workspaces(id) on delete cascade;
create index if not exists idx_memos_workspace_updated on public.memos(workspace_id, updated_at desc)
where deleted_at is null;

create table if not exists public.memo_members (
  memo_id bigint not null references public.memos(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'viewer' check (role in ('viewer', 'editor', 'admin')),
  invited_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (memo_id, user_id)
);
create index if not exists idx_memo_members_user on public.memo_members(user_id);

create table if not exists public.memo_comments (
  id bigint generated always as identity primary key,
  memo_id bigint not null references public.memos(id) on delete cascade,
  author_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  content text not null check (char_length(trim(content)) between 1 and 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_memo_comments_memo on public.memo_comments(memo_id, created_at);
drop trigger if exists trg_memo_comments_updated_at on public.memo_comments;
create trigger trg_memo_comments_updated_at before update on public.memo_comments
for each row execute function public.set_updated_at();

create table if not exists public.memo_versions (
  id bigint generated always as identity primary key,
  memo_id bigint not null references public.memos(id) on delete cascade,
  changed_by uuid references public.profiles(id) on delete set null,
  title text not null,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_memo_versions_memo on public.memo_versions(memo_id, created_at desc);

create or replace function public.can_view_memo(p_memo_id bigint, p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memos m
    where m.id = p_memo_id and (
      m.owner_id = p_user_id
      or exists (select 1 from public.memo_members mm where mm.memo_id = m.id and mm.user_id = p_user_id)
      or (m.workspace_id is not null and exists (
        select 1 from public.workspace_members wm
        where wm.workspace_id = m.workspace_id and wm.user_id = p_user_id
      ))
    )
  );
$$;

create or replace function public.can_edit_memo(p_memo_id bigint, p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memos m
    where m.id = p_memo_id and (
      m.owner_id = p_user_id
      or exists (select 1 from public.memo_members mm where mm.memo_id = m.id and mm.user_id = p_user_id and mm.role in ('editor','admin'))
      or (m.workspace_id is not null and exists (
        select 1 from public.workspace_members wm
        where wm.workspace_id = m.workspace_id and wm.user_id = p_user_id and wm.role in ('editor','admin')
      ))
    )
  );
$$;

create or replace function public.can_manage_memo(p_memo_id bigint, p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memos m
    where m.id = p_memo_id and (
      m.owner_id = p_user_id
      or exists (select 1 from public.memo_members mm where mm.memo_id = m.id and mm.user_id = p_user_id and mm.role = 'admin')
      or (m.workspace_id is not null and exists (
        select 1 from public.workspace_members wm
        where wm.workspace_id = m.workspace_id and wm.user_id = p_user_id and wm.role = 'admin'
      ))
    )
  );
$$;

-- 이메일 주소를 아는 메모 관리자만 초대할 수 있습니다.
-- 프로필 전체를 공개하지 않기 위해 브라우저에서 이메일 검색을 하지 않습니다.
create or replace function public.invite_memo_member(p_memo_id bigint, p_email text, p_role text default 'viewer')
returns void language plpgsql security definer set search_path = '' as $$
declare
  target_user_id uuid;
begin
  if not public.can_manage_memo(p_memo_id) then
    raise exception '메모를 공유할 권한이 없습니다.';
  end if;
  if p_role not in ('viewer', 'editor', 'admin') then
    raise exception '올바르지 않은 권한입니다.';
  end if;
  select id into target_user_id from public.profiles where lower(email) = lower(trim(p_email));
  if target_user_id is null then
    raise exception '가입한 사용자를 찾지 못했습니다.';
  end if;
  insert into public.memo_members (memo_id, user_id, role, invited_by)
  values (p_memo_id, target_user_id, p_role, (select auth.uid()))
  on conflict (memo_id, user_id) do update set role = excluded.role, invited_by = excluded.invited_by;
end;
$$;
revoke all on function public.invite_memo_member(bigint, text, text) from public;
grant execute on function public.invite_memo_member(bigint, text, text) to authenticated;

-- 기존 개인 메모 정책을 협업 정책으로 교체합니다.
drop policy if exists "memos: 본인만 관리" on public.memos;
create policy "memos: 공유 범위 조회" on public.memos for select to authenticated
using (public.can_view_memo(id));
create policy "memos: 작성" on public.memos for insert to authenticated
with check (owner_id = (select auth.uid()));
create policy "memos: 편집" on public.memos for update to authenticated
using (public.can_edit_memo(id)) with check (public.can_edit_memo(id));
create policy "memos: 관리 삭제" on public.memos for delete to authenticated
using (public.can_manage_memo(id));

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.memo_members enable row level security;
alter table public.memo_comments enable row level security;
alter table public.memo_versions enable row level security;

create policy "workspaces: 구성원 조회" on public.workspaces for select to authenticated
using (owner_id = (select auth.uid()) or exists (select 1 from public.workspace_members wm where wm.workspace_id = id and wm.user_id = (select auth.uid())));
create policy "workspaces: 만들기" on public.workspaces for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "workspaces: 소유자 관리" on public.workspaces for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "workspaces: 소유자 삭제" on public.workspaces for delete to authenticated using (owner_id = (select auth.uid()));
create policy "workspace_members: 구성원 조회" on public.workspace_members for select to authenticated
using (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = (select auth.uid())) or user_id = (select auth.uid()));
create policy "workspace_members: 소유자 관리" on public.workspace_members for all to authenticated
using (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = (select auth.uid())))
with check (exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = (select auth.uid())));
create policy "memo_members: 공유자 조회" on public.memo_members for select to authenticated using (public.can_view_memo(memo_id));
create policy "memo_members: 관리자 관리" on public.memo_members for all to authenticated using (public.can_manage_memo(memo_id)) with check (public.can_manage_memo(memo_id));
create policy "comments: 조회" on public.memo_comments for select to authenticated using (public.can_view_memo(memo_id));
create policy "comments: 작성" on public.memo_comments for insert to authenticated with check (author_id = (select auth.uid()) and public.can_view_memo(memo_id));
create policy "comments: 본인 수정" on public.memo_comments for update to authenticated using (author_id = (select auth.uid())) with check (author_id = (select auth.uid()));
create policy "comments: 본인 또는 메모관리자 삭제" on public.memo_comments for delete to authenticated using (author_id = (select auth.uid()) or public.can_manage_memo(memo_id));
create policy "versions: 공유자 조회" on public.memo_versions for select to authenticated using (public.can_view_memo(memo_id));

create or replace function public.save_memo_version()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.title is distinct from old.title or new.body is distinct from old.body then
    insert into public.memo_versions (memo_id, changed_by, title, body)
    values (new.id, (select auth.uid()), new.title, new.body);
  end if;
  return new;
end;
$$;
drop trigger if exists trg_memos_save_version on public.memos;
create trigger trg_memos_save_version after insert or update on public.memos
for each row execute function public.save_memo_version();

commit;
