# Teams 会议回放 · Transcript Player（网页播放器）

一个完全本地运行、风格类似 Microsoft Teams 会议录像回放的网页播放器：
**左侧视频播放器 + 右侧 Transcript（逐字稿）面板**，支持播放进度与逐字稿双向联动。

## 快速开始

直接用浏览器打开 `index.html` 即可（无需安装依赖）。页面会尝试加载 `data/config.js` 中配置的示例视频；离线或视频被墙时，
8 秒后会出现「生成示例视频（离线）」按钮，或直接选择本地录像文件。

推荐用本地服务器预览（支持拖拽进度条、Range 请求）：

```powershell
node server.js        # 启动后在浏览器打开 http://127.0.0.1:8123
```

> 示例音频 `data/sample.wav`（30 秒、每个 Transcript 段落起始有提示音）可在
> 设置 → 视频地址 填入 `http://127.0.0.1:8123/data/sample.wav` 体验同步效果。

## 功能

- 左侧视频：播放/暂停、±10 秒、进度条（含缓冲显示、拖拽）、音量/静音、倍速（0.5x–2x）、画中画、全屏
- 右侧 Transcript：按发言人着色头像、章节标题；**同一个人连续说的话自动合并为一整块**（类似 Teams）；**块内每一句都标注自己的具体时间点**；当前块高亮、块内当前句再高亮，并自动滚动跟随播放
- 点击任意 Transcript 句子（块内每一行）→ 精确跳到该句时刻并播放；点击块的头像/名字区域 → 跳到该发言人整段开头；点击章节 → 跳转
- 搜索：实时高亮所有匹配（`<mark>`）、上/下一个匹配导航、匹配计数
- 复制全文 Transcript（带时间戳与发言人）
- 支持导入：视频（MP4/WebM/Ogg 等）、逐字稿（JSON / VTT / SRT / TXT 自动识别），可拖放文件到视频区域；导入的 Transcript 会保存到浏览器本地，刷新后可在 设置 → 恢复上次导入 找回
- 深色主题、字号调节、自动滚动开关；设置项持久化到 localStorage

## 快捷键

| 按键 | 功能 |
| --- | --- |
| 空格 / K | 播放 / 暂停 |
| ← / → | 后退 / 前进 5 秒（Shift 为 10 秒） |
| ↑ / ↓ | 音量 +/- |
| M | 静音 |
| F | 全屏 |
| T | 切换 Transcript 自动滚动 |
| Home / End | 跳到开头 / 结尾 |

## 换成你自己的会议数据

编辑 `data/config.js`：

```js
window.MEETING_CONFIG = {
  title: "会议标题",
  date: "2026年8月12日 10:00",
  participants: 8,
  videoUrl: "https://.../meeting.mp4",   // 远程地址，或留空后用本地文件
  speakers: { "zhang": { name: "张三", role: "产品经理", color: "#6264A7" } },
  chapters: [ { start: 0, title: "开场" } ],
  transcript: [ { start: 0, end: 8, speaker: "zhang", text: "大家好…" } ]
};
```

- `start` / `end` 单位：秒（可带小数）
- `speaker` 支持多种写法：`speaker` / `speakerId` / `speakerName` / `speaker_name` / `name` / `who`；可以直接填配置里的 key，也可以直接填发言人名字（自动匹配 `speakers` 中同名的人，未登记的名字自动注册为新发言人并分配颜色）；说话人字段为空时，若文本以“名字: 内容”开头会自动提取名字；完全没有说话人信息的行显示为“发言人”并独立成块
- 逐字稿也可以导入 JSON / VTT / SRT：点击「打开文件」或直接拖入视频区域
- JSON 既支持上面的完整结构，也支持 `{ "transcript": [...] }` 或纯数组

## 离线演示

- 「生成示例视频（离线）」：浏览器内置 Canvas + MediaRecorder 生成一段约 8 秒的
  动画会议视频，无需任何外部文件（需要浏览器支持 `canvas.captureStream`，
  现代 Chrome / Edge 均支持）
- `data/sample.wav`：30 秒演示音频，段落起始有提示音，便于听出同步

## 目录结构

```
index.html       页面结构
css/style.css    样式（Teams 风格 + 深色主题）
js/app.js        播放器与 Transcript 联动逻辑
data/config.js   会议配置与示例逐字稿
data/sample.wav  演示音频（可选）
data/user-transcript.json  从页面提取的 Emdoor 会议 Transcript 备份（说话人信息需重导原文件）
server.js        本地开发服务器（支持 Range）
```