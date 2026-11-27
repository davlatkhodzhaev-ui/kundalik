// Server for the Kundalik app: checks sign-in codes, stores marks, sends push notifications to parents.
// Several madrasas share one server: each madrasa's data lives in its own collections ("<id>:students" ...);
// the first madrasa (m0) keeps the original collection names.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const SITE = "https://davlatkhodzhaev-ui.github.io/kundalik/";

// ---------- storage ----------
async function get(coll: string, id: string) {
  const { data, error } = await sb.from("kv").select("data").eq("coll", coll).eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? data.data : null;
}
async function put(coll: string, id: string, data: unknown) {
  const { error } = await sb.from("kv").upsert({ coll, id, data, updated_at: new Date().toISOString() });
  if (error) throw error;
}
async function del(coll: string, id: string) {
  const { error } = await sb.from("kv").delete().eq("coll", coll).eq("id", id);
  if (error) throw error;
}
async function count(coll: string) {
  const { count: n, error } = await sb.from("kv").select("id", { count: "exact", head: true }).eq("coll", coll);
  if (error) throw error;
  return n || 0;
}
async function all(coll: string): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("kv").select("id,data").eq("coll", coll).order("id").range(from, from + 999);
    if (error) throw error;
    for (const r of data || []) out[r.id] = r.data;
    if (!data || data.length < 1000) break;
  }
  return out;
}

