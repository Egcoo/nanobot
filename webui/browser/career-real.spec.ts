import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { test, expect, type Page } from "@playwright/test";

const repo = path.resolve(import.meta.dirname, "../..");
const root = mkdtempSync(path.join(tmpdir(), "nanobot-career-browser-"));
let server: ChildProcessWithoutNullStreams;
let base: string;
let port: number;

async function start() {
  const python = process.env.NANOBOT_TEST_PYTHON ?? path.join(repo, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
  server = spawn(python, ["-X", "utf8", "-m", "scripts.career_browser_gateway", "--root", root, "--port", String(port)], {
    cwd: repo, windowsHide: true, stdio: "pipe",
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Career test gateway startup timed out")), 20_000);
    let logs = "";
    server.stderr.on("data", (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-3000); });
    server.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("CAREER_BROWSER_READY")) { clearTimeout(timeout); resolve(); }
    });
    server.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Career test gateway exited (${code}): ${logs}`)); });
    server.once("error", reject);
  });
}
async function stop() {
  if (server.exitCode !== null) return;
  const exited = once(server, "exit");
  server.stdin.end("stop\n");
  await exited;
}
function nav(page: Page, name: string) { return page.getByRole("navigation", { name: "求职页面" }).getByRole("button", { name, exact: true }); }

test.beforeAll(async () => {
  const socket = net.createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("No local test port");
  port = address.port; await new Promise<void>((resolve) => socket.close(() => resolve()));
  base = `http://127.0.0.1:${port}`;
  await start();
});
test.afterAll(async () => { if (server) await stop(); });

