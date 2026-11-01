# 求职业务：第 2～5 步

本模块保存求职资料和准备记录。第 2 步提供 Python 业务服务，第 3 步接入现有 gateway 和真实 WebUI 的文字资料管理，第 4 步接入选定资料的真实多轮对话、流式回复、来源及状态，第 5 步接通建议草稿、用户编辑确认、任务进度和结果。真实模型已用明确标注的虚构资料验证，正式材料与完整建议质量仍待验收；文档解析和图片识别留待后续。原聊天历史仍由 `nanobot/session/` 管理，本模块只保存会话引用、业务结果和资料快照。

## 数据存放

- 默认目录：`get_data_dir() / career / <workspace-id> / career.sqlite3`，`get_data_dir()` 来自当前配置所属目录，不固定指向某个用户目录。
- 复用 `SessionLocation` 的工作区身份标记，创建或读取 `<workspace>/.nanobot/workspace-id` 及实例中的会话命名空间标记，不打开或修改原会话数据库。数据库不能位于当前 agent 工作区内。
- 构造器只接受可信运行时提供的 `workspace` 和可选 `data_dir`；未来业务接口不能接收客户端提交的磁盘路径。不同工作区使用不同数据库，同一工作区在不同实例的数据目录中也各自隔离。
- UUID 是稳定身份；简历展示序号在工作区内递增，岗位展示序号在同一 `job_id` 内递增，同名不会覆盖。`parent_version_id` 记录另存来源。
- 当前 `schema_version = 3`，记录在 SQLite 的 `PRAGMA user_version`。版本 1 / 2 事务升级，为任务新增 `basis`，旧值默认空字符串；版本 1 同时补齐 `career_threads.deleted_at`。原记录保留，旧计划 JSON 缺少依据也能读取；不支持的未来版本会明确报错，不能重建或清空已有资料。
- 每次操作单独打开和关闭连接，启用外键、WAL 和 `synchronous=FULL`。写操作在读取决策依据前执行 `BEGIN IMMEDIATE`，让多个线程或进程的确认、版本分配依次完成；出错时整个事务回滚。

## 服务与状态

| 对象 | 方法 | 规则 |
| --- | --- | --- |
| 简历 | `create_resume`、`list_resumes`、`get_resume`、`edit_resume_draft`、`confirm_resume`、`revise_resume`、`rename_resume` | 草稿可编辑；确认内容不再原地修改，修订另存草稿；名称和备注可改 |
| 岗位 | `create_job`、`list_jobs`、`get_job`、`edit_job_draft`、`confirm_job`、`revise_job` | 缺失字段保持缺失；确认后的正文、公司和要求修改须另存新版本 |
| 准备记录 | `create_thread`、`get_thread`、`list_threads` | 绑定已确认简历、已确认岗位、个人条件和会话引用；同一会话不能改绑，查看其他资料不会改动绑定 |
| 分析记录 | `create_analysis`、`get_analysis`、`list_analyses`、`update_analysis` | 创建时固化正文、结构化资料、名称和条件；排队及失败后重试沿用同一 ID 和快照 |
| 计划 | `propose_plan`、`get_plan`、`list_plans`、`confirm_plan`、`cancel_plan` | 运行中或成功的分析可提出草稿；分析成功后才可确认；用户可传入编辑后的任务选择，原建议保留 |
| 任务 | `list_tasks`、`update_task` | 仅在确认计划的事务中生成；待办与完成可切换，结果文字独立保存，重开为待办时默认保留结果 |

编辑或修订正文时，如果没有同时提供 `profile` 或 `requirements`，结构化字段会清空，避免新正文继续沿用旧提取结果。`edit_resume_draft` 可在一个事务内同时更新名称、备注和正文；`revise_job` 不传公司时沿用旧值，显式传 `None` 时清空公司。资料原文保留输入中的空白；名称、任务标题等字段去除首尾空白。资料正文上限为 200,000 字符，单个计划最多 50 项任务；输入通过既有 Pydantic 依赖校验，不增加依赖。

计划原建议存放在 `PreparationPlan.proposed_tasks`；确认后的实际任务存放在独立任务表中，每项可保留 `basis`。同分析中内容相同的未确认草稿重试复用，取消的草稿不会恢复。确认操作在同一事务中保存全部任务并标记计划已确认；重复确认返回既有计划，不重建任务、不重置完成状态。对已确认草稿提交另一份明确的任务选择会报冲突；不传选择时返回已保存结果。全部不选时应取消草稿，空选择不能生成空计划。

分析状态支持 `queued → running → succeeded / failed / cancelled`，也允许排队时失败或取消。`failed → queued` 用于重试，快照不变；成功和取消是终态。失败或取消会同时取消其尚未确认的计划，避免重试成功后误保存上一次失败的建议。`update_analysis` 只是保存状态和结果，不调度模型、不执行自动重试。