// ---------- keys, tokens ----------
let KEYS: any = null;
async function keys() {
  if (KEYS) return KEYS;
  let k = await get("sys", "keys");
  if (!k) {
    const v = webpush.generateVAPIDKeys();
    k = { pub: v.publicKey, priv: v.privateKey, hmac: crypto.randomUUID() + crypto.randomUUID(), admin: "2026", teacher: "1111" };
    await put("sys", "keys", k);
    k = (await get("sys", "keys")) || k;
  }
  KEYS = k;
  return k;
}
const enc = new TextEncoder();
const b64u = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function hmac(secret: string, msg: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
async function mkToken(p: Record<string, unknown>) {
  const k = await keys();
  const body = b64u(enc.encode(JSON.stringify({ ...p, exp: Date.now() + 180 * 864e5 })).buffer);
  return body + "." + (await hmac(k.hmac, body));
}
async function rdToken(t: unknown): Promise<any> {
  if (!t || typeof t !== "string") return null;
  const [body, sig] = t.split(".");
  if (!body || !sig) return null;
  const k = await keys();
  if ((await hmac(k.hmac, body)) !== sig) return null;
  try {
    const bin = atob(body.replace(/-/g, "+").replace(/_/g, "/"));
    const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

// ---------- madrasas ----------
const C = (m: string, coll: string) => (!m || m === "m0" ? coll : m + ":" + coll);
const MC: Record<string, { v: any; t: number }> = {};
async function mad(m: string) {
  const c = MC[m];
  if (c && Date.now() - c.t < 15e3) return c.v;
  const v = await get("madrasa", m);
  MC[m] = { v, t: Date.now() };
  return v;
}
async function putMad(m: string, v: any) { await put("madrasa", m, v); MC[m] = { v, t: Date.now() }; }
const digits = (n: number) => String(Math.floor(10 ** (n - 1) + Math.random() * 9 * 10 ** (n - 1)));
async function freeMcode() {
  const used = new Set(Object.values(await all("madrasa")).map((x: any) => x.code));
  for (let i = 0; i < 500; i++) { const c = digits(4); if (!used.has(c)) return c; }
  return digits(6);
}
// one-time move to the several-madrasa layout: the existing data becomes madrasa m0
let MIG = false;
async function migrate() {
  if (MIG) return;
  if (!(await get("sys", "mig1"))) {
    const k = await keys();
    if (!(await get("madrasa", "m0"))) await putMad("m0", { name: "Асосий мадраса", code: await freeMcode(), teacher: k.teacher || "1111", on: true, tv: 0, created: Date.now() });
    const students = await all("students");
    for (const sid in students) if (students[sid].code) await put("pcode", students[sid].code, { m: "m0", sid });
    if (!k.owner) { k.owner = digits(8); await put("sys", "keys", k); KEYS = k; }
    await put("sys", "mig1", { at: Date.now() });
  }
  MIG = true;
}
// who is calling and for which madrasa; null when the token is missing, expired, or the madrasa is switched off
async function ctx(p: any): Promise<any> {
  if (!p) return null;
  if (p.r === "ega") return { p, m: null, md: null };
  const m = p.m || "m0", md = await mad(m);
  if (!md || md.on === false) return null;
  if ((p.r === "ustoz" || p.r === "rahbar") && (p.tv || 0) !== (md.tv || 0)) return null;
  return { p, m, md };
}

// wrong-code limit: 4-digit codes are easy to guess, so each address gets 8 wrong tries per 15 minutes
async function tooMany(ip: string) {
  const f = (await get("fails", ip)) || { n: 0, ts: 0 };
  return Date.now() - f.ts < 15 * 60e3 && f.n >= 8;
}
async function failed(ip: string) {
  const f = (await get("fails", ip)) || { n: 0, ts: 0 };
  const fresh = Date.now() - f.ts < 15 * 60e3;
  await put("fails", ip, { n: fresh ? f.n + 1 : 1, ts: fresh ? f.ts : Date.now() });
}

// ---------- helpers ----------
const todayBishkek = () => new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 10);
const isDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isId = (s: unknown) => typeof s === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(s);
const rid = (p: string) => p + crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const str = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);
function pubStudent(st: any) { const { code: _c, parent: _p, ...r } = st; return r; }
async function freeCode(m: string, want?: string, except?: string) {
  if (want) {
    if (!/^\d{4,6}$/.test(want)) return null;
    const x = await get("pcode", want);
    return !x || (x.m === m && x.sid === except) ? want : null;
  }
  for (let i = 0; i < 50; i++) { const c = digits(6); if (!(await get("pcode", c))) return c; }
  return null;
}

async function state(p: any, m: string, md: any) {
  const [groups, students, marks, daymeta, settings] = await Promise.all([all(C(m, "groups")), all(C(m, "students")), all(C(m, "marks")), all(C(m, "days")), all(C(m, "settings"))]);
  if (!Object.keys(groups).length) {
    groups.gb = { name: "Ётоқда қоладиганлар", kind: "b", teachers: [] };
    groups.gd = { name: "Келиб кетадиганлар", kind: "d", teachers: [] };
    await put(C(m, "groups"), "gb", groups.gb); await put(C(m, "groups"), "gd", groups.gd);
  }
  const priv = p && (p.r === "rahbar" || p.r === "ustoz");
  const st: Record<string, any> = {};
  for (const id in students) st[id] = priv ? students[id] : pubStudent(students[id]);
  const days: Record<string, any> = {};
  for (const id in daymeta) days[id] = { ...daymeta[id], rows: {} };
  for (const mid in marks) {
    const m = marks[mid]; const s = students[m.sid]; if (!s) continue;
    const did = s.gid + "_" + m.date;
    if (!days[did]) days[did] = { gid: s.gid, date: m.date, topic: "", hw: "", rows: {} };
    const { sid: _s, date: _d, nk: _n, ...row } = m;
    days[did].rows[m.sid] = row;
  }
  return { groups, students: st, days, settings, madrasa: priv ? { name: md.name, code: md.code, teacher: md.teacher } : { name: md.name } };
}

async function notify(m: string, sid: string, row: any) {
  const st = await get(C(m, "students"), sid); if (!st) return;
  const k = await keys();
  const body = row.a === "a"
    ? `${st.name} бугун дарсга келмади.`
    : `${st.name} дарсга ${row.a === "l" ? "кечикиб келди" : "келди"}. Араб тили: ${row.ar === "y" ? "топширди" : "топширмади"}. Қуръон: ${row.qu === "y" ? "топширди" : "топширмади"}.`;
  const subs = await all(C(m, "push"));
  await Promise.all(Object.entries(subs).filter(([, s]) => (s.sids || []).includes(sid)).map(async ([id, s]) => {
    try {
      await webpush.sendNotification(s.sub, JSON.stringify({ title: "Кундалик", body, url: SITE }), {
        vapidDetails: { subject: SITE, publicKey: k.pub, privateKey: k.priv }, TTL: 6 * 3600,
      });
    } catch (e: any) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) await del(C(m, "push"), id);
    }
  }));
}

