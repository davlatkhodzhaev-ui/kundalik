// Server for the Kundalik app: checks sign-in codes, stores marks, sends push notifications to parents.
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
async function freeCode(students: Record<string, any>, want?: string, except?: string) {
  const used = new Set(Object.entries(students).filter(([id]) => id !== except).map(([, s]) => s.code));
  if (want) return /^\d{4}$/.test(want) && !used.has(want) ? want : null;
  for (let i = 0; i < 500; i++) { const c = String(1000 + Math.floor(Math.random() * 9000)); if (!used.has(c)) return c; }
  return null;
}

async function state(p: any) {
  const [groups, students, marks, daymeta, settings] = await Promise.all([all("groups"), all("students"), all("marks"), all("days"), all("settings")]);
  if (!Object.keys(groups).length) {
    groups.gb = { name: "Ётоқда қоладиганлар", kind: "b", teachers: [] };
    groups.gd = { name: "Келиб кетадиганлар", kind: "d", teachers: [] };
    await put("groups", "gb", groups.gb); await put("groups", "gd", groups.gd);
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
  return { groups, students: st, days, settings };
}

async function notify(sid: string, row: any) {
  const st = await get("students", sid); if (!st) return;
  const k = await keys();
  const body = row.a === "a"
    ? `${st.name} бугун дарсга келмади.`
    : `${st.name} дарсга ${row.a === "l" ? "кечикиб келди" : "келди"}. Араб тили: ${row.ar === "y" ? "топширди" : "топширмади"}. Қуръон: ${row.qu === "y" ? "топширди" : "топширмади"}.`;
  const subs = await all("push");
  await Promise.all(Object.entries(subs).filter(([, s]) => (s.sids || []).includes(sid)).map(async ([id, s]) => {
    try {
      await webpush.sendNotification(s.sub, JSON.stringify({ title: "Кундалик", body, url: SITE }), {
        vapidDetails: { subject: SITE, publicKey: k.pub, privateKey: k.priv }, TTL: 6 * 3600,
      });
    } catch (e: any) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) await del("push", id);
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
    const k = await keys(); const code = str(b.code, 10);
    if (a === "login" && b.role === "rahbar") { if (code === k.admin) return { token: await mkToken({ r: "rahbar" }), role: "rahbar" }; }
    else if (a === "login" && b.role === "ustoz") { if (code === k.teacher) return { token: await mkToken({ r: "ustoz" }), role: "ustoz" }; }
    else {
      const students = await all("students");
      const sid = /^\d{4}$/.test(code) ? Object.keys(students).find((x) => students[x].code === code) : undefined;
      if (sid) {
        const prev = a === "addchild" ? await rdToken(b.t) : null;
        const sids = Array.from(new Set([...(prev && prev.r === "ota-ona" ? prev.s : []), sid]));
        return { token: await mkToken({ r: "ota-ona", s: sids }), role: "ota-ona", sids };
      }
    }
    await failed(ip);
    return { error: "code" };
  }
  const p = await rdToken(b.t);
  if (a === "state") return { ...(await state(p)), role: p ? p.r : "hujra", sids: p && p.s ? p.s : [] };
  if (!p) return { error: "auth" };
  const staff = p.r === "rahbar" || p.r === "ustoz";

  if (a === "seen") {
    if (p.r !== "ota-ona" || !(p.s || []).includes(b.sid) || !isDate(b.date)) return { error: "auth" };
    const id = b.sid + "_" + b.date; const m = await get("marks", id);
    if (m) await put("marks", id, { ...m, seen: true });
    return { ok: true };
  }
  if (a === "push.sub") {
    if (p.r !== "ota-ona" || !b.sub || typeof b.sub.endpoint !== "string") return { error: "auth" };
    const id = (await hmac("push", b.sub.endpoint)).slice(0, 40);
    await put("push", id, { sids: p.s, sub: b.sub });
    return { ok: true };
  }
  if (a === "push.unsub") {
    if (b.endpoint) await del("push", (await hmac("push", String(b.endpoint))).slice(0, 40));
    return { ok: true };
  }
  if (!staff) return { error: "auth" };

  if (a === "mark") {
    if (!isId(b.sid) || !isDate(b.date) || !b.patch) return { error: "bad" };
    const st = await get("students", b.sid); if (!st) return { error: "bad" };
    const id = b.sid + "_" + b.date;
    const r: any = { ...((await get("marks", id)) || {}), sid: b.sid, date: b.date };
    const ok: Record<string, string[]> = { a: ["p", "l", "a"], ar: ["y", "n"], qu: ["y", "n"] };
    for (const f of Object.keys(ok)) if (f in b.patch) { if (ok[f].includes(b.patch[f])) r[f] = b.patch[f]; else delete r[f]; }
    // how many lessons were handed in / not handed in that day, per subject
    for (const f of ["arn", "qun", "arx", "qux"]) if (f in b.patch) { const n = Math.floor(Number(b.patch[f])); if (n >= 1 && n <= 99) r[f] = n; else delete r[f]; }
    // lessons per book (book number -> count) and the sura the Quran lines came from
    if ("ab" in b.patch) { const o: Record<string, number> = {}; const src = b.patch.ab; if (src && typeof src === "object") for (const k of Object.keys(src).slice(0, 4)) { const bn = Math.floor(Number(k)), n = Math.floor(Number(src[k])); if (bn >= 1 && bn <= 99 && n >= 1 && n <= 99) o[String(bn)] = n; } if (Object.keys(o).length) r.ab = o; else delete r.ab; }
    if ("qs" in b.patch) { const n = Math.floor(Number(b.patch.qs)); if (n >= 1 && n <= 114) r.qs = n; else delete r.qs; }
    // exam step recorded on the day it happened
    if ("ex" in b.patch) { if (["start", "pass", "fail", "repass", "refail", "cancel"].includes(b.patch.ex)) r.ex = b.patch.ex; else delete r.ex; }
    if (r.a === "a") { r.ar = r.ar || "n"; r.qu = r.qu || "n"; }
    delete r.seen;
    const sig = r.a === "a" ? "a" : (r.a && r.ar && r.qu ? r.a + r.ar + r.qu : "");
    const send = !!sig && sig !== r.nk && b.date === todayBishkek();
    if (sig) r.nk = sig;
    await put("marks", id, r);
    if (send) await notify(b.sid, r);
    return { ok: true, notified: send };
  }
  if (a === "day.put") {
    if (!isId(b.gid) || !isDate(b.date) || !["topic", "hw"].includes(b.f)) return { error: "bad" };
    const id = b.gid + "_" + b.date;
    const d = (await get("days", id)) || { gid: b.gid, date: b.date, topic: "", hw: "" };
    d[b.f] = str(b.v, 300);
    await put("days", id, d);
    return { ok: true };
  }
  if (a === "student.put") {
    const students = await all("students"); const d = b.data || {};
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
    if ("code" in d && str(d.code)) { const c = await freeCode(students, str(d.code, 4), sid); if (!c) return { error: "codeTaken" }; st.code = c; }
    if (!st.code) { const c = await freeCode(students, undefined, sid); if (!c) return { error: "bad" }; st.code = c; }
    if (!st.name || !st.gid) return { error: "bad" };
    await put("students", sid, st);
    return { ok: true, sid, student: st };
  }
  // Teachers and the admin have the same rights.
  if (a === "student.del") { if (isId(b.sid)) await del("students", b.sid); return { ok: true }; }
  if (a === "group.put") {
    const gid = b.gid && isId(b.gid) ? b.gid : rid("g"); const d = b.data || {};
    await put("groups", gid, { name: str(d.name, 80), kind: ["b", "d"].includes(d.kind) ? d.kind : "", teachers: Array.isArray(d.teachers) ? d.teachers.map((x: unknown) => str(x, 60)).filter(Boolean).slice(0, 20) : [] });
    return { ok: true, gid };
  }
  if (a === "books.put") {
    const list = (Array.isArray(b.list) ? b.list : []).slice(0, 20).map((x: any) => ({ name: str(x && x.name, 80), lessons: Math.max(0, Math.floor(Number(x && x.lessons)) || 0) }));
    await put("settings", "books", { list });
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
    return json(await handle(b, ip));
  } catch (e) {
    console.error(e);
    return json({ error: "server" }, 500);
  }
});
