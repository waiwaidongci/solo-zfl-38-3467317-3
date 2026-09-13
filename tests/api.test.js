import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, createScheduledSubmitted, USERS } from "./helpers.js";

let h;
before(async () => { h = await makeHarness(); });
after(async () => { await h.stop(); });

// ---------- 越权：三角色只能执行本岗动作 ----------
test("越权：复核员不能建批（403），未登录 401", async () => {
  const noLogin = await h.call("POST", "/api/batches", {
    shipId: "S-1", entries: [{ position: "x", zone: "前桅", op: "勘验", userId: USERS.zhou }]
  });
  assert.equal(noLogin.status, 401);

  const reviewer = await h.call("POST", "/api/batches", {
    shipId: "S-1", entries: [{ position: "x", zone: "前桅", op: "勘验", userId: USERS.zhou }]
  }, { userId: USERS.shen });
  assert.equal(reviewer.status, 403);
  assert.equal(reviewer.json.error, "forbidden");
  assert.match(reviewer.json.details.message, /复核员无权/);
});

test("越权：校准员不能复核/交付，交付员不能驳回", async () => {
  const flow = await createScheduledSubmitted(h, { from: "2026-09-19T08:00" });
  const id = flow.final.id;
  const v = flow.final.version;

  let r = await h.call("POST", `/api/batches/${id}/review`, { decision: "approve", version: v }, { userId: USERS.zhou });
  assert.equal(r.status, 403);
  r = await h.call("POST", `/api/batches/${id}/deliver`, { version: v }, { userId: USERS.zhou });
  assert.equal(r.status, 403);
  r = await h.call("POST", `/api/batches/${id}/review`, { decision: "reject", note: "x", version: v }, { userId: USERS.zheng });
  assert.equal(r.status, 403);

  // 非负责校准员不能动别人的批次。
  r = await h.call("POST", `/api/batches/${id}/withdraw`, {}, { userId: USERS.lin });
  assert.equal(r.status, 403);
});

// ---------- 幂等：重复提交不得生成重复记录 ----------
test("幂等：同一 Idempotency-Key 重复提交只产生一条批次", async () => {
  const payload = {
    shipId: "S-2",
    entries: [{ position: "后桅稳索", zone: "后桅", op: "勘验", userId: USERS.lin }]
  };
  const first = await h.call("POST", "/api/batches", payload, { userId: USERS.lin, idem: "idem-xyz-1" });
  const again = await h.call("POST", "/api/batches", payload, { userId: USERS.lin, idem: "idem-xyz-1" });
  assert.equal(first.status, 201);
  assert.equal(again.status, 201);
  assert.equal(first.json.batch.id, again.json.batch.id);
  assert.equal(again.json.replayed, true);
  const ov = await h.overview();
  const sameCode = ov.batches.filter(b => b.id === first.json.batch.id);
  assert.equal(sameCode.length, 1);
});

// ---------- 排期三约束 ----------
test("排期：自动排期遵守工序依赖、工作时段并避开种子占用", async () => {
  const created = await h.call("POST", "/api/batches", {
    shipId: "S-2",
    entries: [
      { position: "前桅支索", zone: "前桅", op: "勘验", userId: USERS.zhou },
      { position: "前桅支索", zone: "前桅", op: "初调", userId: USERS.zhou }
    ]
  }, { userId: USERS.zhou, idem: "sched-" + Math.random() });
  const id = created.json.batch.id;
  const auto = await h.call("POST", `/api/batches/${id}/auto-schedule`,
    { from: "2026-09-14T08:00", version: created.json.batch.version }, { userId: USERS.zhou });
  assert.equal(auto.status, 200);
  const [kan, chu] = auto.json.batch.entries;
  // 09-14 09:00-10:30 周宁有船坞例会 → 勘验 60 分钟排到 10:30；初调必须晚于勘验结束。
  assert.equal(kan.start, "2026-09-14T10:30");
  assert.equal(kan.end, "2026-09-14T11:30");
  assert.ok(chu.start >= kan.end, "初调不得早于勘验结束");
  // 09-15 09:00 前桅/周宁被种子工单占用，初调 90 分钟只能排在 10:30 之后（恰好 12:00 收工）。
  assert.equal(chu.start, "2026-09-15T10:30");
  assert.equal(chu.end, "2026-09-15T12:00");
});

