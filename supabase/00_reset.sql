-- =====================================================================
--  00_reset.sql
--  이전 버전 SQL 을 실행한 적이 있을 때만 사용하세요.
--  ⚠️ 기존 메모·친구 데이터가 모두 삭제됩니다. (가입한 계정은 유지)
--  처음 설치라면 건너뛰고 01_schema.sql 만 실행하면 됩니다.
-- =====================================================================

drop trigger if exists on_auth_user_created on auth.users;

-- 1차 버전 (워크스페이스)
drop table if exists public.workspace_invites cascade;
drop table if exists public.workspace_members cascade;
drop table if exists public.workspaces cascade;
-- 2차 버전 (메모 단위 권한 + 접근 요청)
drop table if exists public.memo_comments cascade;
drop table if exists public.memo_access_requests cascade;
-- 현재 버전
drop table if exists public.memo_messages cascade;
drop table if exists public.memo_members cascade;
drop table if exists public.memos cascade;
drop table if exists public.friendships cascade;
drop table if exists public.profiles cascade;

drop type if exists public.member_role cascade;
drop type if exists public.memo_role cascade;
drop type if exists public.request_status cascade;
drop type if exists public.friend_status cascade;

drop function if exists public.handle_new_user cascade;
drop function if exists public.handle_new_workspace cascade;
drop function if exists public.handle_new_memo cascade;
drop function if exists public.handle_memo_write cascade;
drop function if exists public.accept_invite cascade;
drop function if exists public.is_member cascade;
drop function if exists public.has_role cascade;
drop function if exists public.memo_role_of cascade;
drop function if exists public.is_memo_member cascade;
drop function if exists public.is_memo_owner cascade;
drop function if exists public.can_edit_memo cascade;
drop function if exists public.can_see_profile cascade;
drop function if exists public.request_memo_access cascade;
drop function if exists public.memo_request_info cascade;
drop function if exists public.decide_request cascade;
drop function if exists public.grant_memo_access cascade;
drop function if exists public.toggle_pin cascade;
drop function if exists public.are_friends cascade;
drop function if exists public.send_friend_request cascade;
drop function if exists public.accept_friend_request cascade;
drop function if exists public.create_memo cascade;
drop function if exists public.add_memo_members cascade;
drop function if exists public.my_memos cascade;
drop function if exists public.mark_read cascade;
drop function if exists public.handle_memo_before cascade;
drop function if exists public.handle_message_after cascade;
drop function if exists public.handle_member_after cascade;
drop function if exists public.display_name_of cascade;
