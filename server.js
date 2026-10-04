// Whiteboard calendar for Housecall Pro — Node server for Render
// Environment variables: HCP_API_KEY (required), VIEW_KEY (optional password for the TV link)
const http = require("http");
const TZ = "America/Chicago";
const env = process.env;

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/healthz") { res.writeHead(200); return res.end("ok"); }
  if (env.VIEW_KEY && url.searchParams.get("k") !== env.VIEW_KEY) {
    res.writeHead(403); return res.end("Not authorized");
  }
  if (url.pathname === "/api/debug") {
    try {
      const d = await hcp("/jobs?page=1&page_size=5", env);
      const job = (d.jobs || [])[0];
      const ap = job ? await hcp("/jobs/" + job.id + "/appointments", env) : null;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ sample_job: job, sample_appointments: ap }, null, 2));
    } catch (e) { res.writeHead(502); return res.end(String(e.message || e)); }
  }
  if (url.pathname === "/api/jobs") {
    try {
      const jobs = await loadJobs(env);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ jobs }));
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
}).listen(process.env.PORT || 3000, () => console.log("Schedule board running"));

const BASE = "https://api.housecallpro.com";
async function hcp(path, env, retry = true) {
  const r = await fetch(BASE + path, {
    headers: { Authorization: "Token " + env.HCP_API_KEY, Accept: "application/json" },
  });
  if (r.status === 429 && retry) { await new Promise(x => setTimeout(x, 1500)); return hcp(path, env, false); }
  if (!r.ok) throw new Error("Housecall Pro returned " + r.status + " for " + path.split("?")[0]);
  return r.json();
}

let empMap = null, empTime = 0;
async function employees(env) {
  if (empMap && Date.now() - empTime < 3600e3) return empMap;
  const m = {};
  try {
    for (let p = 1; p <= 10; p++) {
      const d = await hcp("/employees?page=" + p + "&page_size=100", env);
      for (const e of d.employees || []) m[e.id] = (e.first_name || "").trim();
      if (!d.total_pages || p >= d.total_pages) break;
    }
  } catch (e) { /* fall back to names on the job */ }
  empMap = m; empTime = Date.now();
  return m;
}

const apptCache = new Map(); // job id -> { t, ttl, list }
async function appointmentsFor(job, env, oldJob) {
  const hit = apptCache.get(job.id);
  const ttl = oldJob ? 6 * 3600e3 : 10 * 60e3;
  if (hit && Date.now() - hit.t < ttl) return hit.list;
  let list = [];
  try {
    const d = await hcp("/jobs/" + job.id + "/appointments", env);
    list = d.appointments || d.data || (Array.isArray(d) ? d : []);
  } catch (e) { if (hit) return hit.list; }
  apptCache.set(job.id, { t: Date.now(), list });
  return list;
}

