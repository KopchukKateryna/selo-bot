"""Скрапер «Сяйва Наливайківки» (тест): графік ДТЕК для черги села -> окремий Worker (/ingest).

Запускається в GitHub Actions кожні ~10 хв. Адреса — будь-який будинок черги 6.2 (задається у файлі запуску).
Ключа немає: Worker перевіряє «посвідчення» (OIDC), яке GitHub видає кожному запуску цього репозиторію.
Логіка звернення до ДТЕК — та сама, що в перевіреному скрапері «Сяйва наших вікон».
"""
import asyncio
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from dtek_client import DtekClient
from dtek_client.exceptions import DtekClientError

SITE = os.getenv("DTEK_SITE", "krem")
CITY = os.environ["CITY"]
STREET = os.environ["STREET"]
HOUSE = os.environ["HOUSE"]
WORKER_URL = os.environ["WORKER_URL"].rstrip("/")
INGEST_TOKEN = os.getenv("INGEST_TOKEN", "")
# інші черги села (напр. "5.1,5.2,1.1"): ДТЕК віддає графіки всіх черг тим самим запитом
EXTRA_GROUPS = [g.strip() for g in os.getenv("EXTRA_GROUPS", "").split(",") if g.strip()]
TZ = ZoneInfo("Europe/Kyiv")


async def _browser_client(show_browser: bool, site: str = SITE):
    from curl_cffi.requests import AsyncSession
    from dtek_client.browser_auth import get_cleared_cookies

    base_url = f"https://www.dtek-{site}.com.ua"
    schedule_url = f"{base_url}/ua/shutdowns"
    cookies, csrf = await get_cleared_cookies(schedule_url, show_browser=show_browser)
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "uk,en;q=0.9",
        "Origin": base_url,
        "Referer": schedule_url,
        "X-Requested-With": "XMLHttpRequest",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    }
    if csrf:
        headers["X-CSRF-Token"] = csrf
    session = AsyncSession(timeout=15.0, headers=headers, cookies=cookies, impersonate="chrome120")
    return DtekClient(site, ajax_url=f"{base_url}/ua/ajax", session=session)


async def _fetch_with(client, city=CITY, street=STREET, house=HOUSE):
    """Один запит getHomeNum: графік на сьогодні/завтра + поточне відключення будинку."""
    async with client as c:
        resp = await c.get_home_num(city, street)
    entry = resp.houses.get(house)
    today = tomorrow = None
    extra = {}
    if entry is not None and entry.primary_group and resp.fact is not None:
        today = resp.fact.get_group_today(entry.primary_group)
        tomorrow = resp.fact.get_group_day(resp.fact.today_ts + 86400, entry.primary_group)
        # назва черги в ДТЕК — з префіксом (напр. "GPV6.2"): беремо той самий префікс для інших черг
        m = re.match(r"^(.*?)(\d+\.\d+)$", str(entry.primary_group))
        prefix = m.group(1) if m else ""
        for g in EXTRA_GROUPS:
            try:
                t = resp.fact.get_group_today(prefix + g)
                if t:
                    extra[g] = (t, resp.fact.get_group_day(resp.fact.today_ts + 86400, prefix + g))
            except Exception as e:  # noqa: BLE001  (інші черги — бонус, основна важливіша)
                print(f"Черга {g}: не вдалося взяти графік:", type(e).__name__, e, file=sys.stderr)
    return today, tomorrow, entry, extra


async def fetch_raw(site=SITE, city=CITY, street=STREET, house=HOUSE):
    """Спершу звичайний запит, потім браузер (headless), потім браузер із вікном (під xvfb)."""
    errors = []
    try:
        return await _fetch_with(DtekClient(site), city, street, house)
    except Exception as e:  # noqa: BLE001
        errors.append(f"plain: {type(e).__name__}")
    for show in (False, True):
        try:
            return await _fetch_with(await _browser_client(show, site), city, street, house)
        except Exception as e:  # noqa: BLE001
            errors.append(f"browser(show={show}): {type(e).__name__}: {e}")
    raise DtekClientError("; ".join(errors))