## 用临时资料调用

以下例子只在临时目录中验证服务调用，退出后清除临时资料；不读取用户简历、配置内容或凭据。

```python
from pathlib import Path
from tempfile import TemporaryDirectory

from nanobot.career.models import PersonalConditions
from nanobot.career.service import CareerService
from nanobot.career.store import CareerStore

with TemporaryDirectory(prefix="nanobot-career-demo-") as directory:
    root = Path(directory)
    service = CareerService(CareerStore(root / "workspace", data_dir=root / "data"))
    resume = service.create_resume(name="工程测试简历", text="完成过一次原型练习。")
    job = service.create_job(name="工程测试岗位", text="参与原型设计。")
    service.confirm_resume(resume.id)
    service.confirm_job(job.id)
    thread = service.create_thread(
        session_key="career:temporary-test",
        resume_version_id=resume.id,
        job_version_id=job.id,
        conditions=PersonalConditions(days_per_week=3),
    )
    restored = CareerService(CareerStore(root / "workspace", data_dir=root / "data"))
    assert restored.get_thread(thread.id) == thread
```

## 验证与后续边界

从仓库根目录执行：

```powershell
.\.venv\Scripts\python.exe -m pytest tests/career -q
.\.venv\Scripts\python.exe -m ruff check nanobot/career tests/career
.\.venv\Scripts\python.exe -m basedpyright nanobot/career
.\.venv\Scripts\python.exe -m scripts.check_import_boundaries
```

测试覆盖六类记录恢复、同名版本、草稿限制、修订与历史、会话绑定、快照与重试、工作区及实例隔离、任务选择和状态、事务回滚、重复与并发确认。导入边界规则 `career-domain` 保持本模块独立于 agent 执行和客户端适配。

第 3 步已将 `career` 目录加入 `profile_data_paths` 的维护锁和更新备份清单。已有启动授权如缺少新目录，仅对新增的延迟初始化目录单独获取普通租约，不扩大原授权范围；维护期间的 HTTP 和 WebSocket 求职操作由现有运行时准入拒绝，不能初始化或写入业务数据库。

## 第 3 步界面与接口

从当前源码构建并重新启动本地 gateway 后，点击原侧栏“求职工作台”。四个入口分别为“工作台、我的简历、岗位库、准备清单”。先添加和保存文字草稿，再确认使用；已确认正文以只读方式展示，修改时另存新版。草稿中存在未保存的修改时，确认按钮不可用。正式资料初始为空，测试资料不会自动导入用户实例；原独立 HTML 预览中的示例也不会迁入真实数据库。

工作区列表来自服务端的默认工作区、已有收藏和最近项目，以及持久聊天记录的工作区。客户端只提交服务端返回的工作区引用与资料 ID，不提交磁盘路径或自定会话键。建立准备记录后，URL 只保存工作区引用和准备记录 ID；刷新时从后端恢复资料和绑定，不把简历正文存入浏览器存储。未点击保存的输入只保留在当前页面内存中，关闭页面或切换工作区前应保存草稿。

| 接口或操作 | 传输 | 边界 |
| --- | --- | --- |
| `/api/career/workspaces` | 既有认证 HTTP 读取 | 返回服务端已知工作区的引用和名称 |
| `/api/career?workspace_ref=...` | 既有认证 HTTP 读取，`Cache-Control: no-store` | 返回该工作区的版本、准备记录、正式计划和任务 |
| `career.resume.create/edit/revise/rename/confirm` | 既有认证 WebSocket 操作 | 校验输入、资料归属及确认状态，复用 `CareerService` |
| `career.job.create/edit/revise/confirm` | 既有认证 WebSocket 操作 | 缺失公司保持空值；确认内容修改另存版本 |
| `career.thread.create` | 既有认证 WebSocket 操作 | 服务端生成稳定会话键，建立真实会话元数据，绑定具体版本和条件；同资料、同条件重进复用旧记录 |

直接 HTTP 调用修改路径返回 405；未知字段、伪造确认状态、客户端会话键或磁盘路径不能进入服务调用。创建准备记录时，适配层为实际会话写入准备记录 ID 和工作区元数据；已有会话归属不符时拒绝绑定，也不会覆盖其历史或访问策略。业务服务本身仍是可信内部接口，外部调用必须经过适配层验证。

WebUI 声明可选能力 `webui.career.v1`，核心协议仍为 1。缺少该能力的宿主只在求职区域显示限制，普通聊天入口保留。组件按需加载，全部 10 种现有语言补齐文案；跨工作区和客户端的迟到读取或保存结果不会更新新页面。准备清单目前只展示已确认任务及进度，没有任务时显示空状态；真实建议生成、编辑确认和任务操作入口属于第 5 步。

