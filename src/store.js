// 持久化层：JSON 文件存储，进程内写互斥锁 + 临时文件原子替换，保证整批改期要么全部落盘要么全部不变。
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const defaultDbPath = join(__dirname, "..", "data", "dispatch.json");
const legacyDbPath = join(__dirname, "..", "data", "model-rigging-calibration.json");

// 初始数据：三角色账号、两艘待排期的船、既有占用（负责人请假/其他工单与桅区占用）。
export function seedState() {
  return {
    version: 2,
    seq: 4,
    users: [
      { id: "U-ZHOU", name: "周宁", role: "calibrator" },
      { id: "U-LIN", name: "林锚", role: "calibrator" },
      { id: "U-SHEN", name: "沈渭", role: "reviewer" },
      { id: "U-ZHENG", name: "郑合", role: "deliverer" }
    ],
    ships: [
      {
        id: "S-1",
        code: "MR-001",
        shipType: "福船",
        scale: "1:48",
        mastCount: 3,
        riggingMaterial: "蜡线",
        dueDate: "2026-09-30",
        zones: ["前桅", "中桅", "后桅"]
      },
      {
        id: "S-2",
        code: "MR-002",
        shipType: "广船",
        scale: "1:64",
        mastCount: 2,
        riggingMaterial: "丝线",
        dueDate: "2026-10-15",
        zones: ["前桅", "后桅"]
      }
    ],
    // 帆索校准工序库：after 表达工序依赖（前置工序必须排在前面）。
    operations: [
      { key: "勘验", durationMinutes: 60, after: [] },
      { key: "初调", durationMinutes: 90, after: ["勘验"] },
      { key: "张紧", durationMinutes: 60, after: ["初调"] },
      { key: "拉力复测", durationMinutes: 45, after: ["张紧"] }
    ],
    // 负责人工作日排期：09:00-12:00、13:30-18:00，分钟粒度。
    calendars: [
      { userId: "U-ZHOU", workMinutes: [540, 720], breakMinutes: [[720, 810]], blocked: [
        { start: "2026-09-14T09:00", end: "2026-09-14T10:30", reason: "船坞例会" }
      ] },
      { userId: "U-LIN", workMinutes: [540, 720], breakMinutes: [[720, 810]], blocked: [] },
      { userId: "U-SHEN", workMinutes: [540, 720], breakMinutes: [[720, 810]], blocked: [] },
      { userId: "U-ZHENG", workMinutes: [540, 720], breakMinutes: [[720, 810]], blocked: [] }
    ],
    batches: [],
    // 既有桅区/负责人占用：排期时一律视作冲突（seed 中为上周已开工的校准单 B-SEED 与一条桅区封修）。
    schedules: [
      { id: "SC-SEED-1", batchId: "B-SEED", entryId: "SEED", shipId: "S-1", zone: "前桅", userId: "U-ZHOU",
        op: "初调", start: "2026-09-15T09:00", end: "2026-09-15T10:30", status: "active" },
      { id: "SC-SEED-2", batchId: "B-ZONE-FIX", entryId: "FIX", shipId: null, zone: "中桅", userId: null,
        op: "桅区封修", start: "2026-09-16T13:30", end: "2026-09-16T17:00", status: "active" }
    ],
    idempotency: {},
    audit: []
  };
}

// 旧原型数据迁移：把原 items 转成船档案。
function migrate(old) {
  const state = seedState();
  if (Array.isArray(old.items)) {
    for (const it of old.items) {
      if (!state.ships.some(s => s.code === it.code)) {
        state.ships.push({
          id: "S-" + state.seq++,
          code: it.code || "MR-OLD",
          shipType: it.shipType || "未登记船型",
          scale: it.scale || "",
          mastCount: Number(it.mastCount) || 1,
          riggingMaterial: it.riggingMaterial || "",
          dueDate: it.dueDate || "",
          zones: []
        });
      }
    }
  }
  return state;
}

export class Store {
  constructor(dbPath = process.env.DB_PATH || defaultDbPath) {
    this.dbPath = dbPath;
    this.locked = Promise.resolve();
  }

  async load() {
    if (!this.state) {
      if (!existsSync(this.dbPath)) {
        if (existsSync(legacyDbPath) && this.dbPath === defaultDbPath) {
          const old = JSON.parse(await readFile(legacyDbPath, "utf8"));
          this.state = migrate(old);
        } else {
          this.state = seedState();
        }
        await this.persist();
      } else {
        this.state = JSON.parse(await readFile(this.dbPath, "utf8"));
      }
    }
    return this.state;
  }

  async persist() {
    await mkdir(dirname(this.dbPath), { recursive: true });
    const tmp = `${this.dbPath}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
    await rename(tmp, this.dbPath); // 同目录原子替换，重启不会读到半文件
  }

  // 串行化所有读改写；mutation 返回值原样透传，抛错则不写盘（整批回滚）。
  async mutate(fn) {
    const run = this.locked.then(async () => {
      await this.load();
      const snapshot = JSON.stringify(this.state);
      try {
        const result = await fn(this.state);
        await this.persist();
        return result;
      } catch (err) {
        this.state = JSON.parse(snapshot);
        throw err;
      }
    });
    this.locked = run.catch(() => {});
    return run;
  }

  // 只读访问：串行执行但绝不写盘。
  async read(fn) {
    await this.load();
    return fn(this.state);
  }
}
