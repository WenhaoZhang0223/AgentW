<div align="center">

# AgentW 🤖

### 住进 Edge 侧边栏的本地网页智能体

**看得懂网页 · 会自动翻页 · 能整理数据 · 直接导出 Excel**

基于 [pi-mono](https://github.com/earendil-works/pi-mono) 构建

<br />

![AgentW 演示动画](./demo.gif)

---

## ✨ AgentW 是什么？

AgentW 是一款基于 **pi-mono** 开发、面向 **Windows 11 + Microsoft Edge** 的本地网页侧边栏 Agent。

它在 pi-mono 的基础上复用了 Pi 的多模型接入、Agent 运行时、会话、工具调用和 Skill 系统，并增加了 Edge Side Panel、Windows Native Messaging Host 以及网页自动化能力。

简单来说：**pi-mono 提供 Agent 的大脑，AgentW 让它真正走进浏览器干活。** 🧠

比如，你只需要输入：

> **“提取两页商品并生成 Excel。”**

AgentW 就会依次完成：

```text
读取当前网页 → 识别商品 → 自动翻页 → 合并去重 → 生成 Excel
```

以前：盯着网页复制半小时。😵‍💫

现在：说一句话，等文件出现。😎

## 🚀 能做什么？

### 🛒 跨页采集商品

- 读取当前授权标签页中的可见内容
- 识别 JSON-LD、Microdata 和常见商品卡片
- 自动寻找并点击“下一页”
- 按商品链接合并去重
- 页面为空、没有下一页或内容不再变化时自动停止
- 批量采集默认最多 200 页，单次任务最高可调整至 1000 页

### 📊 导出结构化结果

AgentW 可以把采集结果整理为 Excel，字段包括：

| 字段 | 说明 |
| --- | --- |
| 商品名称 | 页面展示的商品标题 |
| 包装规格 | 商品包装或规格信息 |
| 价格 | 保留网页中的原始价格文本 |
| 生产日期 | 页面未提供时会明确标记 |
| 商品链接 | 规范化后的商品地址 |
| 来源页面 | 数据所在的页面 |
| 采集时间 | 带时区的采集时间 |

也可以让 AgentW 打开或复用 Google Sheets 并写入结果。遇到登录、验证码等步骤时，它会暂停并把操作交还给你。

### 🧠 自然语言交互

不需要写选择器，也不需要学习自动化脚本。直接描述目标即可：

```text
提取两页商品并生成 Excel
```

```text
提取当前页面的商品并写入 Google Sheets
```

```text
提取所有结果页，按商品链接去重后生成表格
```

### 🧩 可扩展 Skill

可在设置面板上传包含 `SKILL.md` 的文件夹或 ZIP，为 AgentW 增加新的工作流程。

Skill 安装带有安全校验：

- ZIP 最大 10 MiB
- 解压后最大 50 MiB
- 最多包含 200 个文件
- 拒绝路径穿越、符号链接和脚本/可执行文件
- Skill 变更从下一次新对话开始生效

## 🏗️ 工作原理

AgentW 没有重新造一套 Agent 框架，而是在 pi-mono 的核心能力之上增加浏览器交互层：

```text
┌──────────────────────────────┐
│      Microsoft Edge 网页      │
└──────────────┬───────────────┘
               │ 授权后读取与操作
┌──────────────▼───────────────┐
│       AgentW Side Panel       │
│   对话 / 任务状态 / 文件结果    │
└──────────────┬───────────────┘
               │ Native Messaging
┌──────────────▼───────────────┐
│       AgentW Windows Host     │
│      会话、任务与文件管理       │
└──────────────┬───────────────┘
               │ Pi RPC
┌──────────────▼───────────────┐
│   pi-agent / pi-ai / Skills   │
│         来自 pi-mono           │
└──────────────────────────────┘
```

浏览器能力、系统能力和 Agent 调度彼此隔离。网页只会被转换为紧凑的语义数据，不会把完整 HTML 一股脑塞进模型上下文。

## 🛠️ 本地构建

### 环境要求

- Windows 11
- Microsoft Edge
- Node.js `>= 22.19.0`
- [Bun](https://bun.sh/)（用于编译 Native Host）

### 1. 安装依赖

```powershell
npm install --ignore-scripts
npm run hydrate:model-data
```

### 2. 构建 Edge 扩展和 Native Host

```powershell
node packages/agentw/scripts/build.mjs
node packages/agentw/scripts/compile-host.mjs
```

编译完成后会生成配套的 `agentw-host.exe` 和 `pi.exe`。

### 3. 加载 Edge 扩展

1. 在 Edge 中打开 `edge://extensions`
2. 开启右上角的“开发人员模式”
3. 点击“加载解压缩的扩展”
4. 选择 `packages/agentw/dist/edge`
5. 复制 Edge 显示的扩展 ID

### 4. 注册 Native Host

在仓库根目录运行：

```powershell
$agentwExtensionId = Read-Host "Paste the AgentW ID shown by edge://extensions"
.\packages\agentw\scripts\register-native-host.ps1 -ExtensionId $agentwExtensionId
```

注册当前用户的 Native Host **不需要管理员权限**。

AgentW 默认复用 `~/.pi/agent` 中已有的 Pi 模型登录信息，也可以通过 `AGENTW_PI_AGENT_DIR` 指定其他目录。

## 🧪 快速体验

启动仓库内置的本地购物测试站：

```powershell
node packages/agentw/scripts/serve-fixtures.mjs
```

然后：

1. 打开 `http://127.0.0.1:4173/shop/page-1.html`
2. 点击 Edge 工具栏中的 AgentW 图标
3. 拖动 Edge 分隔线调整侧边栏宽度
4. 输入“提取两页商品并生成 Excel”
5. 等待 AgentW 返回文件卡片并下载结果

> 请通过本地 HTTP 地址访问测试页面，不要直接使用 `file://` 打开。

## 🔐 安全边界

AgentW 可以替你操作网页，但不会替你跨过安全红线。

- 只读取用户主动授权的当前标签页
- 不读取后台标签页、浏览历史、Cookie 或密码
- 网页内容始终被视为不可信输入
- API Key 保留在本地 Pi 配置和进程边界内
- 登录和验证码必须由用户手动完成
- 付款、提交订单、发送消息、删除数据等高风险操作必须确认
- 任务支持停止、超时和异常清理
- 成功、失败或取消后都会清理任务临时文件

简单来说：**能自动做的就自动做，该由你决定的绝不抢方向盘。** 🛡️

## 📦 Monorepo 结构

本项目基于 pi-mono 的 Monorepo 结构开发。AgentW 作为独立的工作区包，与 Pi 的核心模块协同运行。

| Package | 用途 |
| --- | --- |
| [`@earendil-works/agentw`](packages/agentw) | Edge 侧边栏、Native Host 与 AgentW 工具 |
| [`@earendil-works/pi-coding-agent`](packages/coding-agent) | 交互式 Coding Agent CLI |
| [`@earendil-works/pi-agent-core`](packages/agent) | Agent 运行时、工具调用与状态管理 |
| [`@earendil-works/pi-ai`](packages/ai) | 多模型 Provider 统一接口 |
| [`@earendil-works/pi-tui`](packages/tui) | 终端 UI 组件库 |

## 🧑‍💻 开发命令

```bash
npm install --ignore-scripts  # 安装依赖，不执行生命周期脚本
npm run build                 # 构建全部工作区
npm run build:offline         # 使用本地模型数据离线构建
npm run check                 # 格式、类型与项目规则检查
./test.sh                     # 运行非 E2E 测试
./pi-test.sh                  # 从源码启动 Pi
```

更详细的 Edge 加载、Native Host 注册与测试说明，请查看 [`packages/agentw/README.md`](packages/agentw/README.md)。

## 🗺️ 下一步

- 招聘网站搜索与职位整理
- 更通用的网页搜索任务
- 更丰富的 Google Sheets / Docs 协作
- 视频字幕获取与内容总结
- CSV、文档等更多 Artifact 格式
- Chrome、macOS 与 Linux 支持

## 🤝 参与贡献

提交代码前请阅读：

- [贡献指南](CONTRIBUTING.md)
- [项目开发规则](AGENTS.md)
- [容器化与权限说明](packages/coding-agent/docs/containerization.md)

## 📄 License

[MIT](LICENSE)

---

<div align="center">

### AgentW

**让网页从“给人看”，变成“能替人干活”。** 🚀

</div>