test("桅区按船判定：跨船同名桅区可同时作业，同船同区/全坞封修才报桅区占用", async () => {
  // A：S-1 前桅 · 周宁，改到空闲日 2026-09-18 09:00-10:00（先建批再合法改期落位）。
  const a = await h.call("POST", "/api/batches", {
    shipId: "S-1",
    entries: [{ position: "前桅支索", zone: "前桅", op: "勘验", userId: USERS.zhou }]
  }, { userId: USERS.zhou, idem: "zone-a-" + Math.random() });
  const aId = a.json.batch.id, ae = a.json.batch.entries[0].id;
  const aPut = await h.call("POST", `/api/batches/${aId}/reschedule`, {
    version: 1, schedules: [{ entryId: ae, start: "2026-09-18T09:00", end: "2026-09-18T10:00" }]
  }, { userId: USERS.zhou });
  assert.equal(aPut.status, 200);

  // B：S-2 前桅 · 林锚（不同船不同人），同一时刻 → 必须成功。
  const b = await h.call("POST", "/api/batches", {
    shipId: "S-2",
    entries: [{ position: "前桅支索", zone: "前桅", op: "勘验", userId: USERS.lin }]
  }, { userId: USERS.lin, idem: "zone-b-" + Math.random() });
  const bId = b.json.batch.id, be = b.json.batch.entries[0].id;
  const bPut = await h.call("POST", `/api/batches/${bId}/reschedule`, {
    version: 1, schedules: [{ entryId: be, start: "2026-09-18T09:00", end: "2026-09-18T10:00" }]
  }, { userId: USERS.lin });
  assert.equal(bPut.status, 200, "跨船同名桅区不得互相占用");
  const ov = await h.overview();
  const atSameTime = ov.calendar.filter(sc => sc.start === "2026-09-18T09:00");
  assert.equal(atSameTime.length, 2, "两条排期同时存在于日历");
  assert.deepEqual(new Set(atSameTime.map(sc => sc.shipId)), new Set(["S-1", "S-2"]));

  // C：同船 S-1 前桅（换林锚也没用，因 A 已占 S-1 前桅）→ zone_occupied。
  const c = await h.call("POST", "/api/batches", {
    shipId: "S-1",
    entries: [{ position: "前桅稳索", zone: "前桅", op: "勘验", userId: USERS.lin }]
  }, { userId: USERS.zhou, idem: "zone-c-" + Math.random() });
  const cId = c.json.batch.id, ce = c.json.batch.entries[0].id;
  const cPut = await h.call("POST", `/api/batches/${cId}/reschedule`, {
    version: 1, schedules: [{ entryId: ce, start: "2026-09-18T09:00", end: "2026-09-18T10:00" }]
  }, { userId: USERS.zhou });
  assert.equal(cPut.status, 409);
  assert.ok(cPut.json.details.conflicts.some(x => x.type === "zone_occupied"), "同船同区必须冲突");

  // D：全坞封修（种子 B-ZONE-FIX，shipId=null，09-16 下午 中桅）对任意船生效。
  const d = await h.call("POST", "/api/batches", {
    shipId: "S-1",
    entries: [{ position: "中桅升降索", zone: "中桅", op: "勘验", userId: USERS.lin }]
  }, { userId: USERS.zhou, idem: "zone-d-" + Math.random() });
  const dId = d.json.batch.id, de = d.json.batch.entries[0].id;
  const dPut = await h.call("POST", `/api/batches/${dId}/reschedule`, {
    version: 1, schedules: [{ entryId: de, start: "2026-09-16T14:00", end: "2026-09-16T15:00" }]
  }, { userId: USERS.zhou });
  assert.equal(dPut.status, 409);
  assert.ok(dPut.json.details.conflicts.some(x => x.type === "zone_occupied"), "全坞封修应挡住所有船");
});

test("整批回滚：改期失败后原排期、版本、状态完全不变", async () => {
  const flow = await createScheduledSubmitted(h, { from: "2026-09-22T08:00" });
  await h.call("POST", `/api/batches/${flow.final.id}/withdraw`,
    { version: flow.final.version }, { userId: USERS.zhou });
  let ov = await h.overview();
  const before = ov.batches.find(x => x.id === flow.final.id);
  const beforeJson = JSON.stringify(before.entries.map(e => [e.id, e.start, e.end]));
  const beforeVersion = before.version;

  const r = await h.call("POST", `/api/batches/${before.id}/reschedule`, {
    version: before.version,
    schedules: before.entries.map((e, i) => i === 0
      ? { entryId: e.id, start: "2026-09-15T09:00", end: "2026-09-15T10:00" }
      : { entryId: e.id, start: e.start, end: e.end })
  }, { userId: USERS.zhou });
  assert.equal(r.status, 409);

  ov = await h.overview();
  const after = ov.batches.find(x => x.id === before.id);
  assert.equal(after.version, beforeVersion, "版本不得自增");
  assert.equal(JSON.stringify(after.entries.map(e => [e.id, e.start, e.end])), beforeJson, "原排期不变");
  const scheduleCount = ov.calendar.filter(sc => sc.batchId === before.id).length;
  assert.equal(scheduleCount, before.entries.length, "schedule 表不得有半批次残留");
});