## 第 3 步实际验证（2026-10-30）

- 后端业务、API、协议、架构和维护授权相关测试：114 passed、1 skipped；跳过原因是当前 Windows 未启用目录符号链接权限。另运行现有 HTTP/bootstrap/收藏回归：3 passed。
- 前端求职交互、API、i18n、侧栏和宿主兼容组件测试：61 passed；客户端导入规则测试：42 pass；导入扫描通过（WebUI 407 files）。全量 WebUI lint、TypeScript 和生产构建通过。
- 真实浏览器：1 passed（22.0s，流程 13.6s）。使用本机 Chrome、真实静态构建、独立临时 Python gateway 和 SQLite，未替换求职接口。覆盖两版简历、两个岗位、目标切换、查看不改目标、刷新、工作区隔离、真正停止和重启 gateway、320px 无横向溢出及原有聊天显示记录恢复。
- 旧宿主能力提示使用独立协议 fixture 与组件测试，没有连接真实远程旧宿主。普通聊天真实模型回复、文件提取、图片识别和模型建议质量未执行。

可复现的真实浏览器检查在 `webui/` 中运行（需要已有 `.venv`、前端依赖及可用浏览器）：

```powershell
$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm run test:career
```

该命令构建现有 WebUI，再运行专用 Playwright 配置。第四步已将 `scripts/career_browser_gateway.py` 扩展为真实 AgentLoop 和原 ChannelManager 分发流程，默认 provider 明确使用工程替身；设置 `NANOBOT_CAREER_LIVE_MODEL=1` 后可按第四步说明运行真实模型专项，不能把两类证据混为一谈。测试正常结束时通过标准输入关闭自己启动的 gateway，不停止用户已有进程。默认浏览器组件测试配置排除这组独立集成用例。

## 第 3 步界面对齐补充（2026-10-30）

真实页面已参考根目录 `nanobot求职工作台预览.html` 调整：新增 `CareerHome.tsx` 的目标引导、三项资料概览、简历与岗位入口、选用资料和未开放的求职对话区域；`CareerNavigation.tsx` 提供四个业务入口、准备记录及新建准备操作。工作区选择移到顶部紧凑区域。简历和岗位编辑页展示版本、状态、文字来源和“当前使用”标记，查看其他版本仍不会切换绑定。

“新建准备”只清空当前选择并进入资料选择状态，不删除已有记录或任务；“更换资料”展开选择表单，保存后沿用既有创建或复用准备记录的接口。可选到岗条件收在可展开区域。普通聊天入口明确说明不会自动带入求职资料，求职输入和发送保持禁用。当前仍只支持文字录入，PDF、DOCX 与岗位截图识别留在后续阶段。

本轮未修改后端、接口、数据结构、依赖或原型文件。实际验证：求职组件、API 和 i18n 定向测试 42 passed；全量 WebUI lint 和 TypeScript 检查通过；客户端导入扫描通过（409 files），导入规则测试 42 pass；`npm run test:career` 完成生产构建、浏览器 TypeScript 和真实浏览器流程，1 passed（总计 19.5s，流程 11.9s）。浏览器新增检查空状态引导、禁用对话入口、新建准备保留旧记录，继续覆盖保存、切换、刷新、真实测试进程重启、工作区隔离、320px 和原聊天显示记录；已查看明暗主题、简历版本页及窄屏截图。

本轮检查使用独立临时工程数据，没有接模型、解析用户文件或重启用户原网关；历史后端及兼容证据保留原身份，本轮没有重新全量执行。构建仍提示既有部分包体超过 500 kB，本轮未调整无关打包策略。专用导入检查用离线缓存的 `npx --offline --yes bun@1.4.4` 执行，未安装全局 Bun 或修改锁文件。

## 第二、三步规划复核（2026-10-31）

两步按工程范围与规划对齐；本轮补齐了真实版本列表的添加时间，使用后端已有 `created_at` 和现有本地化格式器，数据库及后端服务不变。后端 114 passed/1 skipped、HTTP 回归 3 passed、前端相关 67 passed、导入规则 42 pass，类型、lint 和构建通过；真实浏览器 1 passed，覆盖创建时间和重启恢复。下一阶段仍为第四步，真实模型、建议操作和文件识别未计入本轮完成。

## 第 4 步：带资料真实对话（2026-10-31～11-01）

真实工作台已增加 `CareerConversation`，复用 `useNanobotStream` 和原消息显示组件，支持连续提问、停止、历史分页与恢复。前端使用可选能力 `webui.career.chat.v1`，通过认证的 `/api/career/conversation` 读取实际有界资料预览和每轮来源摘要。核心协议仍为 1；没有升级能力的宿主继续显示求职对话限制。

