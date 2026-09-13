// 旧库结构升级：workMinutes（仅上午单窗口）→ workWindows（上午+下午双窗口，午休拆开）。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Store } from "../src/store.js";
import { autoSchedule } from "../src/domain.js";

// 与 seedState 等价但日历故意使用旧字段 workMinutes（上午 09-12 + 午休 12-13:30）。
function oldShapeState() {
  return {
    version: 2, seq: 2,
    users: [
      { id: "U-ZHOU", name: "周宁", role: "calibrator" },
      { id: "U-SHEN", name: "沈渭", role: "reviewer" },
      { id: "U-ZHENG", name: "郑合", role: "deliverer" }
    ],
    ships: [{ id: "S-9", code: "MR-009", shipType: "福船", scale: "1:48", mastCount: 1,
      riggingMaterial: "蜡线", dueDate: "", zones: ["前桅"] }],
    operations: [{ key: "勘验", durationMinutes: 60, after: [] }],
    calendars: [{ userId: "U-ZHOU", workMinutes: [540, 720], breakMinutes: [[720, 810]], blocked: [] }],
    batches: [{
      id: "B-1", shipId: "S-9", shipCode: "MR-009", ownerId: "U-ZHOU", ownerName: "周宁",
      status: "待校准", version: 1, createdAt: "", submittedAt: null, reviewedAt: null, deliveredAt: null,
      entries: [{ id: "E-1", position: "支索", zone: "前桅", op: "勘验", userId: "U-ZHOU", schedule: null }],
      history: []
    }],
    schedules: [], idempotency: {}, audit: []
  };
}

let dir, dbPath, store;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "rigging-migrate-"));
  dbPath = join(dir, "dispatch.json");
  await mkdir(dirname(dbPath), { recursive: true });
  await writeFile(dbPath, JSON.stringify(oldShapeState()));
  store = new Store(dbPath);
});
after(async () => { await rm(dir, { recursive: true, force: true }); });

test("旧 workMinutes 库升级为上午+下午双窗口，下午可排、午休不可排", async () => {
  const result = await store.mutate(state => {
    autoSchedule(state, "U-ZHOU", "B-1", { version: 1, from: "2026-11-16T08:00" });
    const cal = state.calendars[0];
    return {
      windows: cal.workWindows,
      start: state.batches[0].entries[0].schedule.start,
      end: state.batches[0].entries[0].schedule.end
    };
  });
  // 旧 [540,720] 被午休 [720,810] 拆成上午 [540,720] 与下午 [810,1080]。
  assert.deepEqual(result.windows, [[540, 720], [810, 1080]]);
  assert.equal(result.start, "2026-11-16T09:00");
  assert.equal(result.end, "2026-11-16T10:00");
});
