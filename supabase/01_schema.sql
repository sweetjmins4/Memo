-- =====================================================================
--  함께메모 - Supabase 스키마 (친구 + 대화형 메모장)
--  Supabase 대시보드 > SQL Editor 에 전체를 붙여넣고 실행하세요.
--
--  규칙
--   1. 회원가입은 누구나 가능
--   2. 친구는 요청 → 상대 수락으로 "서로" 친구가 됨
--   3. 메모장은 만든 사람(방장)이 친구 중에서 골라 초대한 사람만 접근
--      친구라고 해서 내 모든 메모장을 볼 수 있는 것은 아님
--   4. 메모장 안의 메모(메시지)는 참여자만 읽고 쓸 수 있으며 작성자가 표시됨
--
--  구조
--    auth.users (Supabase 기본)
--      └─ profiles          이름, 상태메시지
--    friendships            친구 관계 (pending → accepted)
--    memos                  메모장 (owner_id = 방장)
--      ├─ memo_members      참여자 (owner / member) + 마지막으로 읽은 시각
--      └─ memo_messages     메모장 안에서 주고받은 메모 (작성자 기록)
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. 타입
-- ---------------------------------------------------------------------
create type public.memo_role as enum ('owner', 'member');
create type public.friend_status as enum ('pending', 'accepted');


-- ---------------------------------------------------------------------
-- 2. 테이블
-- ---------------------------------------------------------------------
create table public.profiles (
  id             uuid primary key references auth.users (id) on delete cascade,
  email          text,
  display_name   text,
  status_message text check (char_length(status_message) <= 60),
  created_at     timestamptz not null default now()
);

create table public.friendships (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles (id) on delete cascade,
  addressee_id uuid not null references public.profiles (id) on delete cascade,
  status       public.friend_status not null default 'pending',
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  check (requester_id <> addressee_id)
);
-- 두 사람 사이에는 관계가 하나만 존재
create unique index friendships_pair_uidx
  on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));
create index friendships_addressee_idx on public.friendships (addressee_id);

create table public.memos (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references public.profiles (id) on delete cascade,
  title           text not null check (char_length(title) between 1 and 100),
  color           text not null default 'yellow',
  created_at      timestamptz not null default now(),
  last_message    text,
  last_sender_id  uuid references public.profiles (id) on delete set null,
  last_message_at timestamptz not null default now()
);
create index memos_owner_idx on public.memos (owner_id);

