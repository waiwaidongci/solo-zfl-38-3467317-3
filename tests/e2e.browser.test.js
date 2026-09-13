// 真实浏览器 E2E：校准员 → 复核员（驳回）→ 校准员（冲突改期回滚 + 采用替代时段 + 重提）→ 复核员通过 → 交付员交付锁定。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { chromium } from "playwright";
import { makeHarness, USERS } from "./helpers.js";

// 无 root 环境下把本地补齐的 Chromium 依赖库注入子进程环境。
const localLibs = join(homedir(), ".local", "playwright-libs");
if (existsSync(localLibs)) {
  const { execFileSync } = await import("node:child_process");
  const dirs = execFileSync("find", [localLibs, "-name", "*.so*", "-type", "f"])
    .toString().trim().split("\n").map(f => join(f, "..")).filter(Boolean);
  const uniq = [...new Set(dirs)].join(":");
  process.env.LD_LIBRARY_PATH = uniq + (process.env.LD_LIBRARY_PATH ? ":" + process.env.LD_LIBRARY_PATH : "");
}

let h, browser;
before(async () => {
  h = await makeHarness();
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
  await h.stop();
});

async function newContextAs(userId) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(h.base + "/");
  await page.waitForSelector("#who option", { state: "attached" });
  await page.selectOption("#who", userId);
  await page.waitForLoadState("networkidle");
  return { ctx, page };
}