def to_intervals(slots):
    """{'1': 'yes'|'no'|'first'|'second'|..., ...} -> [[start_min, end_min, 'off'|'maybe'], ...].

    Слот N = година (N-1):00–N:00; 'no' = відключення, 'first'/'second' = перша/друга
    половина години, 'maybe'/'mfirst'/'msecond' = можливе відключення.
    """
    parts = {
        "no": (0, 60, "off"), "first": (0, 30, "off"), "second": (30, 60, "off"),
        "maybe": (0, 60, "maybe"), "mfirst": (0, 30, "maybe"), "msecond": (30, 60, "maybe"),
    }
    segs = []
    for key, status in slots.items():
        try:
            hour = int(key) - 1
        except (TypeError, ValueError):
            continue
        name = str(getattr(status, "value", status)).lower()
        if name in parts:
            a, b, state = parts[name]
            segs.append([hour * 60 + a, hour * 60 + b, state])
    segs.sort()
    result = []
    for seg in segs:
        if result and result[-1][1] == seg[0] and result[-1][2] == seg[2]:
            result[-1][1] = seg[1]
        else:
            result.append(seg)
    return result


def _parse_dt(text):
    """'26.03.2026 09:00' або '14:21 30.10.2026' -> ISO-рядок з київським часом (або None)."""
    text = " ".join(str(text or "").split())
    for fmt in ("%d.%m.%Y %H:%M", "%H:%M %d.%m.%Y", "%d.%m.%Y %H:%M:%S", "%H:%M:%S %d.%m.%Y", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=TZ).isoformat()
        except ValueError:
            continue
    return None


def to_outage(entry):
    """Поточне відключення будинку з відповіді ДТЕК -> dict або None."""
    if entry is None:
        return None
    reason = (entry.sub_type or "").strip()
    start_raw = (entry.start_date or "").strip()
    end_raw = (entry.end_date or "").strip()
    if not reason and not start_raw:
        return None
    kind_raw = str(entry.outage_type or "").strip()
    low = reason.lower()
    if "авар" in low or "екстр" in low:
        kind = "emergency"
    elif kind_raw == "1" or "план" in low:
        kind = "planned"
    else:
        kind = "other"
    return {
        "kind": kind,
        "reason": reason[:200],
        "start": _parse_dt(start_raw),
        "end": _parse_dt(end_raw),
        "start_raw": start_raw[:40],
        "end_raw": end_raw[:40],
        "type_raw": kind_raw[:10],
    }


NOTICE_START = "шановні клієнти"
NOTICE_END = ("дякуємо",)


def parse_notice(page_text):
    """Текст сторінки відключень -> оголошення ДТЕК (вікно «Шановні клієнти!») або «немає».

    Шукаємо саме це вікно, а не будь-які згадки на сторінці (у довідці теж пишуть про
    екстрені відключення). Повертає {active, noSchedule, text}.
    """
    lines = [" ".join(l.split()) for l in str(page_text or "").splitlines()]
    lines = [l for l in lines if l]
    start = next((i for i, l in enumerate(lines) if l.lower().startswith(NOTICE_START)), None)
    if start is None:
        return {"active": False, "noSchedule": False, "text": ""}
    body = []
    for l in lines[start + 1:start + 20]:
        if l.lower().startswith(NOTICE_END) or l.lower().startswith(NOTICE_START):
            break
        body.append(l)
    text = " ".join(body)[:600]
    low = text.lower()
    # лише справжні екстрені («введені / діють екстрені відключення»), а не «щоб уникнути екстрених»
    emergency = re.search(r"(введен\w*|запроваджен\w*|застосован\w*|діють)\s+(\S+\s+)?екстрен", low) is not None
    no_schedule = emergency and ("не діють" in low or "не діє" in low)
    # показуємо лише важливе: екстрені відключення або аварія (звичайні оголошення — ні)
    active = emergency or "авар" in low
    return {"active": active, "noSchedule": no_schedule, "text": text if active else ""}


NOTICE_JS = """() => {
  const leaf = [...document.querySelectorAll('body *')]
    .filter(e => e.children.length === 0 && /шановні\\s+клієнти/i.test(e.textContent || ''))[0];
  if (!leaf) return null;
  let box = leaf;
  while (box.parentElement && box.parentElement !== document.body && !/дякуємо/i.test(box.textContent || '')
         && (box.textContent || '').length < 5000) box = box.parentElement;
  for (let n = box; n && n !== document.body; n = n.parentElement) {
    if (getComputedStyle(n).display === 'none') n.style.setProperty('display', 'block', 'important');
    n.style.setProperty('visibility', 'visible', 'important');
  }
  return box.innerText || box.textContent || null;
}"""


