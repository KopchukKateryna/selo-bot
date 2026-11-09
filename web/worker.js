const ASSETS = "https://raw.githubusercontent.com/KopchukKateryna/selo-bot/master/web/";
async function asset(env, name, type) {
  const base = env.ASSETS_URL || ASSETS;
  const r = await fetch(base + name, {cf: {cacheTtl: 300, cacheEverything: true}});
  if (!r.ok) throw new Error("asset " + name + " " + r.status);
  return type === "text" ? r.text() : r.arrayBuffer();
}
const LAT = 50.476, LON = 29.70;
const KEEP_MS = 30 * 60 * 1000;
const json = (o, status = 200, extra = {}) => new Response(JSON.stringify(o), {status, headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra}});
function kyivDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit"}).format(d);
}
function addDay(key, n) { const [y, m, d] = key.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function offMin(iv) { return (iv || []).reduce((a, o) => a + (o[2] === "maybe" ? 0 : o[1] - o[0]), 0); }
function getCookie(req, name) {
  const c = req.headers.get("cookie") || "";
  const m = c.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
function access(req, env, url) {
  const code = env.ACCESS_CODE;
  if (!code) return {ok: true, k: ""};
  const k = url.searchParams.get("k");
  if (k && k === code) return {ok: true, k, set: true};
  if (getCookie(req, "selo") === code) return {ok: true, k: code};
  return {ok: false};
}
const DENY = "<!doctype html><html lang=\"uk\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Сяйво Наливайківки</title>\n" +
  "<style>body{margin:0;font-family:system-ui,sans-serif;background:#F2F4F7;color:#101A26;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px}\n" +
  "@media(prefers-color-scheme:dark){body{background:#0E1621;color:#F1F5FA}}h1{font-size:28px}p{font-size:20px;line-height:1.4;max-width:420px}</style></head>\n" +
  "<body><div><h1>Сяйво Наливайківки</h1><p>Відкрийте, будь ласка, посилання, яке вам надіслали сусіди чи староста.</p></div></body></html>";
async function readState(env) {
  return (await env.STATE.get("state", "json")) || {days: {}, hist: {}, notice: null, outage: null};
}
const GH_ISS = "https://token.actions.githubusercontent.com";
let JWKS = null, JWKS_AT = 0;
function b64u(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
async function ghOidcOk(tok, env) {
  try {
    const parts = tok.split("."); if (parts.length !== 3) return false;
    const dec = x => JSON.parse(new TextDecoder().decode(b64u(x)));
    const hdr = dec(parts[0]), pl = dec(parts[1]), now = Date.now() / 1000;
    const repo = (env.GH_REPO || "KopchukKateryna/selo-bot").toLowerCase();
    if (pl.iss !== GH_ISS || pl.aud !== "selo-bot" || String(pl.repository || "").toLowerCase() !== repo) return false;
    if (!(pl.exp > now) || (pl.iat && pl.iat > now + 120) || hdr.alg !== "RS256") return false;
    if (!JWKS || Date.now() - JWKS_AT > 3600e3 || !JWKS.some(k => k.kid === hdr.kid)) {
      const r = await fetch(GH_ISS + "/.well-known/jwks", {cf: {cacheTtl: 3600}});
      JWKS = (await r.json()).keys || []; JWKS_AT = Date.now();
    }
    const jwk = JWKS.find(k => k.kid === hdr.kid); if (!jwk) return false;
    const key = await crypto.subtle.importKey("jwk", {kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true}, {name: "RSASSA-PKCS1-v1_5", hash: "SHA-256"}, false, ["verify"]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  } catch (e) { return false; }
}
async function ingest(req, env) {
  const auth = req.headers.get("authorization") || "", tok = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const okTok = env.INGEST_TOKEN && tok === env.INGEST_TOKEN;
  if (!tok || (!okTok && !(await ghOidcOk(tok, env)))) return json({ok: false, error: "unauthorized"}, 401);
  let body;
  try { body = await req.json(); } catch (e) { return json({ok: false, error: "bad json"}, 400); }
  const prev = await readState(env);
  const now = new Date(), today = kyivDate(now);
  const next = {...prev};
  if (body.ok && body.days && typeof body.days === "object") {
    const days = {};
    for (const [k, v] of Object.entries(body.days)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && Array.isArray(v) && k >= today)
        days[k] = v.filter(x => Array.isArray(x) && x.length >= 3).map(x => [Math.max(0, Math.min(1440, +x[0])), Math.max(0, Math.min(1440, +x[1])), x[2] === "maybe" ? "maybe" : "off"]);
    }
    for (const [k, v] of Object.entries(prev.days || {})) if (k >= today && !days[k] && k === addDay(today, 1)) days[k] = v;
    next.days = days;
    next.outage = body.outage || null;
    if (body.notice !== undefined && body.notice !== null) next.notice = body.notice;
    if (body.group) next.group = String(body.group).replace(/^GPV/i, "");
    const hist = {...(prev.hist || {})};
    for (const [k, v] of Object.entries(days)) if (k === today) hist[k] = offMin(v);
    for (const k of Object.keys(hist)) if (k < addDay(today, -10)) delete hist[k];
    next.hist = hist;
    next.err = null;
    next.checked_at = now.toISOString();
  } else {
    next.err = String(body.error || "помилка скрапера").slice(0, 300);
    next.errAt = now.toISOString();
  }
  const sig = o => JSON.stringify([o.days, o.outage, o.notice, o.group, o.hist, o.err]);
  const changed = sig(prev) !== sig(next);
  const stale = !prev.writtenAt || now - new Date(prev.writtenAt) > KEEP_MS;
  if (changed || (body.ok && stale)) {
    next.writtenAt = now.toISOString();
    if (changed) next.updated_at = now.toISOString();
    await env.STATE.put("state", JSON.stringify(next));
    return json({ok: true, written: true, changed});
  }
  return json({ok: true, written: false});
}
async function apiState(env) {
  const s = await readState(env);
  const today = kyivDate();
  const days = {};
  for (const [k, v] of Object.entries(s.days || {})) if (k >= today) days[k] = v;
  return {ok: true, group: s.group || "6.2", days, notice: s.notice || null, outage: s.outage || null,
    hist: s.hist || {}, checked_at: s.checked_at || null, updated_at: s.updated_at || null, err: s.err || null};
}
async function apiWeather() {
  const u = new URL("https://api.open-meteo.com/v1/forecast");
  u.search = new URLSearchParams({
    latitude: LAT, longitude: LON, timezone: "Europe/Kyiv", wind_speed_unit: "ms", forecast_days: "3", forecast_hours: "14",
    current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day",
    hourly: "temperature_2m,precipitation_probability,precipitation,weather_code,is_day",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,rain_sum,showers_sum,snowfall_sum",
  }).toString();
  const r = await fetch(u.toString(), {cf: {cacheTtl: 1800, cacheEverything: true}});
  if (!r.ok) throw new Error("open-meteo " + r.status);
  const j = await r.json();
  const c = j.current || {}, h = j.hourly || {}, d = j.daily || {};
  const hourly = (h.time || []).map((t, i) => ({time: t.slice(11, 16), t: h.temperature_2m[i], pp: h.precipitation_probability ? h.precipitation_probability[i] || 0 : 0,
    pr: h.precipitation ? h.precipitation[i] || 0 : 0, code: h.weather_code[i], day: h.is_day ? h.is_day[i] === 1 : true}));
  const daily = (d.time || []).map((t, i) => ({date: t, min: d.temperature_2m_min[i], max: d.temperature_2m_max[i], code: d.weather_code[i],
    rain: (d.rain_sum ? d.rain_sum[i] || 0 : 0) + (d.showers_sum ? d.showers_sum[i] || 0 : 0), snow: d.snowfall_sum ? d.snowfall_sum[i] || 0 : 0}));
  return {ok: true, current: {t: c.temperature_2m, feels: c.apparent_temperature, code: c.weather_code, wind: c.wind_speed_10m, day: c.is_day === 1}, hourly, daily};
}
function manifest(a) {
  const k = a.k ? "?k=" + encodeURIComponent(a.k) : "";
  return {name: "Сяйво Наливайківки", short_name: "Сяйво", lang: "uk", start_url: "/" + k, scope: "/", display: "standalone",
    background_color: "#F2F4F7", theme_color: "#F2F4F7",
    description: "Графік відключень світла в Наливайківці, погода, схід і захід сонця",
    icons: [{src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any"},
            {src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any"},
            {src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable"}]};
}
const SW = "self.addEventListener(\"install\",e=>self.skipWaiting());\nself.addEventListener(\"activate\",e=>e.waitUntil(self.clients.claim()));\nself.addEventListener(\"fetch\",e=>{});";
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === "/ingest" && req.method === "POST") return await ingest(req, env);
      if (p === "/health") { const s = await readState(env); return json({ok: true, checked_at: s.checked_at || null, updated_at: s.updated_at || null, err: s.err || null, days: Object.keys(s.days || {})}); }
      const IMG = {"/icon-180.png": "icon-180.png", "/apple-touch-icon.png": "icon-180.png", "/apple-touch-icon-precomposed.png": "icon-180.png",
        "/icon-192.png": "icon-192.png", "/icon-512.png": "icon-512.png", "/favicon.ico": "icon-192.png"};
      if (IMG[p]) return new Response(await asset(env, IMG[p]), {headers: {"content-type": "image/png", "cache-control": "public, max-age=604800"}});
      if (p === "/favicon.svg") return new Response(await asset(env, "favicon.svg", "text"), {headers: {"content-type": "image/svg+xml", "cache-control": "public, max-age=604800"}});
      if (p === "/sw.js") return new Response(SW, {headers: {"content-type": "application/javascript", "cache-control": "no-cache"}});
      if (p === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n", {headers: {"content-type": "text/plain"}});
      const a = access(req, env, url);
      if (p === "/manifest.webmanifest") return new Response(JSON.stringify(manifest(a)), {headers: {"content-type": "application/manifest+json", "cache-control": "no-cache"}});
      if (!a.ok) return p.startsWith("/api/") ? json({ok: false, error: "no access"}, 403) : new Response(DENY, {status: 403, headers: {"content-type": "text/html; charset=utf-8"}});
      if (p === "/api/state") {
        const cache = caches.default, key = new Request(url.origin + "/api/state?c=1");
        const hit = await cache.match(key);
        if (hit) return new Response(hit.body, {headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"}});
        const body = JSON.stringify(await apiState(env));
        ctx.waitUntil(cache.put(key, new Response(body, {headers: {"content-type": "application/json", "cache-control": "public, max-age=60"}})));
        return new Response(body, {headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"}});
      }
      if (p === "/api/weather") {
        try { return json(await apiWeather()); }
        catch (e) { return json({ok: false, error: String(e.message || e)}, 502); }
      }
      if (p === "/" || p === "/index.html") {
        const headers = {"content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-robots-tag": "noindex"};
        if (a.set) headers["set-cookie"] = "selo=" + encodeURIComponent(a.k) + "; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax";
        let page;
        try { page = await asset(env, "page.html", "text"); }
        catch (e) { return new Response("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><p style='font:20px system-ui;padding:24px'>Сяйво тимчасово недоступне. Спробуйте за хвилину.</p>", {status: 503, headers: {"content-type": "text/html; charset=utf-8"}}); }
        const html = page.split("/*KQ*/").join(a.k ? "?k=" + encodeURIComponent(a.k) : "");
        return new Response(html, {headers});
      }
      return new Response("Не знайдено", {status: 404});
    } catch (e) {
      return json({ok: false, error: String(e && e.message || e)}, 500);
    }
  },
};
