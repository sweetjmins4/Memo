-- =============================================================
-- Memo 웹사이트용 Supabase 초기 데이터베이스
-- Supabase Dashboard > SQL Editor에 전체를 붙여 넣고 한 번 실행하세요.
--
-- 구성
--   profiles   : 로그인 사용자 표시 이름
--   memo_folders : 메모 폴더
--   memos      : 제목, 본문, 고정 여부, 보관/삭제 상태
--   tags       : 개인 태그
--   memo_tags  : 메모와 태그 연결 (N : M)
--
-- 모든 데이터는 작성자 본인만 읽고, 만들고, 수정, 삭제할 수 있습니다.
-- =============================================================

begin;

-- 수정 시각을 자동으로 갱신하는 공통 함수
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -------------------------------------------------------------
-- 1. 사용자 프로필
-- Supabase Auth의 auth.users와 1:1로 연결됩니다.
-- -------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null unique,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- 회원 가입 시 프로필을 자동으로 만듭니다.
create or replace function public.handle_new_memo_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_memo on auth.users;
create trigger on_auth_user_created_memo
  after insert on auth.users
  for each row execute function public.handle_new_memo_user();

-- -------------------------------------------------------------
-- 2. 메모 폴더
-- folder_id가 없는 메모는 '폴더 없음' 메모입니다.
-- -------------------------------------------------------------
create table if not exists public.memo_folders (
  id         bigint generated always as identity primary key,
  owner_id   uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  name       text not null check (char_length(trim(name)) between 1 and 80),
  color      text check (color is null or color ~ '^#[0-9A-Fa-f]{6}$'),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, name)
);

create index if not exists idx_memo_folders_owner_sort
  on public.memo_folders (owner_id, sort_order, created_at);

drop trigger if exists trg_memo_folders_updated_at on public.memo_folders;
create trigger trg_memo_folders_updated_at
  before update on public.memo_folders
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------------
-- 3. 메모
-- body는 일반 텍스트 또는 에디터에서 만든 HTML을 저장할 수 있습니다.
-- deleted_at은 휴지통 기능을 위한 값입니다. null이면 삭제되지 않은 메모입니다.
-- -------------------------------------------------------------
create table if not exists public.memos (
  id          bigint generated always as identity primary key,
  owner_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  folder_id   bigint references public.memo_folders (id) on delete set null,
  title       text not null default '' check (char_length(title) <= 200),
  body        text not null default '',
  is_pinned   boolean not null default false,
  archived_at timestamptz,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_memos_owner_updated
  on public.memos (owner_id, updated_at desc)
  where deleted_at is null;
create index if not exists idx_memos_owner_folder
  on public.memos (owner_id, folder_id, updated_at desc)
  where deleted_at is null;
create index if not exists idx_memos_owner_pinned
  on public.memos (owner_id, is_pinned desc, updated_at desc)
  where deleted_at is null;

drop trigger if exists trg_memos_updated_at on public.memos;
create trigger trg_memos_updated_at
  before update on public.memos
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------------
-- 4. 태그 및 메모-태그 연결
-- -------------------------------------------------------------
create table if not exists public.tags (
  id         bigint generated always as identity primary key,
  owner_id   uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  name       text not null check (char_length(trim(name)) between 1 and 40),
  color      text check (color is null or color ~ '^#[0-9A-Fa-f]{6}$'),
  created_at timestamptz not null default now(),
  unique (owner_id, name)
);

create index if not exists idx_tags_owner_name on public.tags (owner_id, name);

create table if not exists public.memo_tags (
  memo_id bigint not null references public.memos (id) on delete cascade,
  tag_id  bigint not null references public.tags (id) on delete cascade,
  primary key (memo_id, tag_id)
);

create index if not exists idx_memo_tags_tag_id on public.memo_tags (tag_id);

-- -------------------------------------------------------------
-- 5. Row Level Security (RLS)
-- 브라우저에서 Supabase를 연결해도 다른 사용자의 메모는 보이지 않습니다.
-- -------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.memo_folders enable row level security;
alter table public.memos enable row level security;
alter table public.tags enable row level security;
alter table public.memo_tags enable row level security;

create policy "profiles: 본인 조회" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "profiles: 본인 수정" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy "folders: 본인만 관리" on public.memo_folders
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy "memos: 본인만 관리" on public.memos
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and (
      folder_id is null
      or exists (
        select 1 from public.memo_folders
        where id = folder_id and owner_id = (select auth.uid())
      )
    )
  );

create policy "tags: 본인만 관리" on public.tags
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy "memo_tags: 본인 메모와 태그만 연결" on public.memo_tags
  for all to authenticated
  using (
    exists (select 1 from public.memos where id = memo_id and owner_id = (select auth.uid()))
    and exists (select 1 from public.tags where id = tag_id and owner_id = (select auth.uid()))
  )
  with check (
    exists (select 1 from public.memos where id = memo_id and owner_id = (select auth.uid()))
    and exists (select 1 from public.tags where id = tag_id and owner_id = (select auth.uid()))
  );

commit;
