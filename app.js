const $ = (selector) => document.querySelector(selector);
const state = { user: null, memos: [], folders: [], workspaces: [], view: "all", filterId: null, search: "", currentMemo: null };
const authScreen = $("#authScreen"), app = $("#app"), memoList = $("#memoList");

function message(target, text = "", error = false) { target.textContent = text; target.classList.toggle("error", error); }
function escapeText(value) { return String(value || "").trim(); }
function formatDate(value) { return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric" }).format(new Date(value)); }
function setStatus(text, error = false) { message($("#statusMessage"), text, error); }

async function request(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

function openAuth() { authScreen.hidden = false; app.hidden = true; }
async function startApp(session) {
  state.user = session.user;
  authScreen.hidden = true; app.hidden = false;
  $("#userEmail").textContent = session.user.email;
  await loadEverything();
}

async function loadEverything() {
  try {
    setStatus("메모를 불러오는 중입니다.");
    const [folders, workspaces, memos] = await Promise.all([
      request(sb.from("memo_folders").select("id,name").order("sort_order").order("name")),
      request(sb.from("workspaces").select("id,name").order("name")),
      request(sb.from("memos").select("id,title,body,folder_id,workspace_id,is_pinned,archived_at,deleted_at,created_at,updated_at").order("updated_at", { ascending: false }))
    ]);
    state.folders = folders; state.workspaces = workspaces; state.memos = memos;
    renderSideLists(); renderMemos(); setStatus("");
  } catch (error) { setStatus(`불러오지 못했습니다: ${error.message}`, true); }
}

function renderSideLists() {
  const folderList = $("#folderList"), workspaceList = $("#workspaceList");
  folderList.replaceChildren(); workspaceList.replaceChildren();
  state.folders.forEach((folder) => folderList.append(filterButton(folder.name, "folder", folder.id)));
  state.workspaces.forEach((workspace) => workspaceList.append(filterButton(workspace.name, "workspace", workspace.id)));
}
function filterButton(label, type, id) {
  const button = document.createElement("button"); button.type = "button"; button.className = "list-filter"; button.textContent = label;
  button.addEventListener("click", () => { state.view = type; state.filterId = id; activateView(button); renderMemos(); }); return button;
}
function activateView(button) { document.querySelectorAll(".nav-item,.list-filter").forEach((item) => item.classList.remove("active")); button.classList.add("active"); }

function visibleMemos() {
  const keyword = state.search.toLowerCase();
  return state.memos.filter((memo) => {
    if (state.view === "pinned" && !memo.is_pinned) return false;
    if (state.view === "archive" && !memo.archived_at) return false;
    if (state.view === "trash" ? !memo.deleted_at : memo.deleted_at) return false;
    if (state.view === "folder" && memo.folder_id !== state.filterId) return false;
    if (state.view === "workspace" && memo.workspace_id !== state.filterId) return false;
    return !keyword || `${memo.title} ${memo.body}`.toLowerCase().includes(keyword);
  });
}
function renderMemos() {
  const labels = { all: ["내 메모", "전체 메모"], pinned: ["바로 보기", "고정됨"], archive: ["정리함", "보관됨"], trash: ["삭제한 메모", "휴지통"], folder: ["폴더", "폴더 메모"], workspace: ["협업 공간", "워크스페이스"] };
  $("#viewCaption").textContent = labels[state.view][0]; $("#viewTitle").textContent = labels[state.view][1];
  $("#clearFilterButton").hidden = !state.search; memoList.replaceChildren();
  const memos = visibleMemos();
  if (!memos.length) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = state.search ? "검색 결과가 없습니다." : "아직 메모가 없습니다. 새 메모를 만들어 보세요."; memoList.append(empty); return; }
  memos.forEach((memo) => {
    const card = document.createElement("article"), title = document.createElement("h2"), body = document.createElement("p"), meta = document.createElement("div");
    card.className = "memo-card"; title.textContent = memo.title || "제목 없음"; body.textContent = memo.body || "내용 없음"; meta.className = "memo-meta";
    const place = document.createElement("span"); place.textContent = memo.workspace_id ? "공유 메모" : (state.folders.find((f) => f.id === memo.folder_id)?.name || "개인");
    const date = document.createElement("time"); date.textContent = formatDate(memo.updated_at); meta.append(place, date); card.append(title, body, meta);
    if (memo.is_pinned) { const pin = document.createElement("span"); pin.className = "pin"; pin.textContent = "★"; card.append(pin); }
    card.addEventListener("click", () => openMemo(memo)); memoList.append(card);
  });
}

function fillSelect(select, items, selected, blankLabel) {
  select.replaceChildren(); const blank = new Option(blankLabel, ""); select.add(blank);
  items.forEach((item) => select.add(new Option(item.name, item.id, false, item.id === selected)));
}
async function openMemo(memo = null) {
  state.currentMemo = memo;
  $("#memoDialogTitle").textContent = memo ? "메모 편집" : "새 메모";
  $("#memoTitleInput").value = memo?.title || ""; $("#memoBodyInput").value = memo?.body || ""; $("#tagInput").value = "";
  fillSelect($("#folderSelect"), state.folders, memo?.folder_id, "폴더 없음"); fillSelect($("#workspaceSelect"), state.workspaces, memo?.workspace_id, "개인 메모");
  $("#pinButton").textContent = memo?.is_pinned ? "★ 고정 해제" : "☆ 고정";
  $("#trashButton").hidden = !memo; $("#trashButton").textContent = memo?.deleted_at ? "휴지통에서 복원" : "휴지통으로";
  $("#archiveButton").hidden = !memo; $("#archiveButton").textContent = memo?.archived_at ? "보관 해제" : "보관";
  ["#shareSection", "#commentsSection", "#historySection"].forEach((id) => { $(id).hidden = !memo; });
  if (memo) await Promise.all([loadComments(), loadHistory()]);
  $("#memoDialog").showModal();
}

async function saveMemo() {
  const current = state.currentMemo;
  const values = { title: escapeText($("#memoTitleInput").value), body: $("#memoBodyInput").value, folder_id: Number($("#folderSelect").value) || null, workspace_id: Number($("#workspaceSelect").value) || null, is_pinned: current?.is_pinned || false };
  try {
    let saved;
    if (current) saved = await request(sb.from("memos").update(values).eq("id", current.id).select().single());
    else saved = await request(sb.from("memos").insert(values).select().single());
    state.currentMemo = saved;
    await saveTags(saved.id);
    $("#memoDialog").close(); await loadEverything();
  } catch (error) { setStatus(`저장하지 못했습니다: ${error.message}`, true); }
}
async function togglePin() { if (!state.currentMemo) return; state.currentMemo.is_pinned = !state.currentMemo.is_pinned; $("#pinButton").textContent = state.currentMemo.is_pinned ? "★ 고정 해제" : "☆ 고정"; }
async function changeMemoState(field, enabled) { if (!state.currentMemo) return; try { await request(sb.from("memos").update({ [field]: enabled ? new Date().toISOString() : null }).eq("id", state.currentMemo.id)); $("#memoDialog").close(); await loadEverything(); } catch (error) { setStatus(error.message, true); } }
async function saveTags(memoId) {
  const names = [...new Set($("#tagInput").value.split(",").map(escapeText).filter(Boolean))];
  if (!names.length) return;
  for (const name of names) {
    let tag = await request(sb.from("tags").select("id").eq("name", name).maybeSingle());
    if (!tag) tag = await request(sb.from("tags").insert({ name }).select("id").single());
    await request(sb.from("memo_tags").upsert({ memo_id: memoId, tag_id: tag.id }));
  }
}

async function loadComments() {
  const comments = await request(sb.from("memo_comments").select("id,content,created_at,author_id").eq("memo_id", state.currentMemo.id).order("created_at"));
  const list = $("#commentList"); list.replaceChildren();
  comments.forEach((comment) => { const item = document.createElement("article"), author = document.createElement("b"), content = document.createElement("p"), date = document.createElement("time"); item.className = "comment"; author.textContent = comment.author_id === state.user.id ? "나" : "공유 참여자"; content.textContent = comment.content; date.textContent = new Date(comment.created_at).toLocaleString("ko-KR"); item.append(author, content, date); list.append(item); });
}
async function addComment() { const content = escapeText($("#commentInput").value); if (!content) return; try { await request(sb.from("memo_comments").insert({ memo_id: state.currentMemo.id, content })); $("#commentInput").value = ""; await loadComments(); } catch (error) { setStatus(error.message, true); } }
async function loadHistory() { const versions = await request(sb.from("memo_versions").select("title,created_at,changed_by").eq("memo_id", state.currentMemo.id).order("created_at", { ascending: false }).limit(10)); const list = $("#historyList"); list.replaceChildren(); versions.forEach((version) => { const item = document.createElement("p"); item.className = "history-item"; item.textContent = `${version.title || "제목 없음"} · ${new Date(version.created_at).toLocaleString("ko-KR")}`; list.append(item); }); }
async function shareMemo() { const email = escapeText($("#shareEmailInput").value); if (!email) return; message($("#shareMessage"), ""); try { await request(sb.rpc("invite_memo_member", { p_memo_id: state.currentMemo.id, p_email: email, p_role: $("#shareRoleSelect").value })); message($("#shareMessage"), "초대했습니다."); $("#shareEmailInput").value = ""; } catch (error) { message($("#shareMessage"), error.message, true); } }

function openSimple(kind) { $("#simpleForm").dataset.kind = kind; $("#simpleTitle").textContent = kind === "folder" ? "새 폴더" : "새 워크스페이스"; $("#simpleLabel").firstChild.textContent = kind === "folder" ? "폴더 이름" : "워크스페이스 이름"; $("#simpleInput").value = ""; $("#simpleDialog").showModal(); }
async function saveSimple() { const kind = $("#simpleForm").dataset.kind, name = escapeText($("#simpleInput").value); if (!name) return; try { await request(sb.from(kind === "folder" ? "memo_folders" : "workspaces").insert({ name })); $("#simpleDialog").close(); await loadEverything(); } catch (error) { setStatus(error.message, true); } }

$("#authForm").addEventListener("submit", async (event) => { event.preventDefault(); message($("#authMessage"), "로그인 중입니다."); const { error } = await sb.auth.signInWithPassword({ email: $("#emailInput").value.trim(), password: $("#passwordInput").value }); if (error) message($("#authMessage"), error.message, true); });
$("#signUpButton").addEventListener("click", async () => { const email = $("#emailInput").value.trim(), password = $("#passwordInput").value; if (!email || !password) return message($("#authMessage"), "이메일과 비밀번호를 입력하세요.", true); const { data, error } = await sb.auth.signUp({ email, password }); message($("#authMessage"), error ? error.message : (data.session ? "회원가입과 로그인이 완료되었습니다." : "가입 확인 이메일을 확인해 주세요."), Boolean(error)); });
$("#signOutButton").addEventListener("click", () => sb.auth.signOut()); $("#newMemoButton").addEventListener("click", () => openMemo()); $("#saveMemoButton").addEventListener("click", saveMemo); $("#pinButton").addEventListener("click", togglePin); $("#trashButton").addEventListener("click", () => changeMemoState("deleted_at", !state.currentMemo.deleted_at)); $("#archiveButton").addEventListener("click", () => changeMemoState("archived_at", !state.currentMemo.archived_at)); $("#commentButton").addEventListener("click", addComment); $("#shareButton").addEventListener("click", shareMemo); $("#addFolderButton").addEventListener("click", () => openSimple("folder")); $("#addWorkspaceButton").addEventListener("click", () => openSimple("workspace")); $("#simpleForm").addEventListener("submit", (event) => { if (event.submitter?.value === "default") { event.preventDefault(); saveSimple(); } });
$("#searchInput").addEventListener("input", (event) => { state.search = event.target.value.trim(); renderMemos(); }); $("#clearFilterButton").addEventListener("click", () => { $("#searchInput").value = ""; state.search = ""; renderMemos(); });
document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => { state.view = button.dataset.view; state.filterId = null; activateView(button); renderMemos(); }));
sb.auth.onAuthStateChange((_event, session) => { if (session) startApp(session); else openAuth(); });
sb.auth.getSession().then(({ data }) => data.session ? startApp(data.session) : openAuth());