test("真实浏览器：三角色协作、冲突回滚、驳回留痕、交付锁定", async () => {
  // ---- 校准员建批并自动排期 ----
  const cal = await newContextAs(USERS.zhou);
  await cal.page.fill(".p-pos", "前桅侧支索");
  await cal.page.fill("#fromTime", "2026-09-17T08:00");
  await cal.page.click("#createBtn");
  await cal.page.waitForSelector(".batch");
  const heading = await cal.page.textContent(".batch h3");
  const batchId = heading.split("·")[0].trim();
  await cal.page.waitForFunction((id) => {
    const b = document.getElementById(id);
    return b && b.querySelector(".pill").textContent === "待校准" &&
      b.querySelectorAll("input[data-k='start']").length === 1 &&
      b.querySelector("input[data-k='start']").value;
  }, batchId);
  // 待办里出现该批次。
  assert.ok((await cal.page.textContent("#todos")).includes(batchId));

  // ---- 越权请求在浏览器里被明确拒绝 ----
  const forbidden = await cal.page.evaluate(async () => {
    const r = await fetch("/api/batches/" + document.querySelector(".batch").id + "/deliver", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-User-Id": "U-SHEN" },
      body: "{}"
    });
    return { status: r.status, body: await r.json() };
  });
  assert.equal(forbidden.status, 403);
  assert.match(forbidden.body.details.message, /复核员无权/);

  // 复核员视角：没有建批面板，也没有任何批次操作按钮。
  const rev = await newContextAs(USERS.shen);
  assert.equal(await rev.page.isHidden("#createPanel"), true);
  assert.equal(await rev.page.locator("[data-act='approve']").count(), 0, "批次未提交时复核员无按钮");

  // ---- 校准员提交复核 ----
  await cal.page.click(`[data-act='submit'][data-b='${batchId}']`);
  await cal.page.waitForSelector(`#${batchId} .s-待复核`);
  // 提交后输入框消失（只读时段）。
  assert.equal(await cal.page.locator(`#${batchId} input[data-e]`).count(), 0);

  // ---- 复核员待办出现并驳回（必须填原因）----
  await rev.page.reload();
  await rev.page.waitForSelector("#todos .todo");
  assert.ok((await rev.page.textContent("#todos")).includes(batchId));
  await rev.page.once("dialog", d => d.accept("张力记录缺失，请回校准"));
  await rev.page.click(`[data-act='reject'][data-b='${batchId}']`);
  await rev.page.waitForSelector(`#${batchId} .s-已驳回`);
  // 回到校准，原提交和驳回记录都保留。
  const hist = await rev.page.textContent(`#${batchId} .hist`);
  assert.match(hist, /驳回：张力记录缺失/);
  assert.match(hist, /提交复核/);

  // ---- 校准员：整批改期撞种子占用 → 列冲突+替代时段且全部回滚 ----
  await cal.page.reload();
  await cal.page.waitForSelector(`#${batchId}.s-已驳回, #${batchId} .s-已驳回`);
  const startInput = `#${batchId} input[data-k='start']`;
  const endInput = `#${batchId} input[data-k='end']`;
  await cal.page.fill(startInput, "2026-09-15T09:00");
  await cal.page.fill(endInput, "2026-09-15T10:00");
  await cal.page.click(`[data-act='resched'][data-b='${batchId}']`);
  await cal.page.waitForSelector(`#cf-${batchId} .conflictbox`);
  const box = await cal.page.textContent(`#cf-${batchId}`);
  assert.match(box, /全部回滚/);
  assert.match(box, /桅区|撞人|占用/);
  assert.match(box, /替代时段/);
  // 回滚后输入框仍为用户填的冲突值、卡片仍是已驳回、无新版本成功记录。
  assert.equal(await cal.page.inputValue(startInput), "2026-09-15T09:00");

  // 点替代时段自动回填，再次整批改期成功。
  await cal.page.click(`#cf-${batchId} [data-fill]`);
  const filled = await cal.page.inputValue(startInput);
  assert.ok(filled.startsWith("2026-09-1"), filled);
  await cal.page.click(`[data-act='resched'][data-b='${batchId}']`);
  await cal.page.waitForFunction((id) => {
    const t = document.querySelector("#toast");
    return t.textContent.includes("整批改期成功") && !document.querySelector("#cf-" + id + " .conflictbox");
  }, batchId);

  // ---- 重新提交 → 复核通过 → 交付 ----
  await cal.page.click(`[data-act='submit'][data-b='${batchId}']`);
  await cal.page.waitForSelector(`#${batchId} .s-待复核`);

  await rev.page.reload();
  await rev.page.waitForSelector(`[data-act='approve'][data-b='${batchId}']`);
  await rev.page.once("dialog", d => d.accept(""));
  await rev.page.click(`[data-act='approve'][data-b='${batchId}']`);
  await rev.page.waitForSelector(`#${batchId} .s-复核通过`);
  // 复核员视角无交付按钮。
  assert.equal(await rev.page.locator(`[data-act='deliver'][data-b='${batchId}']`).count(), 0);

  const del = await newContextAs(USERS.zheng);
  await del.page.waitForSelector("#todos .todo");
  assert.ok((await del.page.textContent("#todos")).includes(batchId), "交付员待办包含复核通过批次");
  assert.equal(await del.page.isHidden("#createPanel"), true);
  await del.page.click(`[data-act='deliver'][data-b='${batchId}']`);
  await del.page.waitForSelector(`#${batchId} .s-已交付`);
  const card = await del.page.textContent(`#${batchId}`);
  assert.match(card, /已交付锁定/);
  assert.equal(await del.page.locator(`#${batchId} [data-act]`).count(), 0, "交付后无任何操作按钮");
  assert.equal(await del.page.locator("#todos .todo").count(), 0, "交付后待办清空");

  // ---- 交付锁定：浏览器内改期请求被服务端拒绝 ----
  const locked = await cal.page.evaluate(async (id) => {
    const r = await fetch(`/api/batches/${id}/reschedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-User-Id": "U-ZHOU" },
      body: JSON.stringify({ version: 1, schedules: [] })
    });
    return { status: r.status, body: await r.json() };
  }, batchId);
  assert.equal(locked.status, 409);
  assert.equal(locked.body.error, "batch_delivered_locked");

  // ---- 日历与审计：三角色都能看到占用与全链路轨迹 ----
  await del.page.reload();
  await del.page.waitForSelector(".cal .ev");
  assert.ok((await del.page.locator(".cal .ev").count()) >= 2, "冲突日历有占用事件");
  await del.page.waitForSelector("#audit div");
  const audit = await del.page.textContent("#audit");
  for (const word of ["batch.create", "batch.reject", "batch.reschedule", "batch.approve", "batch.deliver"]) {
    assert.ok(audit.includes(word), "审计缺少 " + word);
  }
  // 审计里动作带有角色姓名。
  assert.match(audit, /周宁/);
  assert.match(audit, /沈渭/);
  assert.match(audit, /郑合/);

  await cal.ctx.close(); await rev.ctx.close(); await del.ctx.close();
});
