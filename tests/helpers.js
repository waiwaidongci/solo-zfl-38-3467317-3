// 测试公共工具：临时 DB、随机端口、带角色头的 fetch 客户端。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const USERS = {
  zhou: "U-ZHOU",    // 校准员 周宁
  lin: "U-LIN",      // 校准员 林锚
  shen: "U-SHEN",    // 复核员 沈渭
  zheng: "U-ZHENG"   // 交付员 郑合
};

export async function makeHarness() {
  const dir = await mkdtemp(join(tmpdir(), "rigging-"));
  process.env.DB_PATH = join(dir, "dispatch.json");
  const { start, server } = await import("../server.js");
  const { port } = await start(0);
  const base = `http://127.0.0.1:${port}`;

  async function call(method, path, body, opts = {}) {
    const headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (opts.userId) headers["x-user-id"] = opts.userId;
    if (opts.idem) headers["idempotency-key"] = opts.idem;
    const res = await fetch(base + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json, headers: res.headers };
  }

  return {
    base,
    dir,
    call,
    async overview(userId) {
      const { json } = await call("GET", "/api/overview" + (userId ? `?userId=${userId}` : ""));
      return json;
    },
    async stop() {
      await new Promise(resolve => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    }
  };
}

// 常用业务流：建批 → 自动排期 → 提交复核，返回各阶段 id/version。
export async function createScheduledSubmitted(h, {
  from = "2026-09-17T08:00", userId = USERS.zhou, workerId = userId, shipId = "S-2", zone = "前桅", position = "前桅侧支索"
} = {}) {
  const entries = [
    { position, zone, op: "勘验", userId: workerId },
    { position, zone, op: "初调", userId: workerId }
  ];
  const created = await h.call("POST", "/api/batches", { shipId, entries }, { userId, idem: "k-" + Math.random() });
  const batch = created.json.batch;
  await h.call("POST", `/api/batches/${batch.id}/auto-schedule`, { from }, { userId });
  const submitted = await h.call("POST", `/api/batches/${batch.id}/submit`, {}, { userId });
  return { batch, final: submitted.json.batch };
}
