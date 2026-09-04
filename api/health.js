// 環境変数チェック付き ヘルスチェック
export default function handler(req, res) {
  const env = {
    supabase: !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    drive: !!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CLIENT_EMAIL) && !!process.env.GDRIVE_ROOT_FOLDER_ID,
    driveHr: !!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_CLIENT_EMAIL) && !!process.env.GDRIVE_HR_FOLDER_ID,
  };
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = 200;
  res.end(JSON.stringify({
    ok: true,
    service: "kessanpilot-api",
    // どのビルドが動いているかを画面を開かずに判別するための印
    assetVersion: "20260905e",
    features: { documentDelete: true, groupware: true, notices: true, onboarding: true, tasks: true, members: true, messages: true, assets: true, templates: true, settings: true, advisor: true, hrFolder: true },
    env,
    note: env.supabase && env.anthropic
      ? "ready"
      : "set missing env vars in Vercel project settings"
  }));
}
