/**
 * GET / POST /api/bing/wallpaper - Bing 每日高清壁纸代理接口
 * 兼容原版 POST {"n":5} 与 GET 请求，带边缘缓存与高颜值兜底数据
 */

const FALLBACK_WALLPAPERS = [
  {
    title: "极光下的冰岛黑沙滩",
    copyright: "Reynisfjara Black Sand Beach, Iceland (© ZYW Curated UHD)",
    url: "/th?id=OHR.IcelandAurora_ZH-CN",
    gradient: "linear-gradient(135deg, #0b132b 0%, #1c2541 45%, #3a506b 100%)",
  },
  {
    title: "阿尔卑斯山脉晨曦云海",
    copyright: "Dolomites Mountain Range at Dawn, Italy (© ZYW Curated UHD)",
    url: "/th?id=OHR.DolomitesDawn_ZH-CN",
    gradient: "linear-gradient(135deg, #0f172a 0%, #1e3a8a 50%, #0284c7 100%)",
  },
  {
    title: "挪威罗弗敦群岛峡湾星夜",
    copyright: "Lofoten Islands Fjord under Milky Way, Norway (© ZYW Curated UHD)",
    url: "/th?id=OHR.LofotenStars_ZH-CN",
    gradient: "linear-gradient(135deg, #111827 0%, #312e81 50%, #4f46e5 100%)",
  },
  {
    title: "赛博霓虹光影几何艺术",
    copyright: "Abstract Sapphire & Cyan Light Waves (© ZYW Studio)",
    url: "/th?id=OHR.CyberWaves_ZH-CN",
    gradient: "linear-gradient(135deg, #090d16 0%, #1e293b 45%, #0ea5e9 100%)",
  },
  {
    title: "翡翠冷杉林间薄雾",
    copyright: "Misty Evergreen Forest in Pacific Northwest (© ZYW Curated UHD)",
    url: "/th?id=OHR.MistyForest_ZH-CN",
    gradient: "linear-gradient(135deg, #052e16 0%, #115e59 50%, #0284c7 100%)",
  },
];

async function handleBingRequest(request) {
  let n = 5;
  if (request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (body && typeof body.n === "number") {
      n = Math.min(Math.max(1, body.n), 8);
    }
  }

  try {
    const resp = await fetch(
      `https://cn.bing.com/HPImageArchive.aspx?format=js&idx=0&n=${n}&mkt=zh-CN`,
      { cf: { cacheTtl: 3600, cacheEverything: true } }
    );
    if (resp.ok) {
      const json = await resp.json();
      if (json && Array.isArray(json.images)) {
        return Response.json({
          status: 200,
          data: json.images.map((img) => ({
            title: img.title,
            copyright: img.copyright,
            url: img.url,
            fullUrl: `https://cn.bing.com${img.url}`,
          })),
        });
      }
    }
  } catch {
    // 离线或上游超时回退至内置壁纸
  }

  return Response.json({
    status: 200,
    data: FALLBACK_WALLPAPERS.slice(0, n),
  });
}

export async function onRequestGet(context) {
  return handleBingRequest(context.request);
}

export async function onRequestPost(context) {
  return handleBingRequest(context.request);
}
