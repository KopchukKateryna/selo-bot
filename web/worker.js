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
let DBREADY = false;
async function sdb(env) {
  if (!env.DB) return null;
  if (!DBREADY) {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS hits (ts INTEGER, day TEXT, hour INTEGER, uid TEXT, ev TEXT, sa INTEGER, dev TEXT, fs INTEGER)").run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS hits_day ON hits(day)").run();
    DBREADY = true;
  }
  return env.DB;
}
function kyivHour(d = new Date()) { return +new Intl.DateTimeFormat("en-GB", {timeZone: "Europe/Kyiv", hour: "2-digit", hourCycle: "h23"}).format(d); }
async function hit(req, env) {
  let b; try { b = await req.json(); } catch (e) { return new Response(null, {status: 204}); }
  const uid = String(b.uid || ""), ev = String(b.ev || "");
  if (!/^[a-z0-9-]{8,40}$/.test(uid) || ["open", "tour", "font"].indexOf(ev) < 0) return new Response(null, {status: 204});
  if (/bot|crawl|spider|preview/i.test(req.headers.get("user-agent") || "")) return new Response(null, {status: 204});
  const dev = ["ios", "android", "desktop"].indexOf(b.dev) >= 0 ? b.dev : "other";
  const db = await sdb(env); if (!db) return new Response(null, {status: 204});
  const now = new Date();
  await db.prepare("INSERT INTO hits (ts, day, hour, uid, ev, sa, dev, fs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(now.getTime(), kyivDate(now), kyivHour(now), uid, ev, b.sa ? 1 : 0, dev, Math.max(0, Math.min(4, +b.fs || 0))).run();
  return new Response(null, {status: 204});
}
function statsAccess(req, env, url) {
  const key = env.STATS_KEY; if (!key) return {ok: false};
  const k = url.searchParams.get("k");
  if (k && k === key) return {ok: true, set: true};
  return {ok: getCookie(req, "selost") === key};
}
async function apiStats(env) {
  const db = await sdb(env); if (!db) return {ok: false, error: "немає бази"};
  const today = kyivDate(), from = addDay(today, -13);
  const all = r => (r.results || []);
  const q = (sql, ...a) => db.prepare(sql).bind(...a).all().then(all);
  const one = async (sql, ...a) => (await q(sql, ...a))[0] || {};
  const [tot, days, first, sa, dev, tour, big, hours] = await Promise.all([
    one("SELECT COUNT(DISTINCT uid) AS users, SUM(ev = 'open') AS opens FROM hits"),
    q("SELECT day, SUM(ev = 'open') AS opens, COUNT(DISTINCT uid) AS users FROM hits WHERE day >= ? GROUP BY day", from),
    q("SELECT f AS day, COUNT(*) AS n FROM (SELECT uid, MIN(day) AS f FROM hits GROUP BY uid) WHERE f >= ? GROUP BY f", from),
    q("SELECT sa, COUNT(*) AS opens, COUNT(DISTINCT uid) AS users FROM hits WHERE ev = 'open' AND day >= ? GROUP BY sa", from),
    q("SELECT dev, COUNT(DISTINCT uid) AS users FROM hits WHERE day >= ? GROUP BY dev", from),
    one("SELECT COUNT(DISTINCT uid) AS users FROM hits WHERE ev = 'tour'"),
    one("SELECT COUNT(DISTINCT uid) AS users FROM hits WHERE fs >= 2"),
    q("SELECT hour, COUNT(*) AS opens FROM hits WHERE ev = 'open' AND day >= ? GROUP BY hour", addDay(today, -6)),
  ]);
  const nf = {}; first.forEach(r => nf[r.day] = r.n);
  const dm = {}; days.forEach(r => dm[r.day] = r);
  const series = []; for (let i = 13; i >= 0; i--) { const d = addDay(today, -i); series.push({day: d, opens: (dm[d] || {}).opens || 0, users: (dm[d] || {}).users || 0, fresh: nf[d] || 0}); }
  return {ok: true, today, total: {users: tot.users || 0, opens: tot.opens || 0}, series, sa, dev, tour: tour.users || 0, bigFont: big.users || 0, hours};
}
const STATS_PAGE = "<!doctype html><html lang=\"uk\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"color-scheme\" content=\"light dark\"><title>Статистика · Сяйво Наливайківки</title><link rel=\"icon\" type=\"image/svg+xml\" href=\"/favicon.svg\"><link href=\"https://fonts.googleapis.com/css2?family=Onest:wght@400;600;800&display=swap\" rel=\"stylesheet\"><style>" +
  ":root{--bg:#F2F4F7;--surface:#fff;--ink:#14202E;--muted:#66758A;--line:#E3E8EE;--accent:#3566D6;--on:#1F8A70;--warm:#E39A1C}@media(prefers-color-scheme:dark){:root{--bg:#0E1621;--surface:#152233;--ink:#E6ECF3;--muted:#8FA0B5;--line:#22324A;--accent:#6E9BFF;--on:#35B88F;--warm:#F0B44A}}" +
  "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:Onest,system-ui,sans-serif;font-size:15px}.wrap{max-width:1100px;margin:0 auto;padding:16px}h1{margin:4px 0 2px;font-size:22px;text-align:center}.sub{text-align:center;color:var(--muted);font-size:13px;margin:0 0 14px}" +
  ".grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}.card{background:var(--surface);border-radius:16px;padding:14px 16px}.card h2{margin:0 0 10px;font-size:15px}.k span{display:block;color:var(--muted);font-size:12.5px}.k b{font-size:28px;font-weight:800;font-variant-numeric:tabular-nums}.k small{display:block;color:var(--muted);font-size:12px}" +
  ".row2{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));margin-top:12px}.bars{display:flex;align-items:flex-end;gap:4px;height:150px;margin-top:6px}.bars div{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;min-width:0}.bars .p{display:flex;align-items:flex-end;gap:2px;width:100%;flex:1}.bars i,.bars u{display:block;flex:1;border-radius:3px 3px 0 0;background:var(--accent)}.bars u{background:var(--on)}.bars em{font-style:normal;font-size:10.5px;color:var(--muted);margin-top:4px;white-space:nowrap}.bars em s{text-decoration:none}@media(max-width:600px){.bars em s{display:none}}.bars b{font-size:11px;font-variant-numeric:tabular-nums}" +
  ".lg{display:flex;gap:14px;font-size:12.5px;color:var(--muted);margin-top:8px}.lg i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}.sh{display:flex;align-items:center;gap:10px;margin:8px 0;font-size:14px}.sh span{width:120px;flex:none}.sh .b{flex:1;height:14px;border-radius:7px;background:var(--line);overflow:hidden}.sh .b i{display:block;height:100%;background:var(--accent)}.sh b{width:92px;flex:none;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.sh b small{color:var(--muted);font-weight:600}@media(max-width:600px){.sh span{width:104px}}" +
  ".hrs{display:grid;grid-template-columns:repeat(24,1fr);gap:2px;align-items:end;height:90px}.hrs i{display:block;border-radius:2px 2px 0 0;background:var(--warm)}.hx{display:grid;grid-template-columns:repeat(24,1fr);font-size:10px;color:var(--muted);margin-top:3px}.note{color:var(--muted);font-size:12.5px;margin-top:14px;text-align:center}</style></head><body><div class=\"wrap\"><h1>📊 Статистика Сяйва Наливайківки</h1><p class=\"sub\" id=\"sub\">завантаження…</p><div id=\"app\"></div>" +
  "<p class=\"note\">Люди рахуються за анонімним номером браузера (без імен, телефонів і IP). Один телефон = одна людина, навіть якщо відкриває багато разів.</p></div><script>" +
  "function n(x){return String(x||0)}function pct(a,b){return b?Math.round(a*100/b)+'%':'—'}var DW=['Нд','Пн','Вт','Ср','Чт','Пт','Сб'];" +
  "fetch('/api/stats',{cache:'no-store'}).then(function(r){return r.json()}).then(function(s){if(!s.ok){document.getElementById('sub').textContent='Немає даних: '+(s.error||'');return}" +
  "var t=s.series[s.series.length-1],y=s.series[s.series.length-2]||{},mx=Math.max.apply(null,s.series.map(function(d){return Math.max(d.opens,d.users,1)}));" +
  "document.getElementById('sub').textContent='Оновлено '+new Date().toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'})+' · дані з першого дня роботи Сяйва села';" +
  "var h='<div class=\"grid\"><div class=\"card k\"><span>Усього людей</span><b>'+n(s.total.users)+'</b><small>за весь час</small></div><div class=\"card k\"><span>Сьогодні відкривали</span><b>'+n(t.opens)+'</b><small>учора '+n(y.opens)+'</small></div><div class=\"card k\"><span>Людей сьогодні</span><b>'+n(t.users)+'</b><small>учора '+n(y.users)+'</small></div><div class=\"card k\"><span>Нових сьогодні</span><b>'+n(t.fresh)+'</b><small>учора '+n(y.fresh)+'</small></div></div>';" +
  "h+='<div class=\"row2\"><div class=\"card\"><h2>Останні 14 днів</h2><div class=\"bars\">'+s.series.map(function(d){var p=d.day.split('-'),w=DW[new Date(Date.UTC(+p[0],+p[1]-1,+p[2])).getUTCDay()];return '<div title=\"'+d.day+': відкриттів '+d.opens+', людей '+d.users+', нових '+d.fresh+'\"><b>'+(d.opens||'')+'</b><span class=\"p\"><i style=\"height:'+(d.opens/mx*100)+'%\"></i><u style=\"height:'+(d.users/mx*100)+'%\"></u></span><em><s>'+w+' </s>'+(+p[2])+'</em></div>'}).join('')+'</div><div class=\"lg\"><span><i style=\"background:var(--accent)\"></i>відкриття</span><span><i style=\"background:var(--on)\"></i>люди</span></div></div>';" +
  "var su=0,ss=0;(s.sa||[]).forEach(function(r){su+=r.opens;if(r.sa)ss+=r.opens});var du=0,dv={};(s.dev||[]).forEach(function(r){du+=r.users;dv[r.dev]=r.users});" +
  "function sh(l,a,b){return '<div class=\"sh\"><span>'+l+'</span><div class=\"b\"><i style=\"width:'+(b?a*100/b:0)+'%\"></i></div><b>'+pct(a,b)+' <small>('+n(a)+')</small></b></div>'}" +
  "h+='<div class=\"card\"><h2>Як користуються (14 днів)</h2>'+sh('📲 зі значка',ss,su)+sh('🌐 у браузері',su-ss,su)+'<div style=\"height:8px\"></div>'+sh('iPhone',dv.ios||0,du)+sh('Android',dv.android||0,du)+sh('Комп’ютер',dv.desktop||0,du)+(dv.other?sh('Інше',dv.other,du):'')+'<div style=\"height:8px\"></div>'+sh('Пройшли тур',s.tour,s.total.users)+sh('Більший шрифт',s.bigFont,s.total.users)+'</div></div>';" +
  "var hm={},hx=1;(s.hours||[]).forEach(function(r){hm[r.hour]=r.opens;hx=Math.max(hx,r.opens)});var hh='',lb='';for(var i=0;i<24;i++){hh+='<i title=\"'+i+':00 — '+(hm[i]||0)+'\" style=\"height:'+((hm[i]||0)/hx*100)+'%\"></i>';lb+='<span>'+(i%3?'':String(i).padStart(2,'0'))+'</span>'}" +
  "h+='<div class=\"card\" style=\"margin-top:12px\"><h2>Коли відкривають (останні 7 днів, за годинами)</h2><div class=\"hrs\">'+hh+'</div><div class=\"hx\">'+lb+'</div></div>';document.getElementById('app').innerHTML=h})" +
  ".catch(function(){document.getElementById('sub').textContent='Не вдалося завантажити'});</script></body></html>";
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
      if (p === "/stats" || p === "/api/stats") {
        const sa = statsAccess(req, env, url);
        if (!sa.ok) return new Response("Немає доступу", {status: 403, headers: {"content-type": "text/plain; charset=utf-8"}});
        const hd = {"cache-control": "no-store", "x-robots-tag": "noindex"};
        if (sa.set) hd["set-cookie"] = "selost=" + encodeURIComponent(env.STATS_KEY) + "; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax";
        if (p === "/api/stats") return json(await apiStats(env), 200, hd);
        return new Response(STATS_PAGE, {headers: {...hd, "content-type": "text/html; charset=utf-8"}});
      }
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
      if (p === "/api/hit" && req.method === "POST") { try { return await hit(req, env); } catch (e) { return new Response(null, {status: 204}); } }
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