create table public.memo_members (
  memo_id      uuid not null references public.memos (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  role         public.memo_role not null default 'member',
  added_by     uuid references public.profiles (id) on delete set null,
  last_read_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  primary key (memo_id, user_id)
);
create index memo_members_user_idx on public.memo_members (user_id);

create table public.memo_messages (
  id         uuid primary key default gen_random_uuid(),
  memo_id    uuid not null references public.memos (id) on delete cascade,
  user_id    uuid references public.profiles (id) on delete set null,
  kind       text not null default 'text' check (kind in ('text', 'system')),
  body       text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default clock_timestamp()   -- 같은 작업 안에서도 순서 보장
);
create index memo_messages_memo_idx on public.memo_messages (memo_id, created_at desc);
create index memo_messages_user_idx on public.memo_messages (user_id);


-- ---------------------------------------------------------------------
-- 3. 권한 확인 함수 (security definer: RLS 재귀 방지)
-- ---------------------------------------------------------------------
create or replace function public.are_friends(a uuid, b uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.friendships
    where status = 'accepted'
      and least(requester_id, addressee_id) = least(a, b)
      and greatest(requester_id, addressee_id) = greatest(a, b)
  );
$$;

create or replace function public.is_memo_member(m uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.memo_members
                 where memo_id = m and user_id = (select auth.uid()));
$$;

create or replace function public.is_memo_owner(m uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.memo_members
                 where memo_id = m and user_id = (select auth.uid()) and role = 'owner');
$$;

-- 프로필은 나, 친구(요청 중 포함), 같은 메모장 참여자,
-- 그리고 내가 속한 메모장에 메모를 남겼던 사람(나간 사람 이름 표시용)만 보임
create or replace function public.can_see_profile(p uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p = (select auth.uid())
    or exists (
      select 1 from public.friendships f
      where (f.requester_id = (select auth.uid()) and f.addressee_id = p)
         or (f.addressee_id = (select auth.uid()) and f.requester_id = p)
    )
    or exists (
      select 1 from public.memo_members a
      join public.memo_members b on b.memo_id = a.memo_id
      where a.user_id = (select auth.uid()) and b.user_id = p
    )
    or exists (
      select 1 from public.memo_messages g
      join public.memo_members mm on mm.memo_id = g.memo_id
      where g.user_id = p and mm.user_id = (select auth.uid())
    );
$$;

create or replace function public.display_name_of(p uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select coalesce(nullif(display_name, ''), split_part(email, '@', 1), '알 수 없음')
  from public.profiles where id = p;
$$;


-- ---------------------------------------------------------------------
-- 4. 트리거
-- ---------------------------------------------------------------------

-- 4-1. 회원가입 → 프로필 자동 생성
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email,
          coalesce(nullif(new.raw_user_meta_data ->> 'name', ''), split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 4-2. 메모장 생성/수정 보호
create or replace function public.handle_memo_before()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then new.owner_id := auth.uid(); end if;
    new.created_at := now();
    new.last_message_at := now();
  else
    new.owner_id := old.owner_id;     -- 방장 변경 금지
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;
create trigger on_memo_before
  before insert or update on public.memos
  for each row execute function public.handle_memo_before();

-- 4-3. 메모장 생성 → 만든 사람을 방장으로 등록
create or replace function public.handle_new_memo()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.memo_members (memo_id, user_id, role, added_by)
  values (new.id, new.owner_id, 'owner', new.owner_id);
  insert into public.memo_messages (memo_id, user_id, kind, body)
  values (new.id, null, 'system', public.display_name_of(new.owner_id) || '님이 메모장을 만들었습니다.');
  return new;
end;
$$;
create trigger on_memo_created
  after insert on public.memos
  for each row execute function public.handle_new_memo();

-- 4-4. 메모(메시지) 작성/삭제 → 메모장 목록의 "마지막 메모" 갱신
create or replace function public.handle_message_after()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  m uuid := coalesce(new.memo_id, old.memo_id);
  last record;
begin
  if not exists (select 1 from public.memos where id = m) then return null; end if;
  select body, user_id, kind, created_at into last
  from public.memo_messages where memo_id = m
  order by created_at desc limit 1;

  update public.memos
     set last_message    = case when last.kind = 'system' then last.body else left(last.body, 120) end,
         last_sender_id  = last.user_id,
         last_message_at = coalesce(last.created_at, created_at)
   where id = m;

  if tg_op = 'INSERT' and new.user_id is not null then
    update public.memo_members set last_read_at = new.created_at
     where memo_id = m and user_id = new.user_id;
  end if;
  return null;
end;
$$;
create trigger on_message_after
  after insert or delete on public.memo_messages
  for each row execute function public.handle_message_after();

-- 4-5. 참여자 추가/퇴장 → 안내 메시지
create or replace function public.handle_member_after()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.role = 'member' then
      insert into public.memo_messages (memo_id, user_id, kind, body)
      values (new.memo_id, null, 'system',
              public.display_name_of(new.added_by) || '님이 ' || public.display_name_of(new.user_id) || '님을 초대했습니다.');
    end if;
  elsif tg_op = 'DELETE' then
    -- 메모장 자체가 삭제되는 중이면 건너뜀
    if old.role = 'member' and exists (select 1 from public.memos where id = old.memo_id) then
      insert into public.memo_messages (memo_id, user_id, kind, body)
      values (old.memo_id, null, 'system',
              case when auth.uid() = old.user_id
                   then public.display_name_of(old.user_id) || '님이 나갔습니다.'
                   else public.display_name_of(old.user_id) || '님이 내보내졌습니다.' end);
    end if;
  end if;
  return null;
end;
$$;
create trigger on_member_after
  after insert or delete on public.memo_members
  for each row execute function public.handle_member_after();


-- ---------------------------------------------------------------------
-- 5. 기능 함수 (클라이언트: supabase.rpc(...))
-- ---------------------------------------------------------------------

-- 5-1. 친구 요청 (이메일). 상대가 이미 나에게 요청했다면 바로 친구가 됨
create or replace function public.send_friend_request(p_email text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  target uuid;
  f public.friendships%rowtype;
begin
  if me is null then raise exception '로그인이 필요합니다.'; end if;
  select id into target from auth.users where lower(email) = lower(trim(p_email)) limit 1;
  if target is null then raise exception '가입되지 않은 이메일입니다.'; end if;
  if target = me then raise exception '나 자신은 친구로 추가할 수 없습니다.'; end if;

  insert into public.profiles (id, email, display_name)
  select u.id, u.email, split_part(u.email, '@', 1) from auth.users u where u.id = target
  on conflict (id) do nothing;

  select * into f from public.friendships
  where least(requester_id, addressee_id) = least(me, target)
    and greatest(requester_id, addressee_id) = greatest(me, target);

  if found then
    if f.status = 'accepted' then return 'already'; end if;
    if f.requester_id = me then return 'pending'; end if;
    update public.friendships set status = 'accepted', responded_at = now() where id = f.id;
    return 'accepted';
  end if;

  insert into public.friendships (requester_id, addressee_id) values (me, target);
  return 'sent';
end;
$$;

-- 5-2. 받은 친구 요청 수락 (거절·취소·친구 삭제는 delete 로 처리)
create or replace function public.accept_friend_request(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.friendships
     set status = 'accepted', responded_at = now()
   where id = p_id and addressee_id = auth.uid() and status = 'pending';
  if not found then raise exception '수락할 수 있는 요청이 없습니다.'; end if;
end;
$$;

-- 5-3. 메모장 만들기 + 친구 초대 (친구가 아닌 사람은 초대 불가)
create or replace function public.create_memo(
  p_title text, p_color text default 'yellow', p_members uuid[] default '{}')
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  new_id uuid;
  u uuid;
begin
  if me is null then raise exception '로그인이 필요합니다.'; end if;
  foreach u in array coalesce(p_members, '{}') loop
    if u <> me and not public.are_friends(me, u) then
      raise exception '친구만 메모장에 초대할 수 있습니다.';
    end if;
  end loop;

  insert into public.memos (owner_id, title, color)
  values (me, trim(p_title), coalesce(nullif(p_color, ''), 'yellow'))
  returning id into new_id;

  insert into public.memo_members (memo_id, user_id, role, added_by)
  select new_id, x, 'member', me
  from unnest(coalesce(p_members, '{}')) as x
  where x <> me
  on conflict do nothing;

  return new_id;
end;
$$;

-- 5-4. 메모장에 친구 초대 (방장만, 친구만)
create or replace function public.add_memo_members(p_memo uuid, p_members uuid[])
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  u uuid;
  n integer := 0;
begin
  if not public.is_memo_owner(p_memo) then raise exception '방장만 초대할 수 있습니다.'; end if;
  foreach u in array coalesce(p_members, '{}') loop
    if u = me then continue; end if;
    if not public.are_friends(me, u) then raise exception '친구만 메모장에 초대할 수 있습니다.'; end if;
    insert into public.memo_members (memo_id, user_id, role, added_by)
    values (p_memo, u, 'member', me)
    on conflict do nothing;
    if found then n := n + 1; end if;
  end loop;
  return n;
end;
$$;

-- 5-5. 내 메모장 목록 (안 읽은 수 포함). RLS 가 그대로 적용됨(security invoker)
create or replace function public.my_memos()
returns table (
  id uuid, title text, color text, owner_id uuid, my_role public.memo_role,
  member_count integer, last_message text, last_sender_id uuid, last_message_at timestamptz,
  unread integer
)
language sql stable set search_path = ''
as $$
  select m.id, m.title, m.color, m.owner_id, mm.role,
         (select count(*) from public.memo_members x where x.memo_id = m.id)::int,
         m.last_message, m.last_sender_id, m.last_message_at,
         (select count(*) from public.memo_messages g
           where g.memo_id = m.id and g.kind = 'text'
             and g.created_at > mm.last_read_at
             and g.user_id is distinct from mm.user_id)::int
  from public.memo_members mm
  join public.memos m on m.id = mm.memo_id
  where mm.user_id = (select auth.uid())
  order by m.last_message_at desc;
$$;

-- 5-6. 읽음 표시
create or replace function public.mark_read(p_memo uuid)
returns void
language sql security definer set search_path = ''
as $$
  update public.memo_members set last_read_at = now()
   where memo_id = p_memo and user_id = (select auth.uid());
$$;

-- 로그인한 사용자만 호출 가능
revoke execute on function public.send_friend_request(text) from public, anon;
revoke execute on function public.accept_friend_request(uuid) from public, anon;
revoke execute on function public.create_memo(text, text, uuid[]) from public, anon;
revoke execute on function public.add_memo_members(uuid, uuid[]) from public, anon;
revoke execute on function public.my_memos() from public, anon;
revoke execute on function public.mark_read(uuid) from public, anon;
grant execute on function public.send_friend_request(text) to authenticated;
grant execute on function public.accept_friend_request(uuid) to authenticated;
grant execute on function public.create_memo(text, text, uuid[]) to authenticated;
grant execute on function public.add_memo_members(uuid, uuid[]) to authenticated;
grant execute on function public.my_memos() to authenticated;
grant execute on function public.mark_read(uuid) to authenticated;


-- ---------------------------------------------------------------------
-- 6. RLS (Row Level Security)
-- ---------------------------------------------------------------------
alter table public.profiles      enable row level security;
alter table public.friendships   enable row level security;
alter table public.memos         enable row level security;
alter table public.memo_members  enable row level security;
alter table public.memo_messages enable row level security;

-- profiles
create policy "관계있는 사람의 프로필만 조회"
  on public.profiles for select to authenticated using (public.can_see_profile(id));
create policy "본인 프로필 생성"
  on public.profiles for insert to authenticated with check (id = (select auth.uid()));
create policy "본인 프로필 수정"
  on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- friendships : 생성·수락은 RPC, 거절·취소·삭제는 당사자 누구나
create policy "당사자만 친구 관계 조회"
  on public.friendships for select to authenticated
  using ((select auth.uid()) in (requester_id, addressee_id));
create policy "당사자만 친구 관계 삭제"
  on public.friendships for delete to authenticated
  using ((select auth.uid()) in (requester_id, addressee_id));

-- memos : 생성은 RPC(create_memo)
create policy "참여자만 메모장 조회"
  on public.memos for select to authenticated using (public.is_memo_member(id));
create policy "방장만 메모장 정보 수정"
  on public.memos for update to authenticated
  using (public.is_memo_owner(id)) with check (public.is_memo_owner(id));
create policy "방장만 메모장 삭제"
  on public.memos for delete to authenticated using (public.is_memo_owner(id));

-- memo_members : 추가는 RPC(방장 + 친구만)
create policy "같은 메모장 참여자만 참여자 목록 조회"
  on public.memo_members for select to authenticated using (public.is_memo_member(memo_id));
create policy "방장이 내보내기 또는 본인이 나가기"
  on public.memo_members for delete to authenticated
  using (role <> 'owner' and (public.is_memo_owner(memo_id) or user_id = (select auth.uid())));

-- memo_messages
create policy "참여자만 메모 읽기"
  on public.memo_messages for select to authenticated using (public.is_memo_member(memo_id));
create policy "참여자만 메모 쓰기"
  on public.memo_messages for insert to authenticated
  with check (user_id = (select auth.uid()) and kind = 'text' and public.is_memo_member(memo_id));
create policy "본인 메모 또는 방장이 삭제"
  on public.memo_messages for delete to authenticated
  using (kind = 'text' and (user_id = (select auth.uid()) or public.is_memo_owner(memo_id)));


-- ---------------------------------------------------------------------
-- 7. Realtime (RLS 를 따르므로 권한 있는 사람에게만 전달)
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table public.friendships;
alter publication supabase_realtime add table public.memos;
alter publication supabase_realtime add table public.memo_members;
alter publication supabase_realtime add table public.memo_messages;


-- ---------------------------------------------------------------------
-- 8. 이미 가입해 있던 사용자의 프로필 보충
-- ---------------------------------------------------------------------
insert into public.profiles (id, email, display_name)
select u.id, u.email, coalesce(nullif(u.raw_user_meta_data ->> 'name', ''), split_part(u.email, '@', 1))
from auth.users u
on conflict (id) do nothing;
