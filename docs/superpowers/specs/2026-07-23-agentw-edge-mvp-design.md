# AgentW Edge MVP 设计

## 1. 目标

AgentW 是一个面向非技术用户的网页侧边栏 Agent。首版运行于 Windows 11 和 Microsoft Edge，在用户主动打开侧栏并发出任务后读取当前标签页，完成两页商品信息提取并生成 Excel。

目标用户包括外贸从业者、文职人员、学生和话务员。产品交互保持接近 ChatGPT 的简洁聊天体验，同时复用 pi-mono 的模型、会话、Agent 调度、Extension 和 Skill 能力。

首版完整用户路径：

1. 用户在 Edge 中打开购物网页。
2. 用户打开 AgentW 侧栏并输入“提取两页商品并生成 Excel”。
3. AgentW 自动读取第一页、翻到第二页、提取固定字段并去重。
4. AgentW 生成 Excel，在侧栏中返回文件卡片。
5. 用户下载或另存为 Excel。
6. AgentW 清理本次任务的网页快照、缓存和其他临时文件。

## 2. 范围

### 2.1 MVP 范围

- Windows 11。
- Microsoft Edge Manifest V3 扩展。
- ChatGPT 式侧栏聊天界面。
- 按需读取当前标签页。
- 通用购物网页的尽力提取。
- 自动读取、滚动、翻页和本地 Excel 生成。
- 固定商品字段：
  - 商品名称
  - 价格
  - 生产日期
  - 商品链接
  - 来源页码
  - 抓取时间
- 包含 `SKILL.md` 的文件夹或 ZIP 上传。
- 任务取消、错误处理和临时文件清理。

### 2.2 后续范围

- 招聘网站搜索和职位结果整理。
- 通用网页搜索。
- Google Sheets 和 Google Docs 集成。
- 视频 transcript 获取和总结。
- 更多 Artifact 格式。
- Chrome、macOS 和 Linux。
- 受信任代码型 Pi Extension 的开发者模式。

### 2.3 非目标

- 不保证 Canvas、封闭 iframe、验证码、强反爬或高度虚拟化页面能够被完整读取。
- 不绕过登录、验证码、网站访问控制或反自动化机制。
- 不调用 ChatGPT、Claude 或 Kimi 的网页界面。模型访问继续由 `pi-ai` provider 管理。
- 不向模型开放任意网页 JavaScript 执行。
- 不在首版申请永久的 `<all_urls>` 权限。
- 不在首版强制设置 Edge 侧栏为 50% 宽度。Edge API 不提供宽度设置能力，用户首次手动拖动调整。

## 3. 架构

```text
Edge Side Panel
    ↕
Edge Service Worker
    ↕ Native Messaging
AgentW Windows Host
    ↕
Pi RPC + AgentW Pi Extension
    ↕
pi-agent / pi-ai / skills
```

采用 Edge Extension、Windows Native Messaging Host 和 Pi RPC 的组合。浏览器能力、操作系统能力和 Agent 调度通过协议边界隔离，不把 AgentW 产品逻辑写入 `pi-agent` 或 `pi-ai`。

### 3.1 `agentw-edge`

负责：

- Side Panel 聊天 UI。
- 用户手势和当前标签页授权。
- Service Worker 生命周期。
- Content Script 注入。
- 当前页面语义快照。
- 受约束的读取、滚动、输入、点击和等待动作。
- Native Messaging 连接。
- 任务状态和文件结果展示。

扩展权限：

- `sidePanel`
- `activeTab`
- `scripting`
- `nativeMessaging`
- 结果保存所需的最小下载权限

扩展不读取后台标签页、浏览历史、Cookie 或密码。

### 3.2 `agentw-host`

负责：

- Windows Native Messaging Host 入口。
- 启动、连接和关闭 Pi RPC 会话。
- Edge 消息与 Pi RPC 消息之间的桥接。
- 会话生命周期。
- 文件结果生命周期。
- 每任务临时目录。
- 取消、超时和异常恢复。
- AgentW 用户配置与已安装 Skill 的持久化。

Native Host 仅接受 manifest `allowed_origins` 中明确列出的 AgentW Edge 扩展。

### 3.3 `agentw-extension`

这是 Pi Extension，负责向 Agent 注册受控的语义工具：

- `browser.inspect_current_page`
- `browser.extract_products`
- `browser.click_element`
- `browser.wait_for_page_change`
- `browser.get_task_state`
- `artifact.export_excel`

工具名称表达意图，不把 DOM、Edge API 或 Native Messaging 细节暴露给 Agent。

### 3.4 协议

Edge、Host 和 Pi Extension 使用带版本的判别联合消息。每条请求包含：

