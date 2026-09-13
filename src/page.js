// 三角色调度台单页：按角色渲染待办与可用动作；冲突日历、审计轨迹全员可见。
export function renderPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>古船帆索 · 多角色校准调度台</title>
<style>
  :root{--bg:#eef1ea;--panel:#fff;--ink:#1f241d;--muted:#6a7265;--line:#d3dccb;--accent:#4f6e40;--accent2:#34506b;--warn:#9b3b2c;--gold:#8a6a1f}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:"PingFang SC","Microsoft YaHei",Arial,sans-serif}
  header{padding:16px 26px;background:#fff;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:16px;flex-wrap:wrap}
  h1{margin:0;font-size:22px}
  h2{margin:0 0 10px;font-size:16px}
  header .spacer{flex:1}
  select,input,textarea,button{font:inherit}
  select,input,textarea{border:1px solid var(--line);border-radius:6px;padding:7px 9px;background:#fff}
  button{border:0;border-radius:6px;background:var(--accent);color:#fff;padding:8px 13px;font-weight:700;cursor:pointer}
  button.sec{background:#5d685f}button.blue{background:var(--accent2)}button.danger{background:var(--warn)}button.ghost{background:#e7ece2;color:var(--ink)}
  button:disabled{opacity:.45;cursor:not-allowed}
  main{display:grid;grid-template-columns:400px 1fr;gap:18px;padding:18px 26px}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:15px;margin-bottom:16px}
  label{display:block;margin:9px 0 4px;color:var(--muted);font-size:12px}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:8px}.row3{display:grid;grid-template-columns:1.2fr 1fr 1fr 1fr;gap:8px}
  .pill{display:inline-block;border-radius:999px;padding:2px 10px;font-size:12px;border:1px solid var(--line)}
  .s-待校准{background:#eef3e8}.s-待复核{background:#e8eff6}.s-已驳回{background:#f8e7e3}.s-复核通过{background:#f3eddd}.s-已交付{background:#e9e9e7}
  .todo{border:1px solid var(--line);border-radius:8px;padding:10px;margin-bottom:8px;display:flex;align-items:center;gap:10px;background:#fafcf8}
  .todo b{flex:1}
  .batch{border:1px solid var(--line);border-radius:10px;padding:13px;margin-bottom:12px;background:#fff}
  .batch h3{margin:0 0 6px;display:flex;gap:10px;align-items:center}
  table{width:100%;border-collapse:collapse;font-size:13px}td,th{border-bottom:1px solid var(--line);padding:5px 6px;text-align:left}
  .hist{max-height:120px;overflow:auto;font-size:12px;color:var(--muted);margin-top:8px;border-top:1px dashed var(--line);padding-top:6px}
  .hist div{margin:2px 0}
  .cal{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}
  .day{border:1px solid var(--line);border-radius:8px;min-height:118px;background:#fcfdfb;padding:6px;font-size:12px}
  .day .d{font-weight:700;margin-bottom:4px}
  .ev{border-radius:5px;padding:3px 5px;margin:3px 0;background:#e6efe0;border-left:3px solid var(--accent)}
  .ev.seed{background:#ece9df;border-left-color:var(--gold)}
  .ev.conflict{background:#f7e2dd;border-left-color:var(--warn)}
  .ev small{display:block;color:var(--muted)}
  #toast{position:fixed;right:20px;bottom:20px;display:none;max-width:420px;background:#26301f;color:#fff;padding:12px 16px;border-radius:8px;white-space:pre-wrap;z-index:99;font-size:13px}
  #toast.err{background:var(--warn)}
  .conflictbox{border:1px solid var(--warn);background:#fbf0ed;border-radius:8px;padding:10px;margin:8px 0;font-size:13px}
  .conflictbox .c{margin:5px 0}.alt{color:var(--accent2);cursor:pointer;text-decoration:underline}
  .audit{font-size:12px;max-height:260px;overflow:auto}.audit div{padding:4px 0;border-bottom:1px dashed var(--line)}
  .muted{color:var(--muted);font-size:12px}.lock{font-size:14px}
  .entryrow{border:1px dashed var(--line);border-radius:8px;padding:8px;margin:8px 0;background:#fafcf8}
  @media(max-width:980px){main{grid-template-columns:1fr}.cal{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>
<header>
  <h1>古船帆索 · 多角色校准调度台</h1>
  <span class="muted">校准员编批排期 → 复核员驳回/通过 → 交付员交付锁定</span>
  <div class="spacer"></div>
  <label style="display:inline;margin:0">当前角色
    <select id="who"></select>
  </label>
  <button class="ghost" id="reload">刷新</button>
</header>
<main>
  <div>
    <section class="panel" id="todoPanel"><h2>我的待办</h2><div id="todos" class="muted">请选择身份</div></section>
    <section class="panel" id="createPanel" hidden>
      <h2>编成校准批次</h2>
      <label>船</label><select id="shipSel"></select>
      <div id="entryRows"></div>
      <button class="ghost" id="addRow" type="button">+ 帆索条目</button>
      <label>排期起始（可选，默认现在）</label><input type="datetime-local" id="fromTime">
      <div style="margin-top:10px;display:flex;gap:8px">
        <button id="createBtn">建批并自动排期</button>
      </div>
    </section>
  </div>
  <div>
    <section class="panel">
      <h2>校准批次</h2>
      <div id="batches"></div>
    </section>
    <section class="panel">
      <h2>冲突日历（未来两周：人 / 桅区 / 工序占用）</h2>
      <div class="cal" id="calendar"></div>
    </section>
    <section class="panel">
      <h2>审计轨迹</h2>
      <div class="audit" id="audit"></div>
    </section>
  </div>
</main>
<div id="toast"></div>
<script>
const STATE = { text:"待校准", submitted:"待复核", rejected:"已驳回", approved:"复核通过", delivered:"已交付" };
let ov = null, me = localStorage.getItem("rigging.who") || "";
const $ = s => document.querySelector(s);

function toast(msg, isErr){
  const t = $("#toast"); t.textContent = msg; t.className = isErr ? "err" : ""; t.style.display = "block";
  clearTimeout(t._timer); t._timer = setTimeout(() => { t.style.display = "none"; }, isErr ? 9000 : 3500);
}
async function api(path, opts){
  opts = opts || {};
  opts.headers = Object.assign({ "Content-Type":"application/json", "X-User-Id": me }, opts.headers || {});
  if (opts.idemKey) opts.headers["Idempotency-Key"] = opts.idemKey;
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    let msg = (data.details && data.details.message) || data.error || ("HTTP " + res.status);
    if (data.details && data.details.conflicts) {
      msg += "\\n\\n冲突项：\\n" + data.details.conflicts.map(c =>
        "· " + c.shipCode + " " + c.zone + " " + c.position + "（" + c.op + "）" + c.start + " → " + c.reason).join("\\n");
      if (data.details.alternatives && data.details.alternatives.length) {
        msg += "\\n替代时段：\\n" + data.details.alternatives.map(a => "· " + a.entryId + " 可改至 " + a.start).join("\\n");
      }
    }
    const err = new Error(msg); err.payload = data; throw err;
  }
  return data;
}
function esc(s){ return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
function userName(id){ const u = ov.users.find(x => x.id === id); return u ? u.name : id; }
function roleName(id){ const u = ov.users.find(x => x.id === id); return u ? u.roleName : ""; }

async function load(){
  ov = await (await fetch("/api/overview" + (me ? "?userId=" + encodeURIComponent(me) : ""))).json();
  if (!me || !ov.users.some(u => u.id === me)) me = ov.users[0].id;
  localStorage.setItem("rigging.who", me);
  render();
}

function render(){
  const meUser = ov.users.find(u => u.id === me);
  $("#who").innerHTML = ov.users.map(u =>
    '<option value="' + u.id + '"' + (u.id === me ? " selected" : "") + ">" + esc(u.name) + " · " + u.roleName + "</option>").join("");
  renderTodos(meUser);
  $("#createPanel").hidden = meUser.role !== "calibrator";
  if (meUser.role === "calibrator") renderCreateForm();
  renderBatches(meUser);
  renderCalendar();
  renderAudit();
}

function renderTodos(meUser){
  const mine = ov.todos.filter(b => true);
  if (!mine.length) { $("#todos").innerHTML = '<div class="muted">暂无待办</div>'; return; }
  $("#todos").innerHTML = mine.map(b =>
    '<div class="todo"><b>' + b.id + " · " + esc(b.shipCode) + '</b><span class="pill s-' + b.status + '">' + b.status +
    '</span><a class="muted" href="#' + b.id + '" style="font-size:12px">查看</a></div>').join("");
}

function renderCreateForm(){
  $("#shipSel").innerHTML = ov.ships.map(s => '<option value="' + s.id + '">' + esc(s.code + " " + s.shipType + " " + s.scale) + "</option>").join("");
  if (!$("#entryRows").children.length) addEntryRow();
}
function addEntryRow(){
  const ship = ov.ships.find(s => s.id === $("#shipSel").value) || ov.ships[0];
  const calibrators = ov.users.filter(u => u.role === "calibrator");
  const div = document.createElement("div");
  div.className = "entryrow";
  div.innerHTML =
    '<div class="row3">' +
    "<div><label>索具位置</label><input class=\\'p-pos\\' placeholder=\\'前桅侧支索\\'></div>" +
    "<div><label>桅区</label><select class=\\'p-zone\\'>" + ship.zones.map(z => "<option>" + esc(z) + "</option>").join("") + "</select></div>" +
    "<div><label>工序</label><select class=\\'p-op\\'>" + ov.operations.map(o => "<option>" + esc(o.key) + "</option>").join("") + "</select></div>" +
    "<div><label>负责人</label><select class=\\'p-user\\'>" + calibrators.map(u => '<option value="' + u.id + '">' + esc(u.name) + "</option>").join("") + "</select></div>" +
    "</div>";
  $("#entryRows").appendChild(div);
}
$("#addRow").onclick = addEntryRow;
$("#shipSel") && ($("#shipSel").onchange = () => { $("#entryRows").innerHTML = ""; addEntryRow(); });

$("#createBtn").onclick = async () => {
  if ($("#createBtn").disabled) return; // 防重复提交
  const shipId = $("#shipSel").value;
  const entries = [...document.querySelectorAll("#entryRows .entryrow")].map(r => ({
    position: r.querySelector(".p-pos").value.trim(),
    zone: r.querySelector(".p-zone").value,
    op: r.querySelector(".p-op").value,
    userId: r.querySelector(".p-user").value
  }));
  if (!entries.every(e => e.position)) return toast("每条帆索都要填写位置", true);
  const from = $("#fromTime").value || undefined;
  $("#createBtn").disabled = true;
  try {
    const key = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
    const created = await api("/api/batches", { method:"POST", idemKey:key,
      body: JSON.stringify({ shipId, entries }) });
    const batch = created.batch || created;
    await api("/api/batches/" + batch.id + "/auto-schedule", { method:"POST", idemKey:key + "-auto",
      body: JSON.stringify({ from, version: batch.version }) });
    toast("批次 " + batch.id + " 已编成并排出时段");
    $("#entryRows").innerHTML = ""; addEntryRow();
    await load();
    location.hash = batch.id;
  } catch (e) { toast(e.message, true); }
  finally { $("#createBtn").disabled = false; }
};

function renderBatches(meUser){
  if (!ov.batches.length) { $("#batches").innerHTML = '<div class="muted">还没有批次</div>'; return; }
  $("#batches").innerHTML = ov.batches.map(b => batchCard(b, meUser)).join("");
  bindBatchEvents(meUser);
}

function batchCard(b, meUser){
  const locked = b.status === STATE.delivered;
  const rows = b.entries.map(e => "<tr><td>" + esc(e.position) + "</td><td>" + esc(e.zone) + "</td><td>" + esc(e.op) +
    "</td><td>" + esc(userName(e.userId)) + "</td><td>" +
    (b.status === STATE.delivered || b.status === STATE.submitted || b.status === STATE.approved
      ? esc(e.start || "未排") + " ~ " + esc(e.end || "")
      : '<input type="datetime-local" data-e="' + e.id + '" data-k="start" value="' + esc(e.start || "") + '"> ~ ' +
        '<input type="datetime-local" data-e="' + e.id + '" data-k="end" value="' + esc(e.end || "") + '">') +
    "</td></tr>").join("");
  const acts = [];
  if (locked) acts.push('<span class="lock">🔒 已交付锁定：禁止新增、改期、撤回</span>');
  if (!locked) {
    if (meUser.role === "calibrator" && b.ownerId === meUser.id &&
        (b.status === STATE.text || b.status === STATE.rejected)) {
      acts.push('<button class="sec" data-act="auto" data-b="' + b.id + '" data-v="' + b.version + '">自动排期</button>');
      if (b.entries.some(e => e.start)) acts.push('<button data-act="resched" data-b="' + b.id + '" data-v="' + b.version + '">整批改期</button>');
      acts.push('<button class="blue" data-act="submit" data-b="' + b.id + '" data-v="' + b.version + '">提交复核</button>');
    }
    if (meUser.role === "calibrator" && b.ownerId === meUser.id && b.status === STATE.submitted) {
      acts.push('<button class="ghost" data-act="withdraw" data-b="' + b.id + '" data-v="' + b.version + '">撤回复核</button>');
    }
    if (meUser.role === "reviewer" && b.status === STATE.submitted) {
      acts.push('<button data-act="approve" data-b="' + b.id + '" data-v="' + b.version + '">复核通过</button>');
      acts.push('<button class="danger" data-act="reject" data-b="' + b.id + '" data-v="' + b.version + '">驳回</button>');
    }
    if (meUser.role === "deliverer" && b.status === STATE.approved) {
      acts.push('<button class="blue" data-act="deliver" data-b="' + b.id + '" data-v="' + b.version + '">确认交付</button>');
    }
  }
  const hist = b.history.slice().reverse().map(h =>
    "<div>" + esc(h.at) + " · " + esc(h.actorName || h.actorId) + " · " + esc(h.note || h.action) + "</div>").join("");
  return '<article class="batch" id="' + b.id + '"><h3>' + b.id + " · " + esc(b.shipCode) +
    '<span class="pill s-' + b.status + '">' + b.status + '</span>' +
    '<span class="muted">v' + b.version + " · 负责 " + esc(b.ownerName) + "</span></h3>" +
    '<div id="cf-' + b.id + '"></div>' +
    "<table><tr><th>索具</th><th>桅区</th><th>工序</th><th>负责人</th><th>时段</th></tr>" + rows + "</table>" +
    '<div style="margin-top:9px;display:flex;gap:8px;flex-wrap:wrap">' + acts.join("") + "</div>" +
    '<div class="hist">' + hist + "</div></article>";
}

function bindBatchEvents(meUser){
  document.querySelectorAll("[data-act]").forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.b, act = btn.dataset.act, ver = Number(btn.dataset.v);
      try {
        if (act === "auto") {
          await api("/api/batches/" + id + "/auto-schedule", { method:"POST", idemKey:"auto-" + id + "-" + Date.now(), body: JSON.stringify({ version: ver }) });
        } else if (act === "resched") {
          const schedules = [...document.querySelectorAll('#' + id + ' input[data-e]')].reduce((acc, inp) => {
            const eid = inp.dataset.e, k = inp.dataset.k;
            let row = acc.find(x => x.entryId === eid);
            if (!row) { row = { entryId:eid }; acc.push(row); }
            row[k] = inp.value;
            return acc;
          }, []);
          if (!schedules.every(s => s.start && s.end)) return toast("请把每条工序的起止时间填完整", true);
          try {
            await api("/api/batches/" + id + "/reschedule", { method:"POST",
              body: JSON.stringify({ version: ver, schedules }) });
            toast("整批改期成功");
          } catch (e) { showConflicts(id, e.payload); throw e; }
        } else if (act === "submit") {
          await api("/api/batches/" + id + "/submit", { method:"POST", body: JSON.stringify({ version: ver }) });
        } else if (act === "withdraw") {
          await api("/api/batches/" + id + "/withdraw", { method:"POST", body: JSON.stringify({ version: ver }) });
        } else if (act === "approve") {
          const note = prompt("复核通过备注（可留空）") || "";
          await api("/api/batches/" + id + "/review", { method:"POST", body: JSON.stringify({ decision:"approve", version:ver, note }) });
        } else if (act === "reject") {
          const note = prompt("驳回原因（必填，批次将回到校准，原记录保留）");
          if (!note) return;
          await api("/api/batches/" + id + "/review", { method:"POST", body: JSON.stringify({ decision:"reject", version:ver, note }) });
        } else if (act === "deliver") {
          await api("/api/batches/" + id + "/deliver", { method:"POST", body: JSON.stringify({ version: ver }) });
        }
        await load();
      } catch (e) { toast(e.message, true); }
    };
  });
}

// 改期失败：在批次卡片内列出冲突项与替代时段（点击替代时段自动回填输入框）；数据未做任何改动。
function showConflicts(batchId, payload){
  const d = (payload && payload.details) || {};
  const box = $("#cf-" + batchId);
  if (!box || !d.conflicts) return;
  const altOf = eid => (d.alternatives || []).find(a => a.entryId === eid);
  box.innerHTML = '<div class="conflictbox"><b>整批改期被拒绝，已全部回滚（v' + esc(d.version) + "，无任何改动）</b>" +
    d.conflicts.map(c => {
      const a = altOf(c.entryId);
      return '<div class="c">⛔ ' + esc(c.zone + " " + c.position + "（" + c.op + "）") + " " + esc(c.start) + "：" + esc(c.reason) +
        (a ? ' <span class="alt" data-fill="' + c.entryId + '" data-start="' + esc(a.start) + '" data-end="' + esc(a.end) + '">采用替代时段 ' + esc(a.start) + "</span>" : "");
    }).join("") + "</div>";
  box.querySelectorAll("[data-fill]").forEach(s => s.onclick = () => {
    document.querySelectorAll('#' + batchId + ' input[data-e="' + s.dataset.fill + '"]').forEach(inp => {
      inp.value = s.dataset[inp.dataset.k];
    });
    toast("已回填替代时段，可再次提交整批改期");
  });
}

function renderCalendar(){
  const days = [];
  const today = new Date(); today.setHours(0,0,0,0);
  for (let i = 0; i < 14; i++) days.push(new Date(today.getTime() + i * 86400000));
  const evs = ov.calendar.map(sc => {
    const s = new Date(sc.start.replace(" ", "T"));
    return { sc, day: s.toDateString(), start: sc.start.slice(11,16), end: sc.end.slice(11,16), _s:s };
  });
  // 同日同时段撞人或撞桅区 → 标红（正常新建会被拦截，种子数据/既有工单用于直观展示）。
  evs.forEach(e => { e.conflict = evs.some(o => o !== e && o.day === e.day &&
    ((o.sc.userId && o.sc.userId === e.sc.userId) || (o.sc.zone && o.sc.zone === e.sc.zone)) &&
    o._s < new Date(e.sc.end.replace(" ","T")) && e._s < new Date(o.sc.end.replace(" ","T"))); });
  $("#calendar").innerHTML = days.map(d => {
    const list = evs.filter(e => e.day === d.toDateString());
    return '<div class="day"><div class="d">' + (d.getMonth()+1) + "/" + d.getDate() + " 周" + "日一二三四五六"[d.getDay()] + "</div>" +
      list.map(e => '<div class="ev ' + (e.sc.batchId === "B-SEED" || e.sc.batchId === "B-ZONE-FIX" ? "seed" : "") + (e.conflict ? " conflict" : "") + '">' +
        esc(e.sc.batchId + " " + e.sc.op) + "<small>" + e.start + "-" + e.end + " · " + esc(e.sc.zone) +
        (e.sc.userId ? " · " + esc(userName(e.sc.userId)) : "") + (e.conflict ? " · ⚠冲突" : "") + "</small></div>").join("") +
      "</div>";
  }).join("");
}

function renderAudit(){
  $("#audit").innerHTML = ov.audit.map(a =>
    "<div>" + esc(a.at) + " · <b>" + esc(userName(a.actorId)) + "</b>（" + roleName(a.actorId) + "）· " + esc(a.action) +
    (a.batchId ? " · " + a.batchId : "") + " · " + esc(JSON.stringify(a.detail)) + "</div>").join("") ||
    '<div class="muted">暂无审计</div>';
}

$("#who").onchange = async () => { me = $("#who").value; localStorage.setItem("rigging.who", me); await load(); };
$("#reload").onclick = load;
load();
</script>
</body>
</html>`;
}