// ---------- actions ----------
async function handle(b: any, ip: string) {
  const a = b.a;
  if (a === "ping") return { ok: true };
  if (a === "push.key") return { key: (await keys()).pub };
  if (a === "login" || a === "addchild") {
    if (await tooMany(ip)) return { error: "wait" };
    const k = await keys(); const code = str(b.code, 12);
    const findMad = async (mc: string) => { const ms = await all("madrasa"); return Object.keys(ms).find((x) => ms[x].code === mc && ms[x].on !== false); };
    if (a === "login" && b.role === "ega") { if (k.owner && code === k.owner) return { token: await mkToken({ r: "ega" }), role: "ega" }; }
    else if (a === "login" && b.role === "ustoz") {
      const m = await findMad(str(b.mcode, 10));
      if (m) { const md = await mad(m); if (md.teacher === code) return { token: await mkToken({ r: "ustoz", m, tv: md.tv || 0 }), role: "ustoz" }; }
    }
    else if (a === "login" && b.role === "hujra") {
      const m = /^\d{4,6}$/.test(code) ? await findMad(code) : undefined;
      if (m) return { token: await mkToken({ r: "hujra", m }), role: "hujra" };
    }
    else if (/^\d{4,6}$/.test(code)) {
      const x = await get("pcode", code), md = x ? await mad(x.m) : null;
      if (x && md && md.on !== false && (await get(C(x.m, "students"), x.sid))) {
        const prev = a === "addchild" ? await rdToken(b.t) : null;
        if (prev && prev.r === "ota-ona" && (prev.m || "m0") !== x.m) return { error: "otherMadrasa" };
        const sids = Array.from(new Set([...(prev && prev.r === "ota-ona" ? prev.s : []), x.sid]));
        return { token: await mkToken({ r: "ota-ona", m: x.m, s: sids }), role: "ota-ona", sids };
      }
    }
    await failed(ip);
    return { error: "code" };
  }
  const c = await ctx(await rdToken(b.t));
  if (a === "state") {
    if (!c || !c.m) return { error: "auth" };
    return { ...(await state(c.p, c.m, c.md)), role: c.p.r, sids: c.p.s || [] };
  }
  if (!c) return { error: "auth" };
  const p = c.p, m: string = c.m;

  // ---------- owner: the list of madrasas ----------
  if (p.r === "ega") {
    if (a === "madrasa.list") {
      const ms = await all("madrasa");
      const list = await Promise.all(Object.entries(ms).map(async ([id, x]: [string, any]) => ({ id, name: x.name, code: x.code, teacher: x.teacher, on: x.on !== false, created: x.created || 0, n: await count(C(id, "students")) })));
      return { list: list.sort((x, y) => x.created - y.created) };
    }
    if (a === "madrasa.add") {
      const name = str(b.name, 80); if (!name) return { error: "bad" };
      const id = rid("m");
      await putMad(id, { name, code: await freeMcode(), teacher: digits(4), on: true, tv: 0, created: Date.now() });
      return { ok: true, id };
    }
    if (a === "madrasa.put" || a === "madrasa.enter") {
      if (!isId(b.mid)) return { error: "bad" };
      const md = await get("madrasa", b.mid); if (!md) return { error: "bad" };
      if (a === "madrasa.enter") return { token: await mkToken({ r: "ustoz", m: b.mid, tv: md.tv || 0 }), role: "ustoz" };
      if ("name" in b && str(b.name, 80)) md.name = str(b.name, 80);
      if ("on" in b) md.on = !!b.on;
      if (b.regen === "teacher") { md.teacher = digits(4); md.tv = (md.tv || 0) + 1; }
      if (b.regen === "code") md.code = await freeMcode();
      await putMad(b.mid, md);
      return { ok: true };
    }
    return { error: "auth" };
  }
  const staff = p.r === "rahbar" || p.r === "ustoz";

  if (a === "seen") {
    if (p.r !== "ota-ona" || !(p.s || []).includes(b.sid) || !isDate(b.date)) return { error: "auth" };
    const id = b.sid + "_" + b.date; const mk = await get(C(m, "marks"), id);
    if (mk) await put(C(m, "marks"), id, { ...mk, seen: true });
    return { ok: true };
  }
  if (a === "push.sub") {
    if (p.r !== "ota-ona" || !b.sub || typeof b.sub.endpoint !== "string") return { error: "auth" };
    const id = (await hmac("push", b.sub.endpoint)).slice(0, 40);
    await put(C(m, "push"), id, { sids: p.s, sub: b.sub });
    return { ok: true };
  }
  if (a === "push.unsub") {
    if (b.endpoint) await del(C(m, "push"), (await hmac("push", String(b.endpoint))).slice(0, 40));
    return { ok: true };
  }
  if (!staff) return { error: "auth" };

  if (a === "teacher.code") {
    const code = str(b.code, 10); if (!/^\d{4,8}$/.test(code)) return { error: "bad" };
    const md = { ...c.md, teacher: code, tv: (c.md.tv || 0) + 1 };
    await putMad(m, md);
    return { ok: true, token: await mkToken({ r: "ustoz", m, tv: md.tv }) };
  }

  if (a === "mark") {
    if (!isId(b.sid) || !isDate(b.date) || !b.patch) return { error: "bad" };
    const st = await get(C(m, "students"), b.sid); if (!st) return { error: "bad" };
    const id = b.sid + "_" + b.date;
    const r: any = { ...((await get(C(m, "marks"), id)) || {}), sid: b.sid, date: b.date };
    const ok: Record<string, string[]> = { a: ["p", "l", "a"], ar: ["y", "n"], qu: ["y", "n"] };
    for (const f of Object.keys(ok)) if (f in b.patch) { if (ok[f].includes(b.patch[f])) r[f] = b.patch[f]; else delete r[f]; }
    // how many lessons were handed in / not handed in that day, per subject
    for (const f of ["arn", "qun", "arx", "qux"]) if (f in b.patch) { const n = Math.floor(Number(b.patch[f])); if (n >= 1 && n <= 99) r[f] = n; else delete r[f]; }
    // lessons per book (book number -> count) and the sura the Quran lines came from
    if ("ab" in b.patch) { const o: Record<string, number> = {}; const src = b.patch.ab; if (src && typeof src === "object") for (const k of Object.keys(src).slice(0, 4)) { const bn = Math.floor(Number(k)), n = Math.floor(Number(src[k])); if (bn >= 1 && bn <= 99 && n >= 1 && n <= 99) o[String(bn)] = n; } if (Object.keys(o).length) r.ab = o; else delete r.ab; }
    // the lesson each book started from that day, and the line the Quran work started from
    if ("af" in b.patch) { const o: Record<string, number> = {}; const src = b.patch.af; if (src && typeof src === "object") for (const k of Object.keys(src).slice(0, 4)) { const bn = Math.floor(Number(k)), n = Math.floor(Number(src[k])); if (bn >= 1 && bn <= 99 && n >= 1 && n <= 999) o[String(bn)] = n; } if (Object.keys(o).length) r.af = o; else delete r.af; }
    if ("ql" in b.patch) { const n = b.patch.ql === null ? -1 : Math.floor(Number(b.patch.ql)); if (n >= 0 && n <= 999) r.ql = n; else delete r.ql; }
    if ("qs" in b.patch) { const n = Math.floor(Number(b.patch.qs)); if (n >= 1 && n <= 114) r.qs = n; else delete r.qs; }
    // exam step recorded on the day it happened
    if ("ex" in b.patch) { if (["start", "pass", "fail", "repass", "refail", "cancel"].includes(b.patch.ex)) r.ex = b.patch.ex; else delete r.ex; }
    if (r.a === "a") { r.ar = r.ar || "n"; r.qu = r.qu || "n"; }
    delete r.seen;
    const sig = r.a === "a" ? "a" : (r.a && r.ar && r.qu ? r.a + r.ar + r.qu : "");
    const send = !!sig && sig !== r.nk && b.date === todayBishkek();
    if (sig) r.nk = sig;
    await put(C(m, "marks"), id, r);
    if (send) await notify(m, b.sid, r);
    return { ok: true, notified: send };
  }
  if (a === "day.put") {
    if (!isId(b.gid) || !isDate(b.date) || !["topic", "hw"].includes(b.f)) return { error: "bad" };
    const id = b.gid + "_" + b.date;
    const d = (await get(C(m, "days"), id)) || { gid: b.gid, date: b.date, topic: "", hw: "" };
    d[b.f] = str(b.v, 300);
    await put(C(m, "days"), id, d);
    return { ok: true };
  }
  if (a === "student.put") {
    const students = await all(C(m, "students")); const d = b.data || {};
    const isNew = !b.sid; const sid = isNew ? rid("s") : b.sid;
    if (!isId(sid) || (!isNew && !students[sid])) return { error: "bad" };
    const st: any = { ...(students[sid] || {}) };
    if ("name" in d) st.name = str(d.name, 80);
    if ("gid" in d && isId(d.gid)) st.gid = d.gid;
    if ("parent" in d) st.parent = str(d.parent, 120);
    for (const f of ["book", "lesson", "book2", "lesson2"]) if (f in d) { const n = Math.floor(Number(d[f])); if (n >= 1 && n <= 999) st[f] = n; else delete st[f]; }
    // Quran: lines done inside the current sura, and which way the next sura lies
    if ("qline" in d) { const n = Math.floor(Number(d.qline)); if (n >= 1 && n <= 999) st.qline = n; else delete st.qline; }
    if ("qdir" in d) { if (d.qdir === "rev") st.qdir = "rev"; else delete st.qdir; }
    if ("exam" in d) { if (d.exam && ["prep", "pass", "fail", "repass", "refail"].includes(d.exam.s)) st.exam = { s: d.exam.s, b: Math.floor(Number(d.exam.b)) || 1 }; else delete st.exam; }
    if ("photo" in d) { if (typeof d.photo === "string" && d.photo.startsWith("data:image/") && d.photo.length < 60000) st.photo = d.photo; else delete st.photo; }
    const oldCode = st.code;
    if ("code" in d && str(d.code)) { const pc = await freeCode(m, str(d.code, 6), sid); if (!pc) return { error: "codeTaken" }; st.code = pc; }
    if (!st.code) { const pc = await freeCode(m, undefined, sid); if (!pc) return { error: "bad" }; st.code = pc; }
    if (!st.name || !st.gid) return { error: "bad" };
    await put(C(m, "students"), sid, st);
    if (st.code !== oldCode) { await put("pcode", st.code, { m, sid }); if (oldCode) { const x = await get("pcode", oldCode); if (x && x.m === m && x.sid === sid) await del("pcode", oldCode); } }
    return { ok: true, sid, student: st };
  }
  // Teachers and the admin have the same rights.
  if (a === "student.del") {
    if (isId(b.sid)) {
      const st = await get(C(m, "students"), b.sid);
      if (st && st.code) { const x = await get("pcode", st.code); if (x && x.m === m && x.sid === b.sid) await del("pcode", st.code); }
      await del(C(m, "students"), b.sid);
    }
    return { ok: true };
  }
  if (a === "group.put") {
    const gid = b.gid && isId(b.gid) ? b.gid : rid("g"); const d = b.data || {};
    await put(C(m, "groups"), gid, { name: str(d.name, 80), kind: ["b", "d"].includes(d.kind) ? d.kind : "", teachers: Array.isArray(d.teachers) ? d.teachers.map((x: unknown) => str(x, 60)).filter(Boolean).slice(0, 20) : [] });
    return { ok: true, gid };
  }
  if (a === "books.put") {
    const list = (Array.isArray(b.list) ? b.list : []).slice(0, 20).map((x: any) => ({ name: str(x && x.name, 80), lessons: Math.max(0, Math.floor(Number(x && x.lessons)) || 0) }));
    await put(C(m, "settings"), "books", { list });
    return { ok: true };
  }
  return { error: "unknown" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  try {
    const b = await req.json();
    const ip = (req.headers.get("x-forwarded-for") || "x").split(",")[0].trim().replace(/[^0-9a-fA-F.:]/g, "").slice(0, 45) || "x";
    await migrate();
    return json(await handle(b, ip));
  } catch (e) {
    console.error(e);
    return json({ error: "server" }, 500);
  }
});