function techNames(a, job, emp) {
  const raw = a.dispatched_employees || a.assigned_employees || a.employees || a.pros || [];
  let names = raw.map(e => typeof e === "string" ? emp[e] : (e.first_name || emp[e.id])).filter(Boolean);
  if (!names.length) {
    const ids = a.dispatched_employees_ids || a.dispatched_employee_ids || a.employee_ids || [];
    names = ids.map(i => emp[i]).filter(Boolean);
  }
  if (!names.length) names = (job.assigned_employees || []).map(e => e.first_name).filter(Boolean);
  return names.map(n => n.trim());
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

let cached = null, inflight = null;
async function loadJobs(env) {
  if (cached && Date.now() - cached.t < 4 * 60e3) return cached.jobs;
  if (!inflight) inflight = build(env).then(j => { cached = { t: Date.now(), jobs: j }; return j; })
    .finally(() => { inflight = null; });
  return inflight;
}

let oldJobs = null, oldJobsT = 0;
async function listJobs(env, min, max) {
  const jobs = [];
  for (let page = 1; page <= 200; page++) {
    const q = new URLSearchParams({
      page: String(page), page_size: "100",
      scheduled_start_min: min.toISOString(), scheduled_start_max: max.toISOString(),
    });
    const d = await hcp("/jobs?" + q, env);
    jobs.push(...(d.jobs || []));
    if (!d.total_pages || page >= d.total_pages) break;
  }
  return jobs;
}

async function build(env) {
  const now = new Date();
  const visFrom = new Date(now.getFullYear(), now.getMonth(), 0);
  const visTo = new Date(now.getFullYear(), now.getMonth() + 2, 2);
  const lookback = new Date(visFrom.getTime() - (Number(env.LOOKBACK_DAYS) || 730) * 864e5);
  // Older jobs change slowly: list them every 3 hours, keep only open or recently active ones
  if (!oldJobs || Date.now() - oldJobsT > 3 * 3600e3) {
    oldJobs = await listJobs(env, lookback, visFrom);
    oldJobsT = Date.now();
  }
  const recent = await listJobs(env, visFrom, visTo);
  const keepOld = oldJobs.filter(j => {
    const done = /complete|cancel/i.test(j.work_status || "");
    const upd = new Date(j.updated_at || 0);
    return !done || Date.now() - upd < 45 * 864e5;
  });
  const byId = new Map();
  for (const j of [...keepOld, ...recent]) byId.set(j.id, j);
  const jobs = [...byId.values()];

  const lists = await pool(jobs, 8, async job => {
    const js = job.schedule && job.schedule.scheduled_start;
    const old = js && new Date(js) < visFrom;
    return appointmentsFor(job, env, old);
  });

  const out = [];
  jobs.forEach((job, idx) => {
    if (/cancel/i.test(job.work_status || "")) return;
    const c = job.customer || {};
    const customer = [c.first_name, c.last_name].filter(Boolean).join(" ") || c.company || "";
    const base = { customer, desc: (job.description || "").slice(0, 60), status: job.work_status || "" };
    let appts = (lists[idx] || []).map(a => ({
      start: a.start_time || a.scheduled_start || (a.schedule && a.schedule.scheduled_start),
      end: a.end_time || a.scheduled_end || (a.schedule && a.schedule.scheduled_end) || null,
      techs: techNames(a, job, emp),
    })).filter(a => a.start);
    if (!appts.length && job.schedule && job.schedule.scheduled_start)
      appts = [{ start: job.schedule.scheduled_start, end: job.schedule.scheduled_end || null,
                 techs: (job.assigned_employees || []).map(e => (e.first_name || "").trim()) }];
    for (const a of appts) {
      const t = new Date(a.start);
      if (t >= visFrom && t <= visTo) out.push({ ...base, ...a });
    }
  });
  return out;
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Schedule Board</title>
<link href="https://fonts.googleapis.com/css2?family=Caveat:wght@500;700&family=Permanent+Marker&display=swap" rel="stylesheet">
<style>
:root{--board:#f6f8f8;--frame:#c9ced1;--grid:#aeb6ba;--ink:#2b3236}
*{box-sizing:border-box}
html,body{height:100%;margin:0;background:var(--frame);font-family:'Caveat','Comic Sans MS',cursive;color:var(--ink)}
body{padding:.8vw;display:flex}
.board{flex:1;background:var(--board);border-radius:.6vw;box-shadow:inset 0 0 2vw #dfe5e7;padding:1vw 1.2vw;display:flex;flex-direction:column;min-height:0}
.top{display:flex;align-items:center;gap:2vw;margin-bottom:.6vw}
.top h1{font:400 2vw 'Permanent Marker',cursive;margin:0}
.legend{display:flex;gap:1.4vw;margin-left:auto;font-size:1.7vw;font-weight:700}
.legend span{display:flex;align-items:center;gap:.4vw}
.legend i{width:1.3vw;height:1.3vw;border-radius:.3vw;display:inline-block}
.months{flex:1;display:flex;flex-direction:column;gap:.7vw;min-height:0}
.month{display:flex;flex-direction:column;min-height:0}
.month h2{font:400 1.5vw 'Permanent Marker',cursive;margin:0 0 .2vw;text-align:left}
.grid{flex:1;display:grid;grid-template-columns:repeat(4,minmax(0,1fr)) minmax(0,.7fr) minmax(0,.5fr) minmax(0,.5fr);border-top:.14vw solid var(--grid);border-left:.14vw solid var(--grid);min-height:0}
.dow{font-weight:700;font-size:.95vw;text-align:center;border-right:.14vw solid var(--grid);border-bottom:.14vw solid var(--grid);padding:.1vw}
.day{border-right:.14vw solid var(--grid);border-bottom:.14vw solid var(--grid);padding:.2vw .25vw;min-height:0;overflow:hidden;display:flex;flex-direction:column;gap:.18vw}
.day.out{background:#eef1f2}
.day.today{outline:.3vw solid #f2a900;outline-offset:-.3vw;background:#fffbea}
.num{font-weight:700;font-size:1vw;line-height:1}
.tb{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.15vw;align-content:start;min-height:0}
.blk{border-left:.35vw solid;border-radius:.2vw;padding:.05vw .22vw;font-size:.75vw;line-height:1.05;font-weight:500;min-width:0;align-self:start}
.blk b{display:block;font-size:.85vw}
.blk div{overflow:hidden;word-break:break-word;margin-top:.12vw}
.dylan{border-color:#1f5fd6;background:#dce8ff;color:#12388a}
.spencer{border-color:#d62d2d;background:#ffdede;color:#8c1212}
.dawson{border-color:#1f9a3d;background:#d9f5df;color:#0f5c23}
.brian{border-color:#111;background:#dcdcdc;color:#111}
.other{border-color:#8a6d00;background:#f3ecc8;color:#5b4800}
.err{position:fixed;bottom:.6vw;left:50%;transform:translateX(-50%);background:#ffe3e3;color:#8c1212;padding:.2vw 1vw;border-radius:.4vw;font-size:1.3vw;display:none}
</style></head><body>
<div class="board">
  <div class="top"><h1 id="title">Schedule</h1>
    <div class="legend">
      <span><i style="background:#1f5fd6"></i>Dylan</span><span><i style="background:#d62d2d"></i>Spencer</span>
      <span><i style="background:#1f9a3d"></i>Dawson</span><span><i style="background:#111"></i>Brian</span>
    </div></div>
  <div class="months" id="months"></div>
</div>
<div class="err" id="err"></div>
<script>
const TZ="${TZ}", TECHS=["dylan","spencer","dawson","brian"];
const dkey=d=>new Intl.DateTimeFormat("en-CA",{timeZone:TZ}).format(d);
const tfmt=d=>new Intl.DateTimeFormat("en-US",{timeZone:TZ,hour:"numeric",minute:"2-digit"}).format(d).replace(" AM","a").replace(" PM","p").replace(":00","");
let jobs=[];
function render(){
  const byDay={};
  for(const j of jobs){
    const s=new Date(j.start), k=dkey(s);
    const names=j.techs.length?j.techs:["Unassigned"];
    for(const n of names){
      const t=TECHS.includes(n.toLowerCase())?n.toLowerCase():"other";
      ((byDay[k]??={})[t==="other"?n:t]??=[]).push({s,j});
    }
  }
  const nowParts=dkey(new Date()).split("-").map(Number);
  const today=dkey(new Date());
  const wrap=document.getElementById("months");wrap.innerHTML="";
  for(let m=0;m<2;m++){
    const first=new Date(Date.UTC(nowParts[0],nowParts[1]-1+m,1));
    const y=first.getUTCFullYear(),mo=first.getUTCMonth();
    const startDow=(first.getUTCDay()+6)%7, dim=new Date(Date.UTC(y,mo+1,0)).getUTCDate();
    const el=document.createElement("div");el.className="month";
    el.innerHTML="<h2>"+first.toLocaleString("en-US",{month:"long",year:"numeric",timeZone:"UTC"})+"</h2>";
    const g=document.createElement("div");g.className="grid";
    "Mon Tue Wed Thu Fri Sat Sun".split(" ").forEach(d=>g.insertAdjacentHTML("beforeend","<div class='dow'>"+d+"</div>"));
    const cells=Math.ceil((startDow+dim)/7)*7;
    for(let i=0;i<cells;i++){
      const dn=i-startDow+1, inM=dn>=1&&dn<=dim;
      const dt=new Date(Date.UTC(y,mo,dn)), k=dt.toISOString().slice(0,10);
      let h="<div class='day"+(inM?"":" out")+(k===today?" today":"")+"'>";
      if(inM){
        h+="<div class='num'>"+dn+"</div>";
        const day=byDay[k]||{};
        let blocks='';
        const order=[...TECHS,...Object.keys(day).filter(x=>!TECHS.includes(x))];
        for(const t of order){
          const list=day[t];if(!list)continue;
          list.sort((a,b)=>a.s-b.s);
          const cls=TECHS.includes(t)?t:"other";
          const label=TECHS.includes(t)?t[0].toUpperCase()+t.slice(1):t;
          blocks+="<div class='blk "+cls+"' style='grid-column:"+(TECHS.indexOf(t)+1||"auto")+"'><b>"+label+"</b>"+list.map(x=>"<div>"+tfmt(x.s)+" "+esc(x.j.customer||x.j.desc)+"</div>").join("")+"</div>";
        }
        h+="<div class='tb'>"+blocks+"</div>";
      }
      g.insertAdjacentHTML("beforeend",h+"</div>");
    }
    g.style.gridTemplateRows="auto repeat("+(cells/7)+",minmax(0,1fr))";
    el.style.flex=(cells/7+0.5)+" 1 0";
    el.appendChild(g);wrap.appendChild(el);
  }
}
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
async function load(){
  try{
    const k=new URLSearchParams(location.search).get("k");
    const r=await fetch("/api/jobs"+(k?"?k="+encodeURIComponent(k):""));
    const d=await r.json();if(!r.ok)throw new Error(d.error||r.status);
    jobs=d.jobs;document.getElementById("err").style.display="none";
  }catch(e){const x=document.getElementById("err");x.textContent="Can't reach Housecall Pro — showing last update ("+e.message+")";x.style.display="block";}
  render();
}
load();setInterval(load,5*60*1000);
setInterval(()=>location.reload(),6*60*60*1000);
</script></body></html>`;
