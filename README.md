# Memo 협업 웹사이트

GitHub Pages와 Supabase를 이용하는 정적 웹사이트입니다.

## 실행 순서

1. Supabase SQL Editor에서 `memo_schema.sql`을 실행합니다.
2. 이어서 `memo_collaboration_schema.sql`을 실행합니다.
3. `config.js`에 Supabase URL과 publishable key를 입력합니다. `service_role` 키는 절대 사용하지 마세요.
4. `index.html`을 브라우저로 열어 확인합니다.
5. 이 `Memo` 폴더 전체를 GitHub 저장소에 올린 뒤 GitHub Pages의 배포 폴더를 루트(`/`)로 지정합니다.

## 포함 기능

- 이메일 회원가입과 로그인
- 개인 메모 작성, 수정, 휴지통, 보관, 고정
- 폴더, 태그, 제목·본문 검색
- 워크스페이스 생성
- 메모 공유(보기/편집/관리 권한)
- 댓글과 메모 변경 이력

공유할 사람은 먼저 같은 사이트에서 회원가입해야 합니다. 공유 창에는 그 사람의 **가입 이메일**을 입력합니다.