test("real WebUI saves versions and preparation bindings across refresh, workspace changes and gateway restart", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.addInitScript(() => {
    localStorage.setItem("nanobot.locale", "zh-CN");
    if (!localStorage.getItem("nanobot-webui.theme")) localStorage.setItem("nanobot-webui.theme", "dark");
  });
  await page.goto(`${base}/#/career`);
  await expect(page.getByRole("heading", { name: "求职工作台" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "这次求职，从哪里开始？" })).toBeVisible();
  await expect(page.getByRole("region", { name: "求职对话" }).getByRole("textbox")).toBeDisabled();
  await page.screenshot({ path: info.outputPath("career-empty.png"), fullPage: true });
  await nav(page, "我的简历").click();
  let form = page.getByRole("form", { name: "简历编辑" });
  await form.getByLabel("名称", { exact: true }).fill("工程通用版");
  await form.getByLabel("简历正文").fill("工程测试：做过原型设计，用户访谈经历待确认。");
  await form.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(form.getByRole("button", { name: "确认使用" })).toBeEnabled();
  const firstTimestamp = page.getByRole("list", { name: "简历版本" }).getByRole("button", { name: /工程通用版/ }).locator("time");
  await expect(firstTimestamp).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);
  const firstAddedAt = await firstTimestamp.getAttribute("datetime");
  await form.getByRole("button", { name: "确认使用" }).click();
  await expect(form.getByLabel("简历正文")).toHaveAttribute("readonly");
  await form.getByRole("button", { name: "另存新版" }).click();
  await form.getByLabel("名称", { exact: true }).fill("工程AI版");
  await form.getByLabel("简历正文").fill("工程测试：新增 AI 评测练习。");
  await form.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(form.getByRole("button", { name: "确认使用" })).toBeEnabled();
  await form.getByRole("button", { name: "确认使用" }).click();
  await expect(form.getByLabel("简历正文")).toHaveAttribute("readonly");

  await nav(page, "岗位库").click();
  form = page.getByRole("form", { name: "岗位编辑" });
  for (const name of ["工程岗位A", "工程岗位B"]) {
    await page.getByRole("button", { name: "新增岗位", exact: true }).click();
    await form.getByLabel("岗位名称").fill(name);
    await form.getByLabel("岗位原文").fill(`工程测试：${name}，参与原型设计与评测。`);
    await form.getByRole("button", { name: "保存草稿", exact: true }).click();
    await expect(form.getByRole("button", { name: "确认使用" })).toBeEnabled();
    await form.getByRole("button", { name: "确认使用" }).click();
    await expect(form.getByLabel("岗位原文")).toHaveAttribute("readonly");
  }
  await nav(page, "工作台").click();
  form = page.getByRole("form", { name: "选择准备资料" });
  await form.getByLabel("简历版本").selectOption({ label: "工程通用版 · v1" });
  await form.getByLabel("岗位版本").selectOption({ label: "工程岗位A · v1" });
  await form.getByText("到岗条件（选填）", { exact: true }).click();
  await form.getByLabel("每周到岗天数（选填）").fill("3");
  await form.getByRole("button", { name: "进入准备记录" }).click();
  await expect(page.getByRole("region", { name: "当前准备" })).toContainText("工程通用版 · v1 → 工程岗位A · v1");
  const originalUrl = page.url();
  await page.getByRole("button", { name: "更换资料", exact: true }).click();
  form = page.getByRole("form", { name: "选择准备资料" });
  await form.getByLabel("简历版本").selectOption({ label: "工程AI版 · v2" });
  await form.getByLabel("岗位版本").selectOption({ label: "工程岗位B · v1" });
  await form.getByRole("button", { name: "进入准备记录" }).click();
  await expect(page.getByRole("region", { name: "当前准备" })).toContainText("工程AI版 · v2 → 工程岗位B · v1");
  await page.getByRole("region", { name: "准备记录" }).getByRole("button", { name: /工程通用版/ }).click();
  await expect(page).toHaveURL(originalUrl);
  await nav(page, "我的简历").click();
  await page.getByRole("list", { name: "简历版本" }).getByRole("button", { name: /工程AI版/ }).click();
  await expect(page).toHaveURL(originalUrl);
  await page.reload();
  await expect(page.getByRole("region", { name: "当前准备" })).toContainText("工程通用版 · v1 → 工程岗位A · v1");
  await page.getByRole("button", { name: "新建准备", exact: true }).click();
  await expect(page.getByText("尚未选择准备记录。", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "准备记录" }).getByRole("button", { name: /工程通用版/ })).toBeVisible();
  await page.getByRole("region", { name: "准备记录" }).getByRole("button", { name: /工程通用版/ }).click();
  await expect(page).toHaveURL(originalUrl);
  await nav(page, "准备清单").click();
  await expect(page.getByText("还没有正式任务", { exact: true })).toBeVisible();
  const workspace = page.getByLabel("工作区", { exact: true });
  await workspace.selectOption({ label: "other-workspace" });
  await nav(page, "我的简历").click();
  await expect(page.getByText("还没有简历，先添加一份文字草稿。", { exact: true })).toBeVisible();
  await page.goto(originalUrl);
  await stop(); await start();
  await page.reload();
  await expect(page.getByRole("region", { name: "当前准备" })).toContainText("工程通用版 · v1 → 工程岗位A · v1");
  await page.screenshot({ path: info.outputPath("career-workbench.png"), fullPage: true });
  await page.evaluate(() => localStorage.setItem("nanobot-webui.theme", "light"));
  await page.reload();
  await expect(page.getByRole("region", { name: "当前准备" })).toContainText("工程通用版 · v1 → 工程岗位A · v1");
  await page.screenshot({ path: info.outputPath("career-light.png"), fullPage: true });
  await nav(page, "我的简历").click();
  await page.getByRole("list", { name: "简历版本" }).getByRole("button", { name: /工程AI版/ }).click();
  expect(await page.getByRole("list", { name: "简历版本" }).getByRole("button", { name: /工程通用版/ }).locator("time").getAttribute("datetime")).toBe(firstAddedAt);
  await page.screenshot({ path: info.outputPath("career-resumes.png"), fullPage: true });
  await nav(page, "工作台").click();
  await page.setViewportSize({ width: 320, height: 760 });
  await expect(page.getByRole("heading", { name: "求职工作台" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("career-mobile.png"), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${base}/#/chat/${encodeURIComponent("websocket:ordinary")}`);
  await expect(page.getByText("工程测试：原有聊天历史仍然可读。", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