async def fetch_notice(site=SITE):
    """Відкриває сторінку відключень у браузері (сайт захищений) і читає оголошення ДТЕК.

    None — сторінку прочитати не вдалося (тоді Сяйво лишає попередній стан).
    """
    from playwright.async_api import async_playwright

    url = f"https://www.dtek-{site}.com.ua/ua/shutdowns"
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        try:
            page = await browser.new_page(locale="uk-UA")
            await page.goto(url, wait_until="domcontentloaded", timeout=45000)
            text = ""
            for _ in range(20):  # захист сайту спершу показує перевірку — чекаємо справжню сторінку
                await page.wait_for_timeout(1500)
                text = await page.evaluate("document.body ? document.body.innerText : ''")
                if "графік" in text.lower() and len(text) > 2000:
                    break
            else:
                return None
            await page.wait_for_timeout(2500)  # оголошення з'являється вікном трохи пізніше
            # вікно «Шановні клієнти!» може бути приховане (показується пізніше) — знаходимо його в коді
            # сторінки, тимчасово робимо видимим і беремо текст із розбивкою на рядки
            box = await page.evaluate(NOTICE_JS)
            html = await page.content()
            print(f"[{site}] вікно «Шановні клієнти!»:", "знайдено" if box else "не знайдено",
                  "| у коді сторінки:", "є" if NOTICE_START in html.lower() else "немає")
            return parse_notice(box or text)
        finally:
            await browser.close()


def auth_token() -> str:
    """Ключ (якщо заданий) або «посвідчення» GitHub Actions для аудиторії selo-bot."""
    if INGEST_TOKEN:
        return INGEST_TOKEN
    url, tok = os.getenv("ACTIONS_ID_TOKEN_REQUEST_URL"), os.getenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN")
    if not url or not tok:
        raise RuntimeError("немає посвідчення GitHub (потрібен permissions: id-token: write)")
    req = urllib.request.Request(url + "&audience=selo-bot", headers={"Authorization": f"Bearer {tok}"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())["value"]


def post(payload: dict) -> None:
    req = urllib.request.Request(
        f"{WORKER_URL}/ingest",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {auth_token()}", "Content-Type": "application/json", "User-Agent": "selo-scraper/1.0"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        print("Worker:", r.status, r.read().decode()[:200])


async def main() -> None:
    try:
        today_slots, tomorrow_slots, entry, extra = await fetch_raw()
        if not today_slots:
            raise DtekClientError("Графік для цієї адреси не знайдено (перевірте CITY/STREET/HOUSE)")
        today = datetime.now(TZ).date()
        days = {today.isoformat(): to_intervals(today_slots)}
        if tomorrow_slots:
            days[(today + timedelta(days=1)).isoformat()] = to_intervals(tomorrow_slots)
        outage = None
        try:
            outage = to_outage(entry)
        except Exception as e:  # noqa: BLE001
            print("Не вдалося розібрати поточне відключення:", type(e).__name__, e, file=sys.stderr)
        group = getattr(entry, "primary_group", None) or ""
        payload = {"ok": True, "days": days, "outage": outage, "group": str(group)}
        groups = {}
        for g, (t_slots, tm_slots) in extra.items():
            try:
                gd = {today.isoformat(): to_intervals(t_slots)}
                if tm_slots:
                    gd[(today + timedelta(days=1)).isoformat()] = to_intervals(tm_slots)
                groups[g] = gd
            except Exception as e:  # noqa: BLE001
                print(f"Черга {g}: не вдалося розібрати графік:", type(e).__name__, e, file=sys.stderr)
        if EXTRA_GROUPS:
            payload["groups"] = groups
        print("Графік отримано, днів:", len(days), "| черга:", group, "| інші черги:", ", ".join(sorted(groups)) or "немає",
              "| відключення:", json.dumps(outage, ensure_ascii=False))
    except Exception as e:  # noqa: BLE001
        payload = {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
        print("Помилка:", payload["error"], file=sys.stderr)
    if payload.get("ok"):
        try:
            payload["notice"] = await asyncio.wait_for(fetch_notice(), timeout=90)
            print("Оголошення ДТЕК:", json.dumps(payload["notice"], ensure_ascii=False)[:300])
        except Exception as e:  # noqa: BLE001
            print("Оголошення ДТЕК не прочитано:", type(e).__name__, e, file=sys.stderr)
    post(payload)


if __name__ == "__main__":
    asyncio.run(main())