test("过期版本：拿着旧 version 改期直接拒绝", async () => {
  const created = await h.call("POST", "/api/batches", {
    shipId: "S-2",
    entries: [{ position: "后桅稳索", zone: "后桅", op: "勘验", userId: USERS.lin }]
  }, { userId: USERS.lin, idem: "ver-" + Math.random() });
  const id = created.json.batch.id;
  await h.call("POST", `/api/batches/${id}/auto-schedule`,
    { from: "2026-09-17T13:30", version: created.json.batch.version }, { userId: USERS.lin });
  const ov = await h.overview();
  const current = ov.batches.find(b => b.id === id).version;
  const r = await h.call("POST", `/api/batches/${id}/reschedule`, {
    version: current - 1,
    schedules: [{ entryId: created.json.batch.entries[0].id, start: "2026-09-17T15:00", end: "2026-09-17T16:00" }]
  }, { userId: USERS.lin });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "version_conflict");
});

test("乐观锁并发：同版本两个改期并发，只允许一个成功，另一个 version_conflict", async () => {
  const created = await h.call("POST", "/api/batches", {
    shipId: "S-2",
    entries: [{ position: "后桅稳索", zone: "后桅", op: "勘验", userId: USERS.lin }]
  }, { userId: USERS.lin, idem: "conc-" + Math.random() });
  const id = created.json.batch.id;
  const eid = created.json.batch.entries[0].id;
  await h.call("POST", `/api/batches/${id}/auto-schedule`,
    { from: "2026-09-20T08:00", version: created.json.batch.version }, { userId: USERS.lin });
  const ov = await h.overview();
  const v = ov.batches.find(b => b.id === id).version;
  const body = { version: v, schedules: [{ entryId: eid, start: "2026-09-20T11:00", end: "2026-09-20T12:00" }] };
  const [a, b] = await Promise.all([
    h.call("POST", `/api/batches/${id}/reschedule`, body, { userId: USERS.lin }),
    h.call("POST", `/api/batches/${id}/reschedule`, body, { userId: USERS.lin })
  ]);
  const codes = [a.status, b.status].sort().join(",");
  assert.equal(codes, "200,409");
  assert.ok(a.status === 409 ? a.json.error === "version_conflict" : b.json.error === "version_conflict");
});

// ---------- 本次缺陷回归：部分条目 / 重复条目 / 缺版本 / 跨动作幂等键 ----------
test("改期全量覆盖：漏传部分索具 → 400，概览与日历均保留原排期不丢记录", async () => {
  const flow = await createScheduledSubmitted(h, { from: "2026-09-26T08:00" });
  await h.call("POST", `/api/batches/${flow.final.id}/withdraw`,
    { version: flow.final.version }, { userId: USERS.zhou });
  let ov = await h.overview();
  const b = ov.batches.find(x => x.id === flow.final.id);
  assert.equal(b.entries.length, 2);
  const beforeSlots = b.entries.map(e => [e.start, e.end]);

  // 只传第一条，漏了第二条 → 拒绝。
  const partial = await h.call("POST", `/api/batches/${b.id}/reschedule`, {
    version: b.version,
    schedules: [{ entryId: b.entries[0].id, start: "2026-09-26T15:00", end: "2026-09-26T16:00" }]
  }, { userId: USERS.zhou });
  assert.equal(partial.status, 400);
  assert.equal(partial.json.error, "schedules_must_cover_all_entries");
  assert.deepEqual(partial.json.details.missing, [b.entries[1].id]);

  // 传不存在的条目 → 同样拒绝。
  const unknown = await h.call("POST", `/api/batches/${b.id}/reschedule`, {
    version: b.version,
    schedules: [
      ...b.entries.map(e => ({ entryId: e.id, start: e.start, end: e.end })),
      { entryId: "E-NOPE", start: "2026-09-26T15:00", end: "2026-09-26T16:00" }
    ]
  }, { userId: USERS.zhou });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error, "schedules_must_cover_all_entries");

  // 数据未被破坏：概览条目排期不变、日历仍是原 2 条记录。
  ov = await h.overview();
  const after = ov.batches.find(x => x.id === b.id);
  assert.deepEqual(after.entries.map(e => [e.start, e.end]), beforeSlots);
  assert.equal(ov.calendar.filter(sc => sc.batchId === b.id).length, 2);
});