- `protocolVersion`
- `requestId`
- `taskId`
- `type`
- `payload`

每条响应包含：

- `requestId`
- `taskId`
- `status`
- `result` 或结构化 `error`

长内容不传输完整 HTML。Content Script 先生成紧凑语义快照，仅包含可见文本、结构化商品候选、链接、表格、分页候选和带短期引用的可交互元素。超出消息限制时按有界批次分块传输。

取消通过 `taskId` 传播到 Edge 动作、Pi 运行和 Artifact 导出。

MVP 默认限制：

- 单条 Native Messaging 分块不超过 512 KiB。
- 单次任务最多读取 10 页。
- 单次任务最多返回 128 条经过字段长度限制的记录，确保结果不超过 512 KiB 传输上限。
- 单个页面动作超时 30 秒。
- 单次 Agent 任务超时 10 分钟。

## 4. 界面

侧栏保持单列聊天布局：

- 顶部：新会话、当前模型和设置。
- 中间：用户消息、AgentW 回复和可折叠的工具执行状态。
- 底部：输入框、附件、Skill 上传、发送和停止。
- 结果：包含下载、另存为和重新生成的文件卡片。

状态文案只显示用户可理解的动作，例如“正在读取当前页面”和“正在翻到第 2 页”，不显示模型内部推理。

Side Panel 与网页并排显示。用户可以拖动 Edge 原生分隔线调整比例；产品不声称能够通过扩展 API 强制默认 50/50。

## 5. 商品提取数据流

### 5.1 页面读取

1. 用户通过打开 AgentW 或发送任务触发 `activeTab` 授权。
2. Content Script 读取当前页面的可见内容和结构化元数据。
3. 提取器优先使用 JSON-LD 和 Microdata。
4. 没有足够结构化数据时，提取器识别重复 DOM 卡片。
5. 模型只负责将候选数据映射到固定字段，不推测页面未提供的事实。

### 5.2 分页

1. 第一页提取完成后，分页检测器寻找语义明确的“下一页”控件。
2. AgentW 使用短期元素引用执行点击。
3. 等待 URL、页面版本或商品集合发生变化，不使用固定睡眠作为成功条件。
4. 元素引用失效时重新读取页面并重新定位。
5. 达到用户要求的页数后停止。
6. 找不到下一页时返回现有结果，并明确报告实际完成页数。

### 5.3 规范化

- 商品链接转换为绝对 URL。
- 商品链接作为首选去重键；缺少链接时使用名称与价格的稳定组合。
- 价格保留网页原始展示值，避免错误的币种换算。
- 页面没有生产日期时写入“网页未提供”。
- 抓取时间使用带时区的 ISO 8601 值。
- 每条记录保留来源页码。

### 5.4 Excel

Excel 生成器接收规范化记录，不重新访问网页。生成失败时保留本次会话中的结构化记录，允许用户重新导出而无需重新抓取。

Host 在任务临时目录生成工作簿。用户点击下载后，Host 通过有序分块把文件传给 Side Panel，Side Panel 校验大小和摘要后调用 Edge 下载流程。Edge 报告下载已开始后，Host 删除临时工作簿；用户下载目录中的文件是最终持久结果。未成功交付的中间工作簿属于临时文件。

## 6. 自动执行与确认

默认自动执行：

- 读取当前页面。
- 滚动。
- 点击分页。
- 等待页面变化。
- 生成本地结果文件。

必须确认或交还用户：

- 登录和验证码由用户手动完成。
- 付款、提交订单、发送消息、上传网站文件、删除数据和覆盖现有用户文件必须确认。
- 页面要求新的敏感权限时必须确认。

“停止”操作必须终止当前 Pi 运行、浏览器动作和导出任务，并进入清理流程。

## 7. Skill 模型

Edge Extension、Pi Tool 和 Skill 的职责分离：

- Edge Extension 提供 UI 和浏览器权限。
- Pi Tool 提供受控的原子能力。
- Skill 组合工具并描述工作流，不能扩大工具权限。

首版 Skill 上传支持包含 `SKILL.md` 的文件夹或 ZIP：

- 验证元数据、大小和目录结构。
- ZIP 压缩包最大 10 MiB，解压后最大 50 MiB，文件数量最多 200。
- 拒绝路径穿越、符号链接逃逸和可执行文件。
- 解压到任务临时目录进行验证。
- 用户启用后复制到 AgentW 持久 Skill 目录。
- 支持启用、禁用和删除。
- 验证失败时删除全部解压内容。

普通 Skill 不能执行任意 PowerShell、Node.js 或浏览器脚本。以后需要代码型 Pi Extension 时，使用独立的开发者模式、信任提示和安装路径。

## 8. 安全

