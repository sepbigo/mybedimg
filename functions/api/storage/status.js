/**
 * GET /api/storage/status - ZYW图床 存储链路自检接口 (v3.0)
 * 一眼看出：R2 / KV / Telegram 到底有没有绑定、能不能真正读写。
 * 访问方式：登录后浏览器直接打开 https://你的域名/api/storage/status
 */

import { detectStorageBindings } from "../../upload.js";

export async function onRequestGet(context) {
  const { env } = context;
  const { kv, r2, names } = detectStorageBindings(env);

  const report = {
    version: "3.0",
    durable: false,
    bindings: { r2: names.r2, kv: names.kv },
    config: {
      uploadAuthEnabled: !!env.UPLOAD_AUTH_PASSWORD,
      maxFileSizeMB: parseInt(env.MAX_FILE_SIZE_MB || "25", 10) || 25,
      telegramConfigured: !!(env.TG_BOT_TOKEN && env.TG_CHAT_ID),
    },
    checks: {},
    advice: [],
  };

  // ---- R2 读写自检 ----
  if (r2) {
    const probeKey = `_healthcheck/${Date.now()}-${Math.random().toString(16).slice(2, 8)}.txt`;
    try {
      await r2.put(probeKey, new TextEncoder().encode("zyw-ok"));
      const head = await r2.head(probeKey);
      report.checks.r2 = head ? "ok" : "write_ok_but_head_failed";
      try {
        await r2.delete(probeKey);
      } catch {}
    } catch (e) {
      report.checks.r2 = `error: ${e && e.message ? e.message : "unknown"}`;
    }
  } else {
    report.checks.r2 = "not_bound";
    report.advice.push(
      "R2 未绑定：Pages 项目 → Settings → Bindings → Add → R2 bucket，变量名填 ZYW_R2_BUCKET。（推荐，最稳）"
    );
  }

  // ---- KV 读写自检 ----
  if (kv) {
    const probeKey = `_healthcheck:${Date.now()}`;
    try {
      await kv.put(probeKey, "zyw-ok");
      const val = await kv.get(probeKey, { cacheTtl: 60 });
      report.checks.kv = val === "zyw-ok" ? "ok" : "write_ok_but_read_failed";
      try {
        await kv.delete(probeKey);
      } catch {}
    } catch (e) {
      report.checks.kv = `error: ${e && e.message ? e.message : "unknown"}`;
    }
  } else {
    report.checks.kv = "not_bound";
    report.advice.push(
      "KV 未绑定：图库列表已改由 R2 枚举兜底（v3.1），不影响出图与看图库；但登录限流会失效（login.js 依赖 IMAGE_INDEX），密码可能被爆破。建议顺手绑一个 KV（免费额度足够），变量名 IMAGE_INDEX。"
    );
  }

  // ---- Telegram 自检 ----
  if (env.TG_BOT_TOKEN) {
    try {
      const resp = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getMe`, {
        signal: AbortSignal.timeout(8000),
      });
      const data = await resp.json().catch(() => null);
      if (data && data.ok) {
        report.checks.telegram = env.TG_CHAT_ID ? "ok" : "token_ok_but_chat_id_missing";
      } else {
        report.checks.telegram = "invalid_token";
      }
    } catch {
      report.checks.telegram = "network_error";
    }
  } else {
    report.checks.telegram = "not_configured";
    report.advice.push(
      "Telegram 未配置：可选。配置 TG_BOT_TOKEN + TG_CHAT_ID 后，即使不绑定 R2 也能生成永久直链。"
    );
  }

  const r2Ok = report.checks.r2 === "ok";
  const kvOk = report.checks.kv === "ok";
  const tgOk = report.checks.telegram === "ok";
  report.durable = r2Ok || kvOk || tgOk;

  if (!report.durable) {
    report.advice.unshift(
      "❌ 当前没有任何可用的持久化存储：上传只会写进易失的边缘缓存，直链必然在几分钟到几小时后 404。请立刻按下面第一条建议绑定 R2。"
    );
  } else {
    report.advice.unshift(`✅ 持久化存储已就绪（${r2Ok ? "R2" : kvOk ? "KV" : "Telegram"}），直链可长期访问。`);
  }

  return Response.json(report, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