test("改期去重：同一索具重复传 → 400，不生成多条排期", async () => {
  const flow = await createScheduledSubmitted(h, { from: "2026-09-25T08:00" });
  await h.call("POST", `/api/batches/${flow.final.id}/withdraw`,
    { version: flow.final.version }, { userId: USERS.zhou });
  const ov = await h.overview();
  const b = ov.batches.find(x => x.id === flow.final.id);
  const [e1, e2] = b.entries;
  const dup = await h.call("POST", `/api/batches/${b.id}/reschedule`, {
    version: b.version,
    schedules: [
      { entryId: e1.id, start: e1.start, end: e1.end },
      { entryId: e1.id, start: "2026-09-27T15:00", end: "2026-09-27T16:00" },
      { entryId: e2.id, start: e2.start, end: e2.end }
    ]
  }, { userId: USERS.zhou });
  assert.equal(dup.status, 400);
  assert.equal(dup.json.error, "duplicate_schedule_entry");
  const ov2 = await h.overview();
  assert.equal(ov2.calendar.filter(sc => sc.batchId === b.id).length, 2, "不得为重复条目生成多余排期");
});

test("版本必传：缺 version 的各类写请求一律 400 version_required 且不生效", async () => {
  const created = await h.call("POST", "/api/batches", {
    shipId: "S-2", entries: [{ position: "后桅稳索", zone: "后桅", op: "勘验", userId: USERS.lin }]
  }, { userId: USERS.lin, idem: "nov-" + Math.random() });
  const id = created.json.batch.id, eid = created.json.batch.entries[0].id;

  const noVerAuto = await h.call("POST", `/api/batches/${id}/auto-schedule`, { from: "2026-09-28T08:00" }, { userId: USERS.lin });
  assert.equal(noVerAuto.status, 400);
  assert.equal(noVerAuto.json.error, "version_required");

  const noVerResched = await h.call("POST", `/api/batches/${id}/reschedule`,
    { schedules: [{ entryId: eid, start: "2026-09-28T09:00", end: "2026-09-28T10:00" }] }, { userId: USERS.lin });
  assert.equal(noVerResched.status, 400);
  assert.equal(noVerResched.json.error, "version_required");

  // 合法自动排期后，提交/复核/交付缺版本同样拒绝。
  const auto = await h.call("POST", `/api/batches/${id}/auto-schedule`,
    { from: "2026-09-28T08:00", version: 1 }, { userId: USERS.lin });
  const vAfterAuto = auto.json.batch.version;
  const noVerSubmit = await h.call("POST", `/api/batches/${id}/submit`, {}, { userId: USERS.lin });
  assert.equal(noVerSubmit.status, 400);
  assert.equal(noVerSubmit.json.error, "version_required");

  await h.call("POST", `/api/batches/${id}/submit`, { version: vAfterAuto }, { userId: USERS.lin });
  const noVerReview = await h.call("POST", `/api/batches/${id}/review`,
    { decision: "approve" }, { userId: USERS.shen });
  assert.equal(noVerReview.status, 400);
  assert.equal(noVerReview.json.error, "version_required");

  const ov = await h.overview();
  const submittedV = ov.batches.find(x => x.id === id).version;
  await h.call("POST", `/api/batches/${id}/review`, { decision: "approve", version: submittedV }, { userId: USERS.shen });
  const ov2 = await h.overview();
  const approvedV = ov2.batches.find(x => x.id === id).version;
  const noVerDeliver = await h.call("POST", `/api/batches/${id}/deliver`, {}, { userId: USERS.zheng });
  assert.equal(noVerDeliver.status, 400);
  assert.equal(noVerDeliver.json.error, "version_required");
  // 未真的交付。
  const ov3 = await h.overview();
  assert.equal(ov3.batches.find(x => x.id === id).status, "复核通过");
  assert.equal(ov3.batches.find(x => x.id === id).version, approvedV);
});

