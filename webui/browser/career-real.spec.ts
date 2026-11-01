import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { randomInt } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";

const repo = path.resolve(import.meta.dirname, "../..");
let root: string;
let server: ChildProcessWithoutNullStreams;
let base: string;
let port: number;

async function start() {
  const python = process.env.NANOBOT_TEST_PYTHON ?? path.join(repo, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
  server = spawn(python, ["-X", "utf8", "-m", "scripts.career_browser_gateway", "--root", root, "--port", String(port),
    ...(process.env.NANOBOT_CAREER_LIVE_MODEL === "1" ? ["--configured-model"] : [])], {
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

test.beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "nanobot-career-browser-"));
  // Avoid OS-selected low ports such as 5061, which Chrome blocks for HTTP.
  port = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    const socket = net.createServer();
    const candidate = randomInt(20_000, 60_000);
    try {
      socket.listen(candidate, "127.0.0.1");
      await once(socket, "listening");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      continue;
    }
    port = candidate;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    break;
  }
  if (!port) throw new Error("No local test port available");
  base = `http://127.0.0.1:${port}`;
  await start();
});
test.afterEach(async () => { if (server) await stop(); });

async function prepareConversation(page: Page) {
  await page.addInitScript(() => { localStorage.setItem("nanobot.locale", "zh-CN"); localStorage.setItem("nanobot-webui.theme", "dark"); });
  await page.goto(`${base}/#/career`);
  await nav(page, "我的简历").click();
  const resume = page.getByRole("form", { name: "简历编辑" });
  await resume.getByLabel("名称", { exact: true }).fill("工程对话简历");
  await resume.getByLabel("简历正文").fill("工程虚构资料：唯一项目代号 CV_A7，做过一个课程资料问答助手。用户访谈经历尚未说明。\n到岗安排：每周 4 天，连续 3 个月。\n邮箱：private@example.com\n手机：13800138000");
  await resume.getByRole("button", { name: "保存草稿", exact: true }).click();
  await resume.getByRole("button", { name: "确认使用", exact: true }).click();
  await expect(resume.getByLabel("简历正文")).toHaveAttribute("readonly");
  await nav(page, "岗位库").click();
  const job = page.getByRole("form", { name: "岗位编辑" });
  await job.getByLabel("岗位名称").fill("JOB_B4");
  await job.getByLabel("岗位原文").fill("工程虚构岗位 JOB_B4：AI 产品经理实习生，要求用户访谈经历，每周至少 4 天，连续 3 个月。");
  await job.getByRole("button", { name: "保存草稿", exact: true }).click();
  await job.getByRole("button", { name: "确认使用", exact: true }).click();
  await expect(job.getByLabel("岗位原文")).toHaveAttribute("readonly");
  await nav(page, "工作台").click();
  const choose = page.getByRole("form", { name: "选择准备资料" });
  await choose.getByLabel("简历版本").selectOption({ label: "工程对话简历 · v1" });
  await choose.getByLabel("岗位版本").selectOption({ label: "JOB_B4 · v1" });
  await choose.getByText("到岗条件（选填）", { exact: true }).click();
  await choose.getByLabel("每周到岗天数（选填）").fill("3");
  await choose.getByRole("button", { name: "进入准备记录" }).click();
  await expect(page.getByRole("textbox", { name: "向求职助手提问" })).toBeEnabled();
}