`career_turns.py` 在 WebUI 入站层验证实际会话和准备绑定，创建 `AnalysisRun` 并附加 `RuntimeContextBlock`。`AnalysisSnapshot.turn_id` 保存在原 JSON 中，同轮重试复用原快照，无 SQLite DDL 变更。输出通过原 ChannelManager 的普通及流式入口保存业务结果，不能把逐字片段当作普通完整回复；真实聊天历史仍由原会话系统管理。停止操作只取消截止时间前的待处理分析，终态不会被迟到成功覆盖。

`context.py` 对常见联系方式和本机路径进行过滤，资料 JSON 总预算 24,000 字符，超长明确提示；原资料和完整业务快照仍在本地保存。结构化到岗数字使用代码比较，正文中的要求由模型解释。`career_preparation.md` 要求区分证据、冲突、待确认和建议，缺失经历先追问。第四步初始策略在绑定求职轮次的已注册工具执行前拒绝动作；第五步仅开放经过校验的提议草稿工具，普通未绑定聊天保留原策略。

本轮后端 141 passed / 1 skipped、工程浏览器 4 passed、隔离真实模型 1 passed，前端及静态检查、用户本地实例联调已执行，测试材料为明确标注的虚构资料。正式材料验收、任务操作、PDF / DOCX 和截图识别仍未完成；第三步各节保留当时证据，不代表历史上已经接模型。

## 资料预览与条件核对（2026-11-01）

工作台顶部保留准备概览，聊天区域只有一个默认收起的“查看本次参考资料”入口。`CareerReferenceMaterials.tsx` 将到岗条件与非空补充字段显示为可读信息，保留进入简历库及岗位库的入口，不再直接展示内部 JSON。当前填写的条件和简历原文有明确差异时，预览外显示提示及原文证据，不修改版本或绑定；每轮消息的来源标注保留。

`context.py` 在资料 JSON 中新增可选字段 `resume_condition_differences`，只读比较明确带有到岗标签的中英文常见写法；项目数字、范围及模糊条件不作为确定依据。此提示不是通用简历解析，未出现差异提示不代表资料已被全面核验。`career-api.ts` 验证可选字段，旧响应仍可用；SQLite 结构、已确认资料和历史分析不变。

## 删除对话与准备记录联动（2026-11-01）

删除求职对话成功后，后端给其准备记录写入删除标记；工作台同时移除该记录及关联清单，正在查看时清空准备选择。简历、岗位、历史分析和已有任务保留在底层，未完成分析及未确认草稿取消，迟到回复不能恢复已删除会话。删除确认框说明影响范围；这些规则继续适用于第五步新增的建议和任务操作。

后端只根据实际会话数据库确认的缺失处理历史残留，不用 `chat_available=false` 代替删除证据；读取异常或归属不符不会触发移除。创建、读取核对和删除由同一业务生命周期锁协调，避免新准备尚在绑定时被误判为已删除。保存失败不会返回删除成功；如会话已删除而业务标记尚未完成，下次成功读取会核对并补齐标记。

已删除记录不会复活。同一组简历、岗位、条件再次进入时创建新准备和新会话，后续重复进入复用这份新记录。当前仍将到岗条件作为准备绑定的一部分，修改条件进入另一份记录的规则未改。新增可选能力 `webui.career.deletion.v1`、响应字段 `deleted_thread_ids` 和数据库版本 2；核心 WebUI 协议保持 1。

## 第 5 步：建议确认与任务跟进

原 gateway 在 WebSocket 通道就绪后注册 `ProposePreparationPlanTool`，求职策略只允许这一提议工具。输入仅含 1～8 项任务及依据，服务端从真实 RequestContext、会话 generation 和本轮快照确定归属，不接受模型指定路径或绑定。工具只创建草稿并发送原会话更新事件，不能创建正式任务。

认证读取状态增加可选 `drafts` 及来源；认证修改操作为 `career.plan.confirm`、`career.plan.cancel`、`career.task.update`。确认必须提交用户选择，分析成功后才允许保存；任务更新验证存储关系及实际会话归属。`CareerPlanDrafts` 负责编辑和明确确认，`PreparationList` 按原来源显示正式任务、完成状态和结果。能力 `webui.career.plans.v1` 缺失时不开放修改，核心协议仍为 1。

后端定向 142 passed，迁移补充复测 6 passed，前端 97 passed；工程既有五例及新增计划专项分别通过，隔离真实模型专项 1 passed。Ruff、BasedPyright、类型、lint、构建和导入边界通过。自动化确认与进度验证均在独立临时实例；使用时先在对话中提出计划，编辑并确认草稿后进入清单，再更新完成状态和结果。PDF / DOCX、图片识别和到岗条件独立保存均未在此步实施。