test("旧版本：所有写动作带过期 version 均 409 version_conflict", async () => {
  const flow = await createScheduledSubmitted(h, { from: "2026-09-29T08:00" });
  const id = flow.final.id, stale = flow.batch.version; // v1，当前已经是提交后的更高版本
  const r1 = await h.call("POST", `/api/batches/${id}/withdraw`, { version: stale }, { userId: USERS.zhou });
  assert.equal(r1.status, 409);
  assert.equal(r1.json.error, "version_conflict");
  const r2 = await h.call("POST", `/api/batches/${id}/review`,
    { decision: "reject", note: "x", version: stale }, { userId: USERS.shen });
  assert.equal(r2.status, 409);
  assert.equal(r2.json.error, "version_conflict");

  // 走到复核通过，再用旧版本号交付 → 同样 version_conflict（状态已可交付，纯粹是版本过期）。
  const cur = await h.call("POST", `/api/batches/${id}/review`,
    { decision: "approve", version: flow.final.version }, { userId: USERS.shen });
  const r3 = await h.call("POST", `/api/batches/${id}/deliver`, { version: stale }, { userId: USERS.zheng });
  assert.equal(r3.status, 409);
  assert.equal(r3.json.error, "version_conflict");
  // 批次未被错误交付。
  const ov = await h.overview();
  assert.equal(ov.batches.find(b => b.id === id).status, "复核通过");

  // 用当前版本仍可正常交付。
  const ok = await h.call("POST", `/api/batches/${id}/deliver`,
    { version: cur.json.batch.version }, { userId: USERS.zheng });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.batch.status, "已交付");
});

test("幂等键按动作隔离：同键先建批，再用于改期 → 409，绝不回放建批响应；换批次同动作也不串", async () => {
  const key = "cross-action-key-1";
  const firstPayload = {
    shipId: "S-2", entries: [{ position: "后桅稳索", zone: "后桅", op: "勘验", userId: USERS.lin }]
  };
  const first = await h.call("POST", "/api/batches", firstPayload, { userId: USERS.lin, idem: key });
  const id = first.json.batch.id;
  assert.equal(first.status, 201);

  // 同键拿去自动排期（不同动作作用域）→ 409，不能拿到建批的响应。
  const cross = await h.call("POST", `/api/batches/${id}/auto-schedule`,
    { from: "2026-09-30T08:00", version: 1 }, { userId: USERS.lin, idem: key });
  assert.equal(cross.status, 409);
  assert.equal(cross.json.error, "idempotency_scope_conflict");
  assert.match(cross.json.details.message, /其他动作/);

  // 同键同动作但内容不同 → 409 idempotency_content_mismatch，不回放、不新增、不改数据。
  const different = await h.call("POST", "/api/batches", {
    shipId: "S-2", entries: [{ position: "完全不同内容", zone: "后桅", op: "勘验", userId: USERS.lin }]
  }, { userId: USERS.lin, idem: key });
  assert.equal(different.status, 409);
  assert.equal(different.json.error, "idempotency_content_mismatch");

  // 同键同动作且内容完全一致 → 正常回放首次建批结果，不新增。
  const replay = await h.call("POST", "/api/batches", firstPayload, { userId: USERS.lin, idem: key });
  assert.equal(replay.status, 201);
  assert.equal(replay.json.replayed, true);
  assert.equal(replay.json.batch.id, id);
  const ov = await h.overview();
  assert.equal(ov.batches.filter(b => b.id === id).length, 1);
  assert.equal(ov.batches.find(b => b.id === id).entries[0].position, "后桅稳索", "不同内容的请求未改写原批次");

  // 同键用于另一个批次的同动作（batch.reschedule:B-x）作用域不同 → 同样 409。
  const second = await h.call("POST", "/api/batches", {
    shipId: "S-2", entries: [{ position: "前桅支索", zone: "前桅", op: "勘验", userId: USERS.zhou }]
  }, { userId: USERS.zhou, idem: "scope-key-2" });
  const id2 = second.json.batch.id;
  // id2 先合法自动排期（它自己的键），再拿 id 的同动作键改 id2。
  await h.call("POST", `/api/batches/${id2}/auto-schedule`,
    { from: "2026-09-30T08:00", version: 1 }, { userId: USERS.zhou, idem: "scope-key-2-auto" });
  const ov2 = await h.overview();
  const v2 = ov2.batches.find(b => b.id === id2).version;
  // scope-key-2 已用于 batch.create，现用于 auto/reschedule 也必须冲突。
  const cross2 = await h.call("POST", `/api/batches/${id2}/reschedule`, {
    version: v2,
    schedules: [{ entryId: second.json.batch.entries[0].id, start: "2026-10-01T09:00", end: "2026-10-01T10:00" }]
  }, { userId: USERS.zhou, idem: "scope-key-2" });
  assert.equal(cross2.status, 409);
  assert.equal(cross2.json.error, "idempotency_scope_conflict");
});

