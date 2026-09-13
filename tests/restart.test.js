// 重启持久化：以子进程起服务 → 建批排期交付 → 杀进程 → 同 DB 重启 → 数据仍在。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const USERS = { zhou: "U-ZHOU", shen: "U-SHEN", zheng: "U-ZHENG" };

async function waitUp(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/overview`);
      if (res.ok) return;
    } catch { /* 尚未监听 */ }
    await new Promise(r => setTimeout(r, 120));
  }
  throw new Error("server did not start");
}
function startChild(dbPath, port) {
  const child = spawn(process.execPath, [join(root, "server.js")], {
    cwd: root,
    env: { ...process.env, DB_PATH: dbPath, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", d => process.stderr.write(d));
  return child;
}
async function stopChild(child) {
  await new Promise(resolve => {
    child.on("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => !child.killed && child.kill("SIGKILL"), 3000);
  });
}
async function api(port, method, path, userId, body, idem) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (userId) headers["x-user-id"] = userId;
  if (idem) headers["idempotency-key"] = idem;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

test("重启服务后批次、排期、交付锁定与审计全部保留", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rigging-restart-"));
  const dbPath = join(dir, "dispatch.json");
  const port = 3199;
  let child = startChild(dbPath, port);
  try {
    await waitUp(port);

    const created = await api(port, "POST", "/api/batches", USERS.zhou, {
      shipId: "S-2",
      entries: [
        { position: "前桅侧支索", zone: "前桅", op: "勘验", userId: USERS.zhou },
        { position: "前桅侧支索", zone: "前桅", op: "初调", userId: USERS.zhou }
      ]
    }, "restart-key-1");
    const id = created.json.batch.id;
    await api(port, "POST", `/api/batches/${id}/auto-schedule`, USERS.zhou, { from: "2026-09-17T08:00" });
    let ov = (await api(port, "GET", `/api/overview?userId=${USERS.zhou}`)).json;
    const submittedVersion = ov.batches.find(b => b.id === id).version;
    await api(port, "POST", `/api/batches/${id}/submit`, USERS.zhou, { version: submittedVersion });
    ov = (await api(port, "GET", "/api/overview")).json;
    const reviewVersion = ov.batches.find(b => b.id === id).version;
    await api(port, "POST", `/api/batches/${id}/review`, USERS.shen, { decision: "approve", version: reviewVersion });
    ov = (await api(port, "GET", "/api/overview")).json;
    const approveVersion = ov.batches.find(b => b.id === id).version;
    await api(port, "POST", `/api/batches/${id}/deliver`, USERS.zheng, { version: approveVersion });

    // 杀掉进程，模拟服务重启。
    await stopChild(child);

    child = startChild(dbPath, port);
    await waitUp(port);

    ov = (await api(port, "GET", "/api/overview")).json;
    const b = ov.batches.find(x => x.id === id);
    assert.ok(b, "重启后批次仍在");
    assert.equal(b.status, "已交付");
    assert.equal(b.entries.length, 2);
    assert.ok(b.entries.every(e => e.start && e.end), "排期保留");
    assert.ok(b.deliveredAt, "交付时间保留");
    assert.ok(b.history.length >= 5, "完整历史保留");
    assert.ok(ov.audit.some(a => a.action === "batch.deliver" && a.batchId === id), "审计保留");

    // 交付锁定在重启后依旧生效。
    const locked = await api(port, "POST", `/api/batches/${id}/reschedule`, USERS.zhou, {
      version: b.version,
      schedules: b.entries.map(e => ({ entryId: e.id, start: e.start, end: e.end }))
    });
    assert.equal(locked.status, 409);
    assert.equal(locked.json.error, "batch_delivered_locked");

    // 幂等记录持久化：重启后同键重复提交不产生第二条。
    const replay = await api(port, "POST", "/api/batches", USERS.zhou, {
      shipId: "S-2",
      entries: [{ position: "前桅侧支索", zone: "前桅", op: "勘验", userId: USERS.zhou }]
    }, "restart-key-1");
    assert.equal(replay.json.batch.id, id, "同幂等键回放首批次");
    const finalOv = (await api(port, "GET", "/api/overview")).json;
    assert.equal(finalOv.batches.filter(x => x.id === id).length, 1);
  } finally {
    await stopChild(child).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
