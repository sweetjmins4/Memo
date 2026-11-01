// Supabase Dashboard > Project Settings > API에서 값을 복사해 넣으세요.
// publishable key는 웹 브라우저에 사용해도 되는 공개 키입니다. service_role 키는 절대 넣지 마세요.
const SUPABASE_URL = "https://kpiozfavcbgtrukpvgou.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_sITTs0Cp2lEf8Q1q8p-3jw_9likljfu";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