test("幂等同动作重试：排期失败不占键，同键修正后可成功；成功再提交则回放", async () => {
  const key = "same-action-retry-1";
  const created = await h.call("POST", "/api/batches", {
    shipId: "S-2",
    entries: [
      { position: "前桅支索", zone: "前桅", op: "勘验", userId: USERS.zhou },
      { position: "前桅支索", zone: "前桅", op: "初调", userId: USERS.zhou }
    ]
  }, { userId: USERS.zhou, idem: "same-action-create" });
  const id = created.json.batch.id;
  // 第一次改期用旧版本号 → 409，键不被占用。
  const bad = await h.call("POST", `/api/batches/${id}/reschedule`, {
    version: 99,
    schedules: created.json.batch.entries.map(e => ({ entryId: e.id, start: "2026-10-02T09:00", end: "2026-10-02T10:00" }))
  }, { userId: USERS.zhou, idem: key });
  assert.equal(bad.status, 409);
  // 同键用正确版本再来一次（条目数=2，给合法且互不重叠的时段）→ 成功。
  const good = await h.call("POST", `/api/batches/${id}/reschedule`, {
    version: 1,
    schedules: [
      { entryId: created.json.batch.entries[0].id, start: "2026-10-02T09:00", end: "2026-10-02T10:00" },
      { entryId: created.json.batch.entries[1].id, start: "2026-10-02T10:00", end: "2026-10-02T11:30" }
    ]
  }, { userId: USERS.zhou, idem: key });
  assert.equal(good.status, 200);
  // 再用同键提交相同请求 → 回放，版本不再增加。
  const replay = await h.call("POST", `/api/batches/${id}/reschedule`, {
    version: 2,
    schedules: [
      { entryId: created.json.batch.entries[0].id, start: "2026-10-02T09:00", end: "2026-10-02T10:00" },
      { entryId: created.json.batch.entries[1].id, start: "2026-10-02T10:00", end: "2026-10-02T11:30" }
    ]
  }, { userId: USERS.zhou, idem: key });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.replayed, true);
  assert.equal(replay.json.batch.version, 2, "回放不得再次推进版本");
});

// ---------- 本次边界：过去时间 / 非校准负责人 ----------
function localInput(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

test("过去时间：自动排期 from 与改期 start 落在过去均 400，不生成过期时段、不改数据", async () => {
  const created = await h.call("POST", "/api/batches", {
    shipId: "S-2", entries: [{ position: "后桅稳索", zone: "后桅", op: "勘验", userId: USERS.lin }]
  }, { userId: USERS.lin, idem: "past-" + Math.random() });
  const id = created.json.batch.id, eid = created.json.batch.entries[0].id;
  const past = localInput(new Date(Date.now() - 3600000));

  const auto = await h.call("POST", `/api/batches/${id}/auto-schedule`,
    { from: past, version: 1 }, { userId: USERS.lin });
  assert.equal(auto.status, 400);
  assert.equal(auto.json.error, "schedule_in_past");

  const put = await h.call("POST", `/api/batches/${id}/reschedule`, {
    version: 1, schedules: [{ entryId: eid, start: past, end: localInput(new Date(Date.now() - 1800000)) }]
  }, { userId: USERS.lin });
  assert.equal(put.status, 400);
  assert.equal(put.json.error, "schedule_in_past");

  // 没有任何排期落地，批次仍 v1、日历无该批记录。
  const ov = await h.overview();
  const b = ov.batches.find(x => x.id === id);
  assert.equal(b.version, 1);
  assert.equal(b.entries[0].start, null);
  assert.equal(ov.calendar.filter(sc => sc.batchId === id).length, 0);

  // 换成未来时间仍可正常排期。
  const ok = await h.call("POST", `/api/batches/${id}/reschedule`, {
    version: 1, schedules: [{ entryId: eid, start: "2026-11-05T09:00", end: "2026-11-05T10:00" }]
  }, { userId: USERS.lin });
  assert.equal(ok.status, 200);
});

test("非校准负责人：建批/加条目把复核员或交付员填成负责人一律 400", async () => {
  for (const badUser of [USERS.shen, USERS.zheng]) {
    const r = await h.call("POST", "/api/batches", {
      shipId: "S-2", entries: [{ position: "x", zone: "前桅", op: "勘验", userId: badUser }]
    }, { userId: USERS.zhou, idem: "bad-assignee-" + badUser });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, "assignee_must_be_calibrator");
  }
  const ov1 = await h.overview();
  const countBefore = ov1.batches.length;

  // 正常建一个批次后，往里面加复核员条目也拒绝。
  const ok = await h.call("POST", "/api/batches", {
    shipId: "S-2", entries: [{ position: "合法索具", zone: "前桅", op: "勘验", userId: USERS.lin }]
  }, { userId: USERS.lin, idem: "good-batch-" + Math.random() });
  const id = ok.json.batch.id;
  const addBad = await h.call("POST", `/api/batches/${id}/entries`, {
    version: 1, entry: { position: "新索", zone: "前桅", op: "勘验", userId: USERS.shen }
  }, { userId: USERS.lin });
  assert.equal(addBad.status, 400);
  assert.equal(addBad.json.error, "assignee_must_be_calibrator");

  const ov2 = await h.overview();
  assert.equal(ov2.batches.length, countBefore + 1, "非法建批未产生批次");
  assert.equal(ov2.batches.find(b => b.id === id).entries.length, 1, "非法加条目未产生条目");
});