- 网页内容始终标记为不可信数据，不能覆盖系统指令或用户指令。
- 模型只能调用已注册的受约束工具。
- Content Script 不接收模型 API Key。
- API Key 保留在本地 Pi 配置和进程边界内。
- Native Messaging manifest 限制允许连接的扩展 ID。
- 日志隐藏 API Key、Cookie、密码、表单内容和敏感网页字段。
- 工具具有超时、取消、最大页数、最大结果数和最大消息大小。
- 文件路径在使用前规范化并验证位于指定任务目录或用户明确选择的目标内。
- 网页下载内容和 Skill 包均视为不可信输入。

## 9. 临时文件

每个任务创建独立、随机命名的 AgentW 临时目录。目录只用于：

- 页面快照。
- 分块消息缓存。
- Skill ZIP 解压和验证。
- 未完成的 Excel。
- 视频或字幕的后续中间文件。

清理规则：

- 成功后清理。
- 失败后清理。
- 用户取消后清理。
- Host 正常关闭时清理。
- Host 启动时扫描并清理创建时间超过 24 小时的 AgentW 孤立临时目录。

最终 Excel、已安装 Skill、设置和会话记录是持久用户数据，不参与任务临时目录清理。

## 10. 错误处理

错误使用稳定错误码和用户可读信息：

- `PAGE_ACCESS_DENIED`：当前页不可由扩展读取。
- `PAGE_REQUIRES_USER_ACTION`：需要登录或验证码。
- `STALE_ELEMENT_REFERENCE`：页面变化，自动重新读取一次。
- `NEXT_PAGE_NOT_FOUND`：返回已完成页数和现有数据。
- `HOST_DISCONNECTED`：保留会话状态，提示重新连接。
- `AGENT_TIMEOUT`：取消关联操作并清理临时资源。
- `EXPORT_FAILED`：保留结构化记录，允许重新导出。
- `SKILL_VALIDATION_FAILED`：拒绝安装并清理解压内容。

自动恢复必须有界。相同动作连续失败后停止，不进行无限重试。

## 11. 测试

### 11.1 单元测试

- 商品字段规范化。
- URL 处理和去重。
- 分页候选排序。
- 页面变化检测。
- Skill ZIP 验证。
- 路径边界验证。
- 临时目录清理。

### 11.2 协议测试

- Edge、Host 和 Pi RPC 消息编解码。
- 协议版本不匹配。
- 分块消息。
- 超时和取消传播。
- Host 断线和恢复。

### 11.3 集成测试

使用本地购物测试站，包含：

- 两页商品。
- JSON-LD 商品。
- 仅 DOM 商品卡片。
- 缺失生产日期。
- 重复商品。
- 延迟加载。
- 失效元素引用。
- 找不到下一页。
- 模拟登录或验证码阻断。
- 网页提示注入文本。

Agent 测试使用仓库 faux provider，不调用真实 provider、API Key 或付费 token。

### 11.4 手动验收

在 Windows 11 Microsoft Edge 中：

1. 安装未打包扩展和 AgentW Native Host。
2. 打开本地两页购物测试站。
3. 点击 AgentW 图标打开侧栏。
4. 手动将侧栏调整为接近 50%。
5. 输入商品提取任务。
6. 确认两页数据和固定字段。
7. 下载并打开 Excel。
8. 运行取消场景。
9. 确认任务临时目录已清空。

## 12. MVP 验收标准

MVP 完成必须同时满足：

- Windows 11 Edge 中可以通过用户手势打开 AgentW Side Panel。
- Side Panel 能通过 Native Messaging 连接本地 Host。
- Host 能启动或连接 Pi RPC 会话。
- AgentW 能读取当前授权标签页。
- 本地两页购物测试站的两页商品能被提取和去重。
- Excel 包含所有固定字段，且能被 Excel 正常打开。
- 缺少生产日期时明确写入“网页未提供”。
- 登录、验证码和高风险动作不会被自动绕过或提交。
- 用户停止后相关操作停止。
- 成功、失败和取消场景都不残留任务临时文件。
- 不修改 `pi-agent` 或 `pi-ai` 来承载 AgentW 产品逻辑。

## 13. 后续演进

MVP 之后按独立纵向功能迭代：

1. 招聘搜索：复用浏览器工具，增加职位结果 schema 和 Skill。
2. 通用搜索：增加独立 Search Tool。
3. Google Sheets：增加 OAuth 和受控行写入连接器。
4. 视频总结：先读取现有 transcript，再选择性加入音频转写。
5. Artifact Exporter：扩展 CSV、文档和其他格式。
6. 多浏览器和多平台：在协议不变的前提下替换平台适配层。

每次迭代优先新增边界清晰的 Tool 和 Skill，不扩张 Pi 核心。
