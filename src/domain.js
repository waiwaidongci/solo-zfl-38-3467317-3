// 领域层：角色权限、批次生命周期、工序依赖/负责人日排期/桅区占用三约束排期、冲突检测与整批回滚。

export const ROLES = {
  calibrator: "校准员",
  reviewer: "复核员",
  deliverer: "交付员"
};

export const BATCH_STATUS = {
  DRAFT: "待校准",
  SUBMITTED: "待复核",
  REJECTED: "已驳回",
  APPROVED: "复核通过",
  DELIVERED: "已交付"
};

// 每个角色只允许本岗动作；不在表内的动作一律拒绝（越权）。
const PERMISSIONS = {
  calibrator: [
    "batch.create", "batch.submit", "batch.withdraw",
    "batch.reschedule", "entry.add"
  ],
  reviewer: ["batch.approve", "batch.reject"],
  deliverer: ["batch.deliver"]
};

export class HttpError extends Error {
  constructor(status, code, details) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const DAY_MS = 86400000;

function pad(n) { return String(n).padStart(2, "0"); }
export function minuteOfDay(d) { return d.getHours() * 60 + d.getMinutes(); }
export function toLocalInput(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function parseTime(s) {
  const [date, clock] = s.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = (clock || "0:0").split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}
function within(innerS, innerE, outerS, outerE) {
  return innerS.getTime() >= outerS.getTime() && innerE.getTime() <= outerE.getTime();
}

export function requireRole(user, action) {
  if (!user) throw new HttpError(401, "unauthenticated");
  const allowed = PERMISSIONS[user.role];
  if (!allowed || !allowed.includes(action)) {
    throw new HttpError(403, "forbidden", {
      role: user.role,
      roleName: ROLES[user.role] || user.role,
      action,
      message: `${ROLES[user.role] || user.role}无权执行「${action}」，本岗仅可执行：${(allowed || []).join("、") || "无"}`
    });
  }
}

function addAudit(state, { at, actorId, action, batchId, detail }) {
  state.audit.push({
    id: "A-" + (state.seq + 1000) + "-" + state.audit.length + 1,
    at, actorId, action, batchId: batchId || null, detail: detail || {}
  });
}

function findUser(state, userId) {
  const user = state.users.find(u => u.id === userId);
  if (!user) throw new HttpError(401, "unauthenticated");
  return user;
}
function findShip(state, shipId) {
  const ship = state.ships.find(s => s.id === shipId);
  if (!ship) throw new HttpError(404, "ship_not_found", { shipId });
  return ship;
}
function findBatch(state, batchId) {
  const batch = state.batches.find(b => b.id === batchId);
  if (!batch) throw new HttpError(404, "batch_not_found", { batchId });
  return batch;
}
function opLib(state, key) {
  const op = state.operations.find(o => o.key === key);
  if (!op) throw new HttpError(400, "unknown_operation", { op: key });
  return op;
}
// 已交付批次锁定：禁止新增、改期、撤回、复核等一切写动作。
function assertNotDelivered(batch) {
  if (batch.status === BATCH_STATUS.DELIVERED) {
    throw new HttpError(409, "batch_delivered_locked", {
      batchId: batch.id,
      message: "批次已交付并锁定，禁止新增、改期或撤回"
    });
  }
}

// 幂等：同 key 重复提交直接返回首次结果，绝不生成第二条记录。
function idempotent(state, key, producer) {
  if (!key) return producer();
  const cached = state.idempotency[key];
  if (cached) return { ...cached, replayed: true };
  const created = producer();
  state.idempotency[key] = {
    kind: created.kind, id: created.id, batchId: created.batchId, at: created.at
  };
  return created;
}

// ---- 排期引擎 ----------------------------------------------------------------

// 取负责人时间窗内已排条目 + blocked 请假/会议。
function occupantBusy(state, userId, rangeStart, rangeEnd) {
  const busy = [];
  for (const sc of state.schedules) {
    if (sc.status !== "active" || sc.userId !== userId) continue;
    const s = parseTime(sc.start);
    if (s < rangeStart || s >= rangeEnd) continue;
    busy.push({ start: sc.start, end: sc.end, reason: `工单 ${sc.batchId}/${sc.op}` });
  }
  const cal = state.calendars.find(c => c.userId === userId);
  if (cal) for (const b of cal.blocked) {
    const s = parseTime(b.start);
    if (s < rangeStart || s >= rangeEnd) continue;
    busy.push({ start: b.start, end: b.end, reason: b.reason || "不可用" });
  }
  return busy;
}
function zoneBusy(state, zone, rangeStart, rangeEnd) {
  const busy = [];
  for (const sc of state.schedules) {
    if (sc.status !== "active" || sc.zone !== zone) continue;
    const s = parseTime(sc.start);
    if (s < rangeStart || s >= rangeEnd) continue;
    busy.push({ start: sc.start, end: sc.end, reason: `桅区占用 ${sc.batchId}/${sc.op}` });
  }
  return busy;
}
function internalBusy(entries, exceptIndex) {
  const busy = [];
  entries.forEach((e, i) => {
    if (i === exceptIndex || !e.schedule) return;
    busy.push({ start: e.schedule.start, end: e.schedule.end, reason: `批次内：${e.position}·${e.op}` });
  });
  return busy;
}

// 在一周网格上找第一个满足三类约束的起点：
// 1) 负责人当日工作时段、午休/blocked 之外；
// 2) 与既有工单/会议不撞人；
// 3) 桅区不被其他工单占用（同船同批内部条目允许同桅区串接，不允许重叠）；
// 4) 工序依赖：起点不得早于前置工序结束。
function findSlot(state, entry, from, entries, scanStart) {
  const cal = state.calendars.find(c => c.userId === entry.userId);
  if (!cal) throw new HttpError(400, "user_has_no_calendar", { userId: entry.userId });
  const op = opLib(state, entry.op);
  const dur = op.durationMinutes;
  const prereqEnds = op.after.map(preKey => {
    const pre = entries.find(e => e.op === preKey && e.zone === entry.zone && e.schedule);
    return pre ? parseTime(pre.schedule.end) : null;
  }).filter(Boolean);

  const rangeEnd = new Date(scanStart.getTime() + 28 * DAY_MS);
  const personBusy = occupantBusy(state, entry.userId, scanStart, rangeEnd);
  const zBusy = zoneBusy(state, entry.zone, scanStart, rangeEnd);
  const innerBusy = internalBusy(entries, entries.indexOf(entry));

  const firstDay = new Date(from.getFullYear(), from.getMonth(), from.getDate());

  for (let dayOffset = 0; dayOffset <= 21; dayOffset++) {
    const dayStart = new Date(firstDay.getTime() + dayOffset * DAY_MS);
    // 以 15 分钟为步进扫描该日工作时段。
    for (let m = cal.workMinutes[0]; m + dur <= cal.workMinutes[1]; m += 15) {
      const s = new Date(dayStart.getTime() + m * 60000);
      if (s < from) continue;
      const e = new Date(s.getTime() + dur * 60000);
      if (m + dur > cal.workMinutes[1]) break;
      // 午休/固定休息。
      if ((cal.breakMinutes || []).some(([bs, be]) => overlaps(s, e,
        new Date(dayStart.getTime() + bs * 60000), new Date(dayStart.getTime() + be * 60000)))) continue;
      // blocked 会议/请假。
      if (personBusy.some(b => overlaps(s, e, parseTime(b.start), parseTime(b.end)))) continue;
      // 工序依赖。
      if (prereqEnds.some(pe => s < pe)) continue;
      // 桅区：跨批既有占用冲突；同船同批内部串接条目视作占用但允许在其后（已由 prereq/overlap 检查）。
      if (zBusy.some(b => overlaps(s, e, parseTime(b.start), parseTime(b.end)))) continue;
      if (innerBusy.some(b => overlaps(s, e, parseTime(b.start), parseTime(b.end)))) continue;
      return { start: toLocalInput(s), end: toLocalInput(e) };
    }
  }
  return null;
}

// 按依赖拓扑排序后顺序选时段（每段 from = 同桅区前置工序结束 或 给定 from）。
export function planSchedules(state, draftEntries, fromInput) {
  const entries = draftEntries.map(e => ({ ...e, schedule: null }));
  const topo = [...entries].sort((a, b) => {
    const oa = state.operations.find(o => o.key === a.op);
    const ob = state.operations.find(o => o.key === b.op);
    return state.operations.indexOf(oa) - state.operations.indexOf(ob);
  });
  const from = fromInput ? parseTime(fromInput) : new Date();
  // from 若落在过去则取当前时间（页面传未来日期，测试可注入 from）。
  const weekStartInput = fromInput ? parseTime(fromInput) : new Date();
  const weekStart = new Date(weekStartInput);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  weekStart.setHours(0, 0, 0, 0);

  for (const entry of topo) {
    const pre = state.operations.find(o => o.key === entry.op);
    let entryFrom = from;
    // 同桅区前置已排：从其结束之后继续找。
    for (const preKey of pre.after) {
      const done = entries.find(x => x.op === preKey && x.zone === entry.zone && x.schedule);
      if (done) {
        const end = parseTime(done.schedule.end);
        if (end > entryFrom) entryFrom = end;
      }
    }
    const slot = findSlot(state, entry, entryFrom, entries, weekStart);
    if (!slot) {
      return { ok: false, error: "no_available_slot", entryId: entry.clientId || entry.id, position: entry.position, op: entry.op };
    }
    const target = entries.find(e => e === entry);
    target.schedule = slot;
  }
  return { ok: true, schedules: entries.map(e => ({ clientId: e.clientId, id: e.id, schedule: e.schedule })) };
}

// 对一组拟排时段逐条检查三类冲突（整批改期前的试算）。
export function detectConflicts(state, batch, proposed /* [{entryId, start, end}] */) {
  const conflicts = [];
  const propList = proposed.map(p => {
    const entry = batch.entries.find(e => e.id === p.entryId);
    if (!entry) throw new HttpError(404, "entry_not_found", { entryId: p.entryId });
    const s = parseTime(p.start), e = parseTime(p.end);
    if (!(e > s)) throw new HttpError(400, "invalid_time_range", { entryId: p.entryId });
    return { entry, start: s, end: e };
  });

  for (const cur of propList) {
    const { entry, start, end } = cur;
    const cal = state.calendars.find(c => c.userId === entry.userId);
    const dayStart = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    // 负责人工作时段。
    const ws = new Date(dayStart.getTime() + cal.workMinutes[0] * 60000);
    const we = new Date(dayStart.getTime() + cal.workMinutes[1] * 60000);
    if (!within(start, end, ws, we)) {
      conflicts.push(conflict(entry, "outside_work_hours", `${ROLES.calibrator}工作时段 ${fmt(ws)}-${fmt(we)}`, p(start), p(end)));
    }
    for (const [bs, be] of cal.breakMinutes || []) {
      const bS = new Date(dayStart.getTime() + bs * 60000), bE = new Date(dayStart.getTime() + be * 60000);
      if (overlaps(start, end, bS, bE)) conflicts.push(conflict(entry, "break_time", "午休/封盘", p(start), p(end)));
    }
    for (const b of cal.blocked || []) {
      if (overlaps(start, end, parseTime(b.start), parseTime(b.end))) {
        conflicts.push(conflict(entry, "person_blocked", b.reason || "负责人不可用", p(start), p(end)));
      }
    }
    // 既有工单撞人（排除本批次自身条目）。
    for (const sc of state.schedules) {
      if (sc.status !== "active" || sc.batchId === batch.id) continue;
      if (sc.userId !== entry.userId) continue;
      if (overlaps(start, end, parseTime(sc.start), parseTime(sc.end))) {
        conflicts.push(conflict(entry, "person_double_booked", `与工单 ${sc.batchId} · ${sc.op} 撞人`, p(start), p(end)));
      }
    }
    // 桅区占用（排除本批次自身）。
    for (const sc of state.schedules) {
      if (sc.status !== "active" || sc.batchId === batch.id) continue;
      if (sc.zone !== entry.zone) continue;
      if (overlaps(start, end, parseTime(sc.start), parseTime(sc.end))) {
        conflicts.push(conflict(entry, "zone_occupied", `桅区「${entry.zone}」被 ${sc.batchId} · ${sc.op} 占用`, p(start), p(end)));
      }
    }
    // 工序依赖：起点早于同桅前置工序结束。
    const op = state.operations.find(o => o.key === entry.op);
    for (const preKey of op.after || []) {
      const preProp = propList.find(x => x.entry.op === preKey && x.entry.zone === entry.zone);
      const preExisting = batch.entries.find(x => x.id !== entry.id && x.op === preKey && x.zone === entry.zone);
      const preEnd = preProp ? preProp.end : (preExisting && preExisting.schedule ? parseTime(preExisting.schedule.end) : null);
      if (preEnd && start < preEnd) {
        conflicts.push(conflict(entry, "dependency_violation", `必须晚于前置工序「${preKey}」结束 ${fmt(preEnd)}`, p(start), p(end)));
      }
    }
    // 批次内部条目同时段撞人/撞桅区（每对只报一次）。
    for (const other of propList) {
      if (other.entry.id <= entry.id) continue;
      if (other.entry.userId === entry.userId || other.entry.zone === entry.zone) {
        if (overlaps(start, end, other.start, other.end)) {
          conflicts.push(conflict(entry, "batch_internal_overlap",
            `与批次内 ${other.entry.position}·${other.entry.op} 重叠`, p(start), p(end)));
        }
      }
    }
  }
  return dedupeConflicts(conflicts);
}
function conflict(entry, type, reason, start, end) {
  return { entryId: entry.id, shipCode: entry.shipCode, zone: entry.zone, position: entry.position,
    op: entry.op, userId: entry.userId, type, reason, start, end };
}
function p(d) { return toLocalInput(d); }
function fmt(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function dedupeConflicts(list) {
  const seen = new Set();
  return list.filter(c => {
    const k = [c.entryId, c.type, c.start, c.end, c.reason].join("|");
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

// 为冲突条目联合计算替代时段：临时拿掉本批旧排期，无冲突条目锚定其拟议时段，
// 冲突条目按工序顺序重排（后续条目的下界取前置条目的替代结束时间），保证整套替代自洽。
function alternatives(state, batch, conflictItems, proposed) {
  const hidden = new Set();
  batch.entries.forEach(e => { if (e.schedule) hidden.add(e.schedule.id); });
  const kept = state.schedules;
  state.schedules = kept.filter(sc => !hidden.has(sc.id));
  try {
    const conflictIds = new Set(conflictItems.map(c => c.entryId));
    const proposedById = new Map(proposed.map(p => [p.entryId, p]));
    // 草稿副本：无冲突条目带上拟议时段充当锚点，冲突条目待排。
    const scratch = batch.entries.map(e => {
      const p = proposedById.get(e.id);
      const isConflict = conflictIds.has(e.id);
      return { ...e, schedule: p && !isConflict ? { start: p.start, end: p.end } : null };
    });
    const earliest = proposed.map(p => parseTime(p.start)).sort((a, b) => a - b)[0];
    const scanStart = new Date(earliest);
    scanStart.setDate(scanStart.getDate() - scanStart.getDay()); scanStart.setHours(0, 0, 0, 0);

    const pending = scratch.filter(e => conflictIds.has(e.id))
      .sort((a, b) => state.operations.findIndex(o => o.key === a.op) - state.operations.findIndex(o => o.key === b.op));
    const out = [];
    for (const entry of pending) {
      const op = state.operations.find(o => o.key === entry.op);
      let lower = parseTime(proposedById.get(entry.id).start);
      for (const preKey of op.after || []) {
        const pre = scratch.find(x => x.op === preKey && x.zone === entry.zone && x.schedule);
        if (pre) { const pe = parseTime(pre.schedule.end); if (pe > lower) lower = pe; }
      }
      const slot = findSlot(state, entry, lower, scratch, scanStart);
      if (slot) {
        entry.schedule = slot;
        out.push({ entryId: entry.id, ...slot });
      }
    }
    return out;
  } finally {
    state.schedules = kept;
  }
}

// ---- 应用服务（全部在 store.mutate 事务内执行） --------------------------------

function nowIso() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function overview(state, userId) {
  const user = userId ? findUser(state, userId) : null;
  const todos = state.batches.filter(b => {
    if (user?.role === "calibrator") return [BATCH_STATUS.DRAFT, BATCH_STATUS.REJECTED].includes(b.status) && b.ownerId === user.id;
    if (user?.role === "reviewer") return b.status === BATCH_STATUS.SUBMITTED;
    if (user?.role === "deliverer") return b.status === BATCH_STATUS.APPROVED;
    return false;
  }).map(b => ({ id: b.id, shipCode: b.shipCode, status: b.status, version: b.version, submittedAt: b.submittedAt || null }));

  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - weekStart.getDay()); weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart.getTime() + 14 * DAY_MS);
  const calendar = state.schedules.filter(sc => {
    if (sc.status !== "active") return false;
    const at = parseTime(sc.start);
    return at >= weekStart && at < weekEnd;
  }).map(sc => ({ ...sc }));

  return {
    me: user ? { id: user.id, name: user.name, role: user.role, roleName: ROLES[user.role] } : null,
    users: state.users.map(u => ({ id: u.id, name: u.name, role: u.role, roleName: ROLES[u.role] })),
    ships: state.ships,
    operations: state.operations.map(o => ({ ...o })),
    calendars: state.calendars,
    batches: state.batches.map(summarizeBatch),
    todos,
    calendar,
    audit: state.audit.slice(-100).reverse()
  };
}

function summarizeBatch(b) {
  return {
    id: b.id, shipId: b.shipId, shipCode: b.shipCode, ownerId: b.ownerId, ownerName: b.ownerName,
    status: b.status, version: b.version, createdAt: b.createdAt, submittedAt: b.submittedAt || null,
    reviewedAt: b.reviewedAt || null, deliveredAt: b.deliveredAt || null,
    entries: b.entries.map(e => ({
      id: e.id, position: e.position, zone: e.zone, op: e.op, userId: e.userId,
      start: e.schedule ? e.schedule.start : null, end: e.schedule ? e.schedule.end : null
    })),
    history: b.history
  };
}

export function createBatch(state, actorId, input) {
  const actor = findUser(state, actorId);
  requireRole(actor, "batch.create");
  const ship = findShip(state, input.shipId);
  const at = nowIso();
  const made = idempotent(state, input.idempotencyKey, () => {
    const entries = [];
    for (const row of input.entries || []) {
      if (!row.position || !row.zone || !row.op || !row.userId) {
        throw new HttpError(400, "invalid_entry", { row });
      }
      opLib(state, row.op);
      findUser(state, row.userId);
      if (!ship.zones.includes(row.zone)) {
        throw new HttpError(400, "zone_not_on_ship", { shipCode: ship.code, zone: row.zone });
      }
      entries.push(mkEntry(state, ship, row));
    }
    if (!entries.length) throw new HttpError(400, "empty_batch");
    const id = "B-" + ++state.seq;
    const batch = {
      id, shipId: ship.id, shipCode: ship.code, ownerId: actor.id, ownerName: actor.name,
      status: BATCH_STATUS.DRAFT, version: 1, createdAt: at, submittedAt: null, reviewedAt: null,
      deliveredAt: null, entries,
      history: [{ at, action: "create", actorId, actorName: actor.name, note: "编成校准批次" }]
    };
    state.batches.push(batch);
    addAudit(state, { at, actorId, action: "batch.create", batchId: id,
      detail: { shipCode: ship.code, entries: entries.length } });
    return { kind: "batch", id, batchId: id, at, batch: summarizeBatch(batch) };
  });
  return made;
}

function mkEntry(state, ship, row) {
  return {
    id: "E-" + ++state.seq,
    shipCode: ship.code,
    position: row.position,
    zone: row.zone,
    op: row.op,
    userId: row.userId,
    schedule: null
  };
}

// 批次内新增帆索条目（仅校准员/负责人、非交付态）；交付锁定一并拦截。
export function addEntry(state, actorId, batchId, body) {
  const actor = findUser(state, actorId);
  requireRole(actor, "entry.add");
  const batch = findBatch(state, batchId);
  assertNotDelivered(batch);
  if (batch.ownerId !== actor.id) throw new HttpError(403, "forbidden_not_owner");
  if (![BATCH_STATUS.DRAFT, BATCH_STATUS.REJECTED].includes(batch.status)) {
    throw new HttpError(409, "batch_not_editable", { status: batch.status });
  }
  if (typeof body.version === "number" && body.version !== batch.version) {
    throw new HttpError(409, "version_conflict", { expected: batch.version, got: body.version });
  }
  const row = body.entry || {};
  if (!row.position || !row.zone || !row.op || !row.userId) throw new HttpError(400, "invalid_entry", { row });
  const ship = findShip(state, batch.shipId);
  if (!ship.zones.includes(row.zone)) throw new HttpError(400, "zone_not_on_ship", { zone: row.zone });
  opLib(state, row.op);
  findUser(state, row.userId);
  batch.entries.push(mkEntry(state, ship, row));
  const at = nowIso();
  batch.version += 1;
  batch.history.push({ at, action: "entry.add", actorId, actorName: actor.name, note: "新增帆索条目 " + row.position });
  addAudit(state, { at, actorId, action: "entry.add", batchId: batch.id, detail: { position: row.position, zone: row.zone } });
  return { batch: summarizeBatch(batch) };
}

// 自动排期：为待校准批次的所有条目一次性排出时段。
export function autoSchedule(state, actorId, batchId, body) {
  const actor = findUser(state, actorId);
  requireRole(actor, "batch.reschedule");
  const batch = findBatch(state, batchId);
  assertNotDelivered(batch);
  if (batch.ownerId !== actor.id) throw new HttpError(403, "forbidden_not_owner");
  if (![BATCH_STATUS.DRAFT, BATCH_STATUS.REJECTED].includes(batch.status)) {
    throw new HttpError(409, "batch_not_reschedulable", { status: batch.status });
  }

  // 先在副本上试算，失败不改任何数据（事务回滚由 store 兜底，这里保证不留半成品 schedules）。
  const hidden = new Set(batch.entries.filter(e => e.schedule).map(e => e.schedule.id));
  const kept = state.schedules;
  state.schedules = kept.filter(sc => !hidden.has(sc.id));
  let planned;
  try {
    planned = planSchedules(state, batch.entries, body.from);
  } finally {
    state.schedules = kept;
  }
  if (!planned.ok) throw new HttpError(409, "scheduling_failed", planned);

  // 删除本批旧排期，落新排期。
  state.schedules = state.schedules.filter(sc => sc.batchId !== batch.id);
  for (const ps of planned.schedules) {
    const entry = batch.entries.find(e => e.id === ps.id);
    entry.schedule = { id: "SC-" + ++state.seq, ...ps.schedule };
    state.schedules.push({
      id: entry.schedule.id, batchId: batch.id, entryId: entry.id, shipId: batch.shipId,
      zone: entry.zone, userId: entry.userId, op: entry.op,
      start: ps.schedule.start, end: ps.schedule.end, status: "active"
    });
  }
  const at = nowIso();
  batch.version += 1;
  batch.history.push({ at, action: "auto_schedule", actorId, actorName: actor.name,
    note: `自动排出 ${planned.schedules.length} 个时段` });
  addAudit(state, { at, actorId, action: "batch.auto_schedule", batchId: batch.id,
    detail: { count: planned.schedules.length } });
  return { batch: summarizeBatch(batch), scheduled: planned.schedules };
}

export function getSlots(state, actorId, body) {
  const actor = findUser(state, actorId);
  requireRole(actor, "batch.reschedule");
  const planned = planSchedules(state, (body.entries || []).map((e, i) => ({
    id: e.id || "Q-" + i, clientId: e.clientId, shipCode: e.shipCode || "", position: e.position,
    zone: e.zone, op: e.op, userId: e.userId, schedule: null
  })), body.from);
  return planned;
}

// 整批改期：乐观锁 version 校验 → 冲突试算 → 有冲突返回冲突项+替代时段且不写任何数据；
// 无冲突才整批替换并自增版本。任何失败由事务整体回滚。
export function rescheduleBatch(state, actorId, batchId, body) {
  const actor = findUser(state, actorId);
  requireRole(actor, "batch.reschedule");
  const batch = findBatch(state, batchId);
  assertNotDelivered(batch);
  if (batch.ownerId !== actor.id) throw new HttpError(403, "forbidden_not_owner");
  if (![BATCH_STATUS.DRAFT, BATCH_STATUS.REJECTED].includes(batch.status)) {
    throw new HttpError(409, "batch_not_reschedulable", { status: batch.status });
  }
  if (typeof body.version === "number" && body.version !== batch.version) {
    throw new HttpError(409, "version_conflict", {
      expected: batch.version, got: body.version,
      message: "批次已被他人改动（过期版本），请刷新后重试"
    });
  }
  const proposed = body.schedules;
  if (!Array.isArray(proposed) || !proposed.length) throw new HttpError(400, "schedules_required");
  const ids = new Set(batch.entries.map(e => e.id));
  if (!proposed.every(p => ids.has(p.entryId))) throw new HttpError(400, "unknown_entry_in_schedules");

  const conflicts = detectConflicts(state, batch, proposed);
  if (conflicts.length) {
    const alt = alternatives(state, batch,
      [...new Map(conflicts.map(c => [c.entryId, c])).values()], proposed);
    const err = new HttpError(409, "reschedule_conflict");
    err.details = {
      message: "整批改期存在冲突，已全部回滚，未改动任何排期",
      conflicts,
      alternatives: alt,
      version: batch.version
    };
    throw err;
  }

  // 整批替换：先动 entries 内存，再重建 schedules；任何一步抛错，store 恢复快照。
  const oldSchedules = state.schedules;
  state.schedules = oldSchedules.filter(sc => sc.batchId !== batch.id);
  for (const p of proposed) {
    const entry = batch.entries.find(e => e.id === p.entryId);
    entry.schedule = { id: "SC-" + ++state.seq, start: p.start, end: p.end };
    state.schedules.push({
      id: entry.schedule.id, batchId: batch.id, entryId: entry.id, shipId: batch.shipId,
      zone: entry.zone, userId: entry.userId, op: entry.op,
      start: p.start, end: p.end, status: "active"
    });
  }
  const at = nowIso();
  batch.version += 1;
  batch.history.push({ at, action: "reschedule", actorId, actorName: actor.name,
    note: `整批改期 ${proposed.length} 项（v${batch.version}）` });
  addAudit(state, { at, actorId, action: "batch.reschedule", batchId: batch.id,
    detail: { version: batch.version, count: proposed.length } });
  return { batch: summarizeBatch(batch) };
}

export function submitBatch(state, actorId, batchId, body = {}) {
  const actor = findUser(state, actorId);
  requireRole(actor, "batch.submit");
  const batch = findBatch(state, batchId);
  assertNotDelivered(batch);
  if (batch.ownerId !== actor.id) throw new HttpError(403, "forbidden_not_owner");
  if (![BATCH_STATUS.DRAFT, BATCH_STATUS.REJECTED].includes(batch.status)) {
    throw new HttpError(409, "batch_not_submittable", { status: batch.status });
  }
  if (typeof body.version === "number" && body.version !== batch.version) {
    throw new HttpError(409, "version_conflict", { expected: batch.version, got: body.version });
  }
  if (!batch.entries.every(e => e.schedule)) throw new HttpError(409, "unscheduled_entries");
  const at = nowIso();
  batch.status = BATCH_STATUS.SUBMITTED;
  batch.version += 1;
  batch.submittedAt = at;
  batch.history.push({ at, action: "submit", actorId, actorName: actor.name, note: "提交复核" });
  addAudit(state, { at, actorId, action: "batch.submit", batchId: batch.id, detail: { version: batch.version } });
  return { batch: summarizeBatch(batch) };
}

export function withdrawBatch(state, actorId, batchId) {
  const actor = findUser(state, actorId);
  requireRole(actor, "batch.withdraw");
  const batch = findBatch(state, batchId);
  assertNotDelivered(batch);
  if (batch.ownerId !== actor.id) throw new HttpError(403, "forbidden_not_owner");
  if (batch.status !== BATCH_STATUS.SUBMITTED) throw new HttpError(409, "batch_not_withdrawable", { status: batch.status });
  const at = nowIso();
  batch.status = BATCH_STATUS.DRAFT;
  batch.version += 1;
  batch.history.push({ at, action: "withdraw", actorId, actorName: actor.name, note: "撤回复核" });
  addAudit(state, { at, actorId, action: "batch.withdraw", batchId: batch.id, detail: {} });
  return { batch: summarizeBatch(batch) };
}

// 复核驳回：批次回到校准（保留全部排期与历次记录），原提交记录留在 history。
export function reviewBatch(state, actorId, batchId, decision, body = {}) {
  const actor = findUser(state, actorId);
  const action = decision === "approve" ? "batch.approve" : "batch.reject";
  requireRole(actor, action);
  const batch = findBatch(state, batchId);
  assertNotDelivered(batch);
  if (batch.status !== BATCH_STATUS.SUBMITTED) {
    throw new HttpError(409, "batch_not_in_review", { status: batch.status });
  }
  if (typeof body.version === "number" && body.version !== batch.version) {
    throw new HttpError(409, "version_conflict", { expected: batch.version, got: body.version });
  }
  const at = nowIso();
  if (decision === "approve") {
    batch.status = BATCH_STATUS.APPROVED;
    batch.reviewedAt = at;
    batch.reviewNote = body.note || "复核通过";
  } else {
    if (!body.note) throw new HttpError(400, "reject_note_required");
    batch.status = BATCH_STATUS.REJECTED;
    batch.reviewedAt = null;
    batch.reviewNote = body.note;
    // 排期保留；校准员据此改期后重新提交，原提交/驳回记录均保留。
  }
  batch.version += 1;
  batch.history.push({
    at, action, actorId, actorName: actor.name,
    note: decision === "approve" ? (body.note || "复核通过") : `驳回：${body.note}`
  });
  addAudit(state, { at, actorId, action, batchId: batch.id,
    detail: { note: body.note || "", toStatus: batch.status } });
  return { batch: summarizeBatch(batch) };
}

// 交付：终态，锁定一切写操作。
export function deliverBatch(state, actorId, batchId, body = {}) {
  const actor = findUser(state, actorId);
  requireRole(actor, "batch.deliver");
  const batch = findBatch(state, batchId);
  assertNotDelivered(batch);
  if (batch.status !== BATCH_STATUS.APPROVED) throw new HttpError(409, "batch_not_deliverable", { status: batch.status });
  if (typeof body.version === "number" && body.version !== batch.version) {
    throw new HttpError(409, "version_conflict", { expected: batch.version, got: body.version });
  }
  const at = nowIso();
  batch.status = BATCH_STATUS.DELIVERED;
  batch.deliveredAt = at;
  batch.version += 1;
  batch.history.push({ at, action: "deliver", actorId, actorName: actor.name, note: body.note || "确认交付" });
  addAudit(state, { at, actorId, action: "batch.deliver", batchId: batch.id, detail: { version: batch.version } });
  return { batch: summarizeBatch(batch) };
}