test("幂等内容：改期同键不同内容 409 不改数据，同键相同内容回放且只执行一次", async () => {
  const created = await h.call("POST", "/api/batches", {
    shipId: "S-2", entries: [{ position: "后桅稳索", zone: "后桅", op: "勘验", userId: USERS.lin }]
  }, { userId: USERS.lin, idem: "fp-batch-" + Math.random() });
  const id = created.json.batch.id, eid = created.json.batch.entries[0].id, key = "fp-resched-" + Math.random();

  const first = await h.call("POST", `/api/batches/${id}/reschedule`, {
    version: 1, schedules: [{ entryId: eid, start: "2026-11-06T09:00", end: "2026-11-06T10:00" }]
  }, { userId: USERS.lin, idem: key });
  assert.equal(first.status, 200);
  assert.equal(first.json.batch.version, 2);

  // 同键 + 不同业务内容（改到另一时段）→ 409，原时段保持，版本不增。
  const mismatch = await h.call("POST", `/api/batches/${id}/reschedule`, {
    version: 2, schedules: [{ entryId: eid, start: "2026-11-06T14:00", end: "2026-11-06T15:00" }]
  }, { userId: USERS.lin, idem: key });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.json.error, "idempotency_content_mismatch");
  const ov = await h.overview();
  const b = ov.batches.find(x => x.id === id);
  assert.equal(b.entries[0].start, "2026-11-06T09:00");
  assert.equal(b.version, 2);

  // 同键 + 相同业务内容（版本号带当前值，指纹忽略版本）→ 回放，不再次推进版本。
  const replay = await h.call("POST", `/api/batches/${id}/reschedule`, {
    version: 2, schedules: [{ entryId: eid, start: "2026-11-06T09:00", end: "2026-11-06T10:00" }]
  }, { userId: USERS.lin, idem: key });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.replayed, true);
  assert.equal(replay.json.batch.version, 2);
});

// ---------- 驳回：回到校准、原记录与排期保留 ----------
test("复核驳回：批次回到校准，提交/驳回记录和原排期保留，可改期后重新提交", async () => {
  const flow = await createScheduledSubmitted(h, { from: "2026-09-17T08:00", zone: "后桅", workerId: USERS.lin });
  const id = flow.final.id;
  const submittedVersion = flow.final.version;
  const originalSlots = flow.final.entries.map(e => e.start);

  const rej = await h.call("POST", `/api/batches/${id}/review`,
    { decision: "reject", note: "张力记录缺失", version: submittedVersion }, { userId: USERS.shen });
  assert.equal(rej.status, 200);
  assert.equal(rej.json.batch.status, "已驳回");

  let ov = await h.overview();
  const b = ov.batches.find(x => x.id === id);
  assert.deepEqual(b.entries.map(e => e.start), originalSlots, "驳回后排期保留");
  const actions = b.history.map(x => x.action);
  assert.ok(actions.includes("submit"), "原提交记录保留");
  assert.ok(actions.includes("batch.reject"), "驳回记录保留");
  // 驳回批次出现在校准员待办中。
  ov = await h.overview(USERS.zhou);
  assert.ok(ov.todos.some(t => t.id === id));

  // 校准员改到无冲突时段后重新提交，复核员再次通过。
  const rr = await h.call("POST", `/api/batches/${id}/reschedule`, {
    version: b.version,
    schedules: b.entries.map((e, i) => ({
      entryId: e.id,
      start: i === 0 ? "2026-09-17T09:00" : "2026-09-17T10:00",
      end: i === 0 ? "2026-09-17T10:00" : "2026-09-17T11:30"
    }))
  }, { userId: USERS.zhou });
  assert.equal(rr.status, 200);
  const resubmit = await h.call("POST", `/api/batches/${id}/submit`, { version: rr.json.batch.version }, { userId: USERS.zhou });
  assert.equal(resubmit.status, 200);
  const approve = await h.call("POST", `/api/batches/${id}/review`,
    { decision: "approve", version: resubmit.json.batch.version }, { userId: USERS.shen });
  assert.equal(approve.json.batch.status, "复核通过");
});

