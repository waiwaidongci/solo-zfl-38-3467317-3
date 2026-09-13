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
  const auto = await h.call("POST", `/api/batches/${id}/auto-schedule`, { from: "2026-09-14T08:00" }, { userId: USERS.zhou });
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

test("排期冲突：撞种子桅区/负责人 → 409 列冲突项与替代时段", async () => {
  const flow = await createScheduledSubmitted(h, { from: "2026-09-21T08:00" });
  // 校准员撤回复核，回到待校准才能改期。
  await h.call("POST", `/api/batches/${flow.final.id}/withdraw`, {}, { userId: USERS.zhou });
  const ov = await h.overview();
  const b = ov.batches.find(x => x.id === flow.final.id);
  const [e1, e2] = b.entries;
  const r = await h.call("POST", `/api/batches/${b.id}/reschedule`, {
    version: b.version,
    schedules: [
      { entryId: e1.id, start: "2026-09-15T09:00", end: "2026-09-15T10:00" },
      { entryId: e2.id, start: "2026-09-15T10:00", end: "2026-09-15T11:30" }
    ]
  }, { userId: USERS.zhou });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "reschedule_conflict");
  const types = new Set(r.json.details.conflicts.map(c => c.type));
  assert.ok(types.has("zone_occupied"), "应报桅区占用");
  assert.ok(types.has("person_double_booked"), "应报撞人");
  assert.ok(r.json.details.alternatives.length >= 2, "每个冲突条目都要有替代时段");
  // 替代时段必须晚于种子占用。
  for (const a of r.json.details.alternatives) assert.ok(a.start >= "2026-09-15T10:30");
});

test("整批回滚：改期失败后原排期、版本、状态完全不变", async () => {
  const flow = await createScheduledSubmitted(h, { from: "2026-09-22T08:00" });
  await h.call("POST", `/api/batches/${flow.final.id}/withdraw`, {}, { userId: USERS.zhou });
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
  await h.call("POST", `/api/batches/${id}/auto-schedule`, { from: "2026-09-17T13:30" }, { userId: USERS.lin });
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
  await h.call("POST", `/api/batches/${id}/auto-schedule`, { from: "2026-09-20T08:00" }, { userId: USERS.lin });
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