test("career conversation sends the selected materials and preserves sources across replies and reload", async ({ page }, info) => {
  test.setTimeout(process.env.NANOBOT_CAREER_LIVE_MODEL === "1" ? 180_000 : 90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1100 });
  await prepareConversation(page);
  const conversation = page.getByRole("region", { name: "求职对话" });
  await conversation.getByText("查看本次参考资料", { exact: true }).click();
  await expect(conversation).toContainText("CV_A7");
  await expect(conversation.getByRole("region", { name: "本次到岗条件" })).toContainText("每周 3 天");
  await expect(conversation.getByRole("note")).toContainText("本次填写：每周 3 天；简历原文：每周 4 天。");
  await expect(page.locator("p").filter({ hasText: "工程虚构资料：唯一项目代号 CV_A7" })).toHaveCount(1);
  await expect(conversation).not.toContainText("private@example.com");
  await expect(conversation).not.toContainText("13800138000");
  await page.screenshot({ path: info.outputPath("career-reference-materials.png"), fullPage: true });
  await page.setViewportSize({ width: 320, height: 1000 });
  await expect(conversation.getByRole("region", { name: "本次到岗条件" })).toContainText("每周 3 天");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("career-reference-materials-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await conversation.getByText("查看本次参考资料", { exact: true }).click();
  await conversation.getByRole("textbox", { name: "向求职助手提问" }).fill("请告诉我本次简历里的唯一项目代号，以及岗位原文里的岗位代号。只回答两个代号，控制在 60 字内。");
  await conversation.getByRole("button", { name: "发送", exact: true }).click();
  await expect(conversation.getByTestId("career-turn-source")).toHaveCount(1, { timeout: 90_000 });
  await expect(conversation.getByRole("button", { name: "发送", exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(conversation.getByTestId("career-turn-source").first()).toHaveAttribute("data-analysis-status", "succeeded");
  await expect(conversation.locator('[data-assistant-selectable="true"]').first()).toContainText("CV_A7");
  await expect(conversation.locator('[data-assistant-selectable="true"]').first()).toContainText("JOB_B4");
  await conversation.getByRole("textbox", { name: "向求职助手提问" }).fill("岗位要求用户访谈，但简历没有写。请先问我一个访谈澄清问题，不要把缺失信息当成没有经验。控制在 80 字内。");
  await conversation.getByRole("button", { name: "发送", exact: true }).click();
  await expect(conversation.getByTestId("career-turn-source")).toHaveCount(2, { timeout: 90_000 });
  await expect(conversation.getByRole("button", { name: "发送", exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(conversation.getByTestId("career-turn-source").last()).toHaveAttribute("data-analysis-status", "succeeded");
  await expect(conversation.locator('[data-assistant-selectable="true"]').last()).toContainText("访谈");
  await page.screenshot({ path: info.outputPath("career-conversation.png"), fullPage: true });
  await page.reload();
  await expect(conversation.getByRole("textbox", { name: "向求职助手提问" })).toBeEnabled();
  // Real reasoning streams can span more than the first 40 history events.
  for (let older = 0; older < 20 && await conversation.getByTestId("career-turn-source").count() < 2; older++) {
    const load = conversation.getByRole("button", { name: "加载更早的消息" });
    if (!await load.isVisible()) break;
    await load.click();
    await expect(load.and(page.locator(":disabled"))).toHaveCount(0);
  }
  await expect(conversation.getByTestId("career-turn-source")).toHaveCount(2);
  await expect(conversation).toContainText("CV_A7");
  // Opening the same career session in ordinary chat must not leave two owners.
  await page.getByRole("button", { name: /@.*工程对话简历 → JOB_B4/ }).click();
  await expect(page).toHaveURL(/#\/chat\//);
  await page.getByRole("button", { name: "求职工作台", exact: true }).click();
  await expect(conversation.getByRole("textbox", { name: "向求职助手提问" })).toBeEnabled();
  expect(errors).toEqual([]);
});

test("cancelling a career reply preserves its materials and permits another question", async ({ page }) => {
  test.skip(process.env.NANOBOT_CAREER_LIVE_MODEL === "1", "Latency and cancellation use the engineering provider only.");
  await prepareConversation(page);
  const conversation = page.getByRole("region", { name: "求职对话" });
  await conversation.getByRole("textbox", { name: "向求职助手提问" }).fill("WAIT_FOR_CANCEL");
  await conversation.getByRole("button", { name: "发送", exact: true }).click();
  await conversation.getByRole("button", { name: "停止回复" }).click();
  await expect(conversation.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  await conversation.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(conversation.getByTestId("career-turn-source").first()).toHaveAttribute("data-analysis-status", "cancelled");
  await conversation.getByRole("textbox", { name: "向求职助手提问" }).fill("请告诉我项目代号。");
  await conversation.getByRole("button", { name: "发送", exact: true }).click();
  await expect(conversation).toContainText("工程测试回复：项目代号 CV_A7", { timeout: 15_000 });
  await expect(page.getByRole("region", { name: "当前准备" })).toContainText("工程对话简历 · v1 → JOB_B4 · v1");
});

test("deleting the selected career chat removes its preparation but retains shared materials", async ({ page }, info) => {
  test.skip(process.env.NANOBOT_CAREER_LIVE_MODEL === "1", "Deletion uses disposable engineering data only.");
  await prepareConversation(page);
  const previous = new URLSearchParams(new URL(page.url()).hash.split("?")[1]);
  const oldPreparation = previous.get("preparation");
  const conversation = page.getByRole("region", { name: "求职对话" });
  await conversation.getByRole("textbox", { name: "向求职助手提问" }).fill("请告诉我项目代号。");
  await conversation.getByRole("button", { name: "发送", exact: true }).click();
  await expect(conversation.getByTestId("career-turn-source")).toHaveAttribute("data-analysis-status", "succeeded");
  // Make this the active ordinary topic too, then return to the workbench.
  await page.getByRole("button", { name: /@.*工程对话简历 → JOB_B4/ }).click();
  await page.getByRole("button", { name: "求职工作台", exact: true }).click();
  const actions = page.getByRole("button", { name: /工程对话简历 → JOB_B4.*话题操作/ });
  await actions.click();
  await page.getByRole("menuitem", { name: /删除/ }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("对应准备记录和关联清单将一并从工作台移除，简历及岗位库中的资料保留。");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("region", { name: "当前准备" })).toContainText("工程对话简历 · v1 → JOB_B4 · v1");
  await actions.click();
  await page.getByRole("menuitem", { name: /删除/ }).click();
  await dialog.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page).toHaveURL(`${base}/#/career?workspace=${previous.get("workspace")}`);
  await expect(page.getByRole("region", { name: "准备记录" })).toContainText("还没有准备记录。");
  await expect(page.getByRole("region", { name: "当前准备" })).toContainText("尚未选择准备记录。");
  await page.screenshot({ path: info.outputPath("career-deleted-preparation.png"), fullPage: true });
  await stop(); await start(); await page.reload();
  await expect(page.getByRole("region", { name: "准备记录" })).toContainText("还没有准备记录。");
  await nav(page, "我的简历").click();
  const retainedResume = page.getByRole("list", { name: "简历版本" }).getByRole("button", { name: /工程对话简历/ });
  await expect(retainedResume).toHaveCount(1);
  await expect(retainedResume).toContainText("v1");
  await retainedResume.click();
  await expect(page.getByRole("form", { name: "简历编辑" }).getByLabel("简历正文")).toHaveValue(/CV_A7/);
  await nav(page, "岗位库").click();
  const retainedJob = page.getByRole("list", { name: "岗位版本" }).getByRole("button", { name: /JOB_B4/ });
  await expect(retainedJob).toHaveCount(1);
  await expect(retainedJob).toContainText("v1");
  await nav(page, "工作台").click();
  const choose = page.getByRole("form", { name: "选择准备资料" });
  await choose.getByLabel("简历版本").selectOption({ label: "工程对话简历 · v1" });
  await choose.getByLabel("岗位版本").selectOption({ label: "JOB_B4 · v1" });
  await choose.getByText("到岗条件（选填）", { exact: true }).click();
  await choose.getByLabel("每周到岗天数（选填）").fill("3");
  await choose.getByRole("button", { name: "进入准备记录" }).click();
  await expect(conversation.getByRole("textbox", { name: "向求职助手提问" })).toBeEnabled();
  expect(new URLSearchParams(new URL(page.url()).hash.split("?")[1]).get("preparation")).not.toBe(oldPreparation);
  await expect(conversation).toContainText("资料已就绪。");
});

test("a reply finishing after a target switch stays in its original preparation", async ({ page }) => {
  test.skip(process.env.NANOBOT_CAREER_LIVE_MODEL === "1", "Delayed routing uses engineering data only.");
  await prepareConversation(page);
  await nav(page, "我的简历").click();
  await page.getByRole("button", { name: "新增简历", exact: true }).click();
  const resume = page.getByRole("form", { name: "简历编辑" });
  await resume.getByLabel("名称", { exact: true }).fill("工程切换简历");
  await resume.getByLabel("简历正文").fill("工程虚构资料：唯一项目代号 CV_C9。");
  await resume.getByRole("button", { name: "保存草稿", exact: true }).click();
  await resume.getByRole("button", { name: "确认使用", exact: true }).click();
  await expect(resume.getByLabel("简历正文")).toHaveAttribute("readonly");
  await nav(page, "工作台").click();
  await page.getByRole("button", { name: "更换资料", exact: true }).click();
  const choose = page.getByRole("form", { name: "选择准备资料" });
  await choose.getByLabel("简历版本").selectOption({ label: "工程切换简历 · v2" });
  await choose.getByRole("button", { name: "进入准备记录" }).click();
  const records = page.getByRole("region", { name: "准备记录" });
  const conversation = page.getByRole("region", { name: "求职对话" });
  await expect(conversation.getByRole("textbox", { name: "向求职助手提问" })).toBeEnabled();
  await records.getByRole("button", { name: /工程对话简历/ }).click();
  await expect(conversation.getByRole("textbox", { name: "向求职助手提问" })).toBeEnabled();
  await conversation.getByRole("textbox", { name: "向求职助手提问" }).fill("DELAY_FOR_SWITCH");
  await conversation.getByRole("button", { name: "发送", exact: true }).click();
  await records.getByRole("button", { name: /工程切换简历/ }).click();
  await expect(conversation.getByRole("textbox", { name: "向求职助手提问" })).toBeEnabled();
  await conversation.getByRole("textbox", { name: "向求职助手提问" }).fill("请告诉我项目代号。");
  await conversation.getByRole("button", { name: "发送", exact: true }).click();
  await expect(conversation.locator('[data-assistant-selectable="true"]')).toContainText("CV_C9");
  await records.getByRole("button", { name: /工程对话简历/ }).click();
  await expect(conversation.locator('[data-assistant-selectable="true"]')).toContainText("CV_A7");
  await records.getByRole("button", { name: /工程切换简历/ }).click();
  await expect(conversation.locator('[data-assistant-selectable="true"]')).toContainText("CV_C9");
  await expect(conversation.locator('[data-assistant-selectable="true"]')).not.toContainText("CV_A7");
});

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


test("career plan drafts require user confirmation and persist edited tasks and progress", async ({ page }, info) => {
  const live = process.env.NANOBOT_CAREER_LIVE_MODEL === "1";
  test.setTimeout(live ? 240_000 : 120_000);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await prepareConversation(page);
  const conversation = page.getByRole("region", { name: "求职对话" });
  await conversation.getByRole("textbox", { name: "向求职助手提问" }).fill("请仅根据本次资料提出3项准备计划草稿，每项写清具体行动、完成标准和依据。先不要保存为正式任务。");
  await conversation.getByRole("button", { name: "发送", exact: true }).click();
  const editor = page.getByRole("form", { name: "准备计划草稿编辑" });
  await expect(editor).toBeVisible({ timeout: 90_000 });
  await expect(editor.getByRole("button", { name: "确认保存到清单", exact: true })).toBeEnabled({ timeout: 90_000 });
  await expect(editor.getByLabel("任务标题", { exact: true })).toHaveCount(3);
  await page.screenshot({ path: info.outputPath("career-plan-draft.png"), fullPage: true });
  await nav(page, "准备清单").click();
  const list = page.getByRole("region", { name: "准备清单", exact: true });
  await expect(list).toContainText("还没有正式任务");
  await list.getByRole("button", { name: "返回对话核对草稿", exact: true }).click();
  await editor.getByLabel("任务标题", { exact: true }).first().fill("工程确认后的项目准备任务");
  await editor.getByLabel("完成标准", { exact: true }).first().fill("一页说明包含问题、方案和验证过程。");
  await editor.getByRole("button", { name: "移除此项", exact: true }).nth(1).click();
  await editor.getByRole("checkbox", { name: "采用第 3 项", exact: true }).uncheck();
  await editor.getByRole("button", { name: "确认保存到清单", exact: true }).click();
  const tasks = list.getByTestId("career-task");
  await expect(tasks).toHaveCount(1);
  await expect(tasks).toContainText("工程确认后的项目准备任务");
  await expect(tasks).toContainText("一页说明包含问题、方案和验证过程。");
  await tasks.getByLabel("结果", { exact: true }).fill("已整理一页项目说明（工程测试）。");
  await tasks.getByRole("button", { name: "保存结果", exact: true }).click();
  await expect(tasks.getByRole("button", { name: "保存结果", exact: true })).toBeDisabled();
  const completed = tasks.getByRole("checkbox", { name: "已完成：工程确认后的项目准备任务", exact: true });
  await completed.check();
  await expect(list).toContainText("已完成 1 / 1 项");
  await completed.uncheck();
  await expect(list).toContainText("已完成 0 / 1 项");
  await expect(tasks.getByLabel("结果", { exact: true })).toHaveValue("已整理一页项目说明（工程测试）。");
  await page.reload();
  await expect(page.getByRole("textbox", { name: "向求职助手提问" })).toBeEnabled();
  await nav(page, "准备清单").click();
  await expect(tasks).toHaveCount(1);
  await expect(tasks.getByLabel("结果", { exact: true })).toHaveValue("已整理一页项目说明（工程测试）。");
  await stop(); await start(); await page.reload();
  await expect(page.getByRole("textbox", { name: "向求职助手提问" })).toBeEnabled();
  await nav(page, "准备清单").click();
  await expect(tasks.getByLabel("结果", { exact: true })).toHaveValue("已整理一页项目说明（工程测试）。");
  await list.getByText("查看建议来源（摘要）", { exact: true }).click();
  await expect(list).toContainText("工程对话简历 · v1");
  await page.screenshot({ path: info.outputPath("career-plan-saved.png"), fullPage: true });
  if (live) return;
  await nav(page, "工作台").click();
  await conversation.getByRole("textbox", { name: "向求职助手提问" }).fill("再给我一份准备计划草稿，作为备选，暂不保存。");
  await conversation.getByRole("button", { name: "发送", exact: true }).click();
  await expect(editor.getByRole("button", { name: "确认保存到清单", exact: true })).toBeEnabled();
  await editor.getByRole("button", { name: "取消草稿", exact: true }).click();
  await nav(page, "准备清单").click();
  await expect(tasks).toHaveCount(1);
  await expect(tasks.getByLabel("结果", { exact: true })).toHaveValue("已整理一页项目说明（工程测试）。");
  await nav(page, "我的简历").click();
  await page.getByRole("button", { name: "新增简历", exact: true }).click();
  const resume = page.getByRole("form", { name: "简历编辑" });
  await resume.getByLabel("名称", { exact: true }).fill("工程计划切换简历");
  await resume.getByLabel("简历正文").fill("工程虚构资料：项目代号 CV_C9。");
  await resume.getByRole("button", { name: "保存草稿", exact: true }).click();
  await resume.getByRole("button", { name: "确认使用", exact: true }).click();
  await expect(resume.getByLabel("简历正文")).toHaveAttribute("readonly");
  await nav(page, "工作台").click();
  await page.getByRole("button", { name: "更换资料", exact: true }).click();
  const choose = page.getByRole("form", { name: "选择准备资料" });
  await choose.getByLabel("简历版本").selectOption({ label: "工程计划切换简历 · v2" });
  await choose.getByRole("button", { name: "进入准备记录" }).click();
  await expect(page.getByRole("region", { name: "当前准备" })).toContainText("工程计划切换简历 · v2 → JOB_B4 · v1");
  await expect(conversation.getByRole("textbox", { name: "向求职助手提问" })).toBeEnabled();
  await nav(page, "准备清单").click();
  await expect(list).toContainText("还没有正式任务");
  await page.getByRole("region", { name: "准备记录" }).getByRole("button", { name: /工程对话简历/ }).click();
  await expect(page.getByRole("region", { name: "当前准备" })).toContainText("工程对话简历 · v1 → JOB_B4 · v1");
  await nav(page, "准备清单").click();
  await expect(tasks).toHaveCount(1);
  await expect(tasks.getByLabel("结果", { exact: true })).toHaveValue("已整理一页项目说明（工程测试）。");
});