test("驳回必须填写原因；复核员只能在待复核状态操作", async () => {
  const flow = await createScheduledSubmitted(h, { from: "2026-09-23T08:00" });
  const id = flow.final.id;
  const v = flow.final.version;
  const noNote = await h.call("POST", `/api/batches/${id}/review`, { decision: "reject", note: "", version: v }, { userId: USERS.shen });
  assert.equal(noNote.status, 400);
  // 直接通过后再驳回 → 状态不对。
  await h.call("POST", `/api/batches/${id}/review`, { decision: "approve", version: v }, { userId: USERS.shen });
  const late = await h.call("POST", `/api/batches/${id}/review`, { decision: "reject", note: "晚了" }, { userId: USERS.shen });
  assert.equal(late.status, 409);
});

// ---------- 交付锁定 ----------
test("交付锁定：已交付批次禁止新增、改期、撤回、复核、再交付", async () => {
  const flow = await createScheduledSubmitted(h, { from: "2026-09-24T08:00" });
  const id = flow.final.id;
  const v = flow.final.version;
  const approve = await h.call("POST", `/api/batches/${id}/review`, { decision: "approve", version: v }, { userId: USERS.shen });
  const deliver = await h.call("POST", `/api/batches/${id}/deliver`,
    { version: approve.json.batch.version }, { userId: USERS.zheng });
  assert.equal(deliver.json.batch.status, "已交付");
  assert.ok(deliver.json.batch.deliveredAt);

  const ov = await h.overview();
  const b = ov.batches.find(x => x.id === id);

  const attempts = [
    ["POST", `/api/batches/${id}/entries`, { entry: { position: "新索", zone: b.entries[0].zone, op: "勘验", userId: USERS.zhou } }, USERS.zhou],
    ["POST", `/api/batches/${id}/reschedule`, { version: b.version, schedules: b.entries.map(e => ({ entryId: e.id, start: e.start, end: e.end })) }, USERS.zhou],
    ["POST", `/api/batches/${id}/withdraw`, {}, USERS.zhou],
    ["POST", `/api/batches/${id}/submit`, {}, USERS.zhou],
    ["POST", `/api/batches/${id}/review`, { decision: "reject", note: "x" }, USERS.shen],
    ["POST", `/api/batches/${id}/deliver`, {}, USERS.zheng]
  ];
  for (const [method, path, body, user] of attempts) {
    const r = await h.call(method, path, body, { userId: user });
    assert.equal(r.status, 409, `${path} 应被锁定，实际 ${r.status}`);
    assert.equal(r.json.error, "batch_delivered_locked", `${path} 错误码不对`);
  }
  // 交付后不出现在任何角色待办。
  for (const u of [USERS.zhou, USERS.shen, USERS.zheng]) {
    const o = await h.overview(u);
    assert.ok(!o.todos.some(t => t.id === id));
  }
});

test("交付员只能交付复核通过的批次", async () => {
  const created = await h.call("POST", "/api/batches", {
    shipId: "S-2", entries: [{ position: "后桅稳索", zone: "后桅", op: "勘验", userId: USERS.lin }]
  }, { userId: USERS.lin, idem: "del-" + Math.random() });
  const r = await h.call("POST", `/api/batches/${created.json.batch.id}/deliver`, {}, { userId: USERS.zheng });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "batch_not_deliverable");
});

test("审计轨迹记录全部关键动作", async () => {
  const ov = await h.overview();
  const actions = new Set(ov.audit.map(a => a.action));
  for (const a of ["batch.create", "batch.submit", "batch.reject", "batch.approve", "batch.deliver", "batch.reschedule"]) {
    assert.ok(actions.has(a), `缺少审计动作 ${a}`);
  }
});
