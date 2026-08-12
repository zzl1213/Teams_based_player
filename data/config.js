// ============================================================
// 会议回放配置与示例数据
// 修改此文件即可替换为自己的会议数据：
//   - videoUrl: 视频地址（可填远程 URL 或留空后用本地文件）
//   - speakers: 发言人信息
//   - chapters: 章节（可选）
//   - transcript: 逐字稿数组 [{ start, end, speaker, text }]
// ============================================================
window.MEETING_CONFIG = {
  title: "产品迭代周会 · 回放",
  date: "2026年8月12日 10:00",
  participants: 8,
  duration: 405, // 秒（用于展示，实际以视频为准）

  // 默认演示视频（Tears of Steel, CC BY 授权），可替换为任意 mp4 地址或留空
  videoUrl: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4",
  poster: "",

  speakers: {
    "lin":  { name: "林晓", role: "产品经理", color: "#6264A7" },
    "wang": { name: "王磊", role: "开发工程师", color: "#0078D4" },
    "chen": { name: "陈静", role: "设计师", color: "#E3008C" },
    "zhao": { name: "赵明", role: "测试工程师", color: "#107C10" },
    "liu":  { name: "刘洋", role: "数据分析", color: "#CA5010" }
  },

  chapters: [
    { start: 0,   title: "开场与议程" },
    { start: 48,  title: "需求评审" },
    { start: 144, title: "技术方案" },
    { start: 218, title: "设计与体验走查" },
    { start: 286, title: "测试与发布计划" },
    { start: 340, title: "总结与行动项" }
  ],

  transcript: [
    { start: 0,   end: 8,   speaker: "lin",  text: "大家好，欢迎参加本周的产品迭代周会，我们先快速过一下今天的议程。" },
    { start: 8,   end: 18,  speaker: "lin",  text: "今天主要四块内容：需求评审、技术方案、设计走查，最后是测试与发布计划。" },
    { start: 18,  end: 26,  speaker: "wang", text: "收到，那我这边先把上一轮遗留的两个问题同步一下。" },
    { start: 26,  end: 38,  speaker: "wang", text: "第一个是移动端白屏问题，定位到是缓存策略导致的，修复已经上线。" },
    { start: 38,  end: 48,  speaker: "wang", text: "第二个是推送服务偶发超时，我们加了重试和熔断，目前灰度观察中。" },
    { start: 48,  end: 58,  speaker: "chen", text: "好的，那我们就进入第一个议题，需求评审。" },
    { start: 58,  end: 70,  speaker: "lin",  text: "这版的重点是新版工作台首页，目标是提升任务查找效率。" },
    { start: 70,  end: 80,  speaker: "lin",  text: "我们会把高频操作做成快捷卡片，并且支持自定义排序。" },
    { start: 80,  end: 92,  speaker: "wang", text: "需求上有个问题，自定义排序的同步策略是实时还是手动保存？" },
    { start: 92,  end: 102, speaker: "lin",  text: "建议手动保存，避免用户拖动过程中频繁发请求。" },
    { start: 102, end: 112, speaker: "chen", text: "同意，另外卡片密度建议提供紧凑和舒适两档，适配不同屏幕。" },
    { start: 112, end: 124, speaker: "wang", text: "我补充一点，首页首屏加载时间目前是 2.8 秒，这版目标压到 1.5 秒以内。" },
    { start: 124, end: 134, speaker: "liu",  text: "可以，我们会加接口缓存和骨架屏，首屏体验应该能明显改善。" },
    { start: 134, end: 144, speaker: "lin",  text: "好的，那需求评审这边先到这里，有问题随时找我同步。" },
    { start: 144, end: 154, speaker: "wang", text: "下一个议题，搜索功能的架构方案。" },
    { start: 154, end: 166, speaker: "wang", text: "我们计划引入独立的搜索服务，数据通过消息队列同步，保证低延迟。" },
    { start: 166, end: 178, speaker: "liu",  text: "同步延迟大概是多少？用户搜索到最新数据的容忍度如何？" },
    { start: 178, end: 188, speaker: "wang", text: "目标做到秒级以内，大部分场景希望 500 毫秒内可见。" },
    { start: 188, end: 198, speaker: "liu",  text: "那需要准备重建索引的兜底机制，建议支持全量重灌。" },
    { start: 198, end: 208, speaker: "wang", text: "没问题，我们会加一个索引重建任务，并且做双读校验。" },
    { start: 208, end: 218, speaker: "chen", text: "搜索结果页的样式我这边已经有初稿，稍后走查的时候一起看。" },
    { start: 218, end: 228, speaker: "chen", text: "接下来我们走查新版个人中心的几个页面。" },
    { start: 228, end: 240, speaker: "chen", text: "主要改动是信息层级，把个人资料和偏好设置拆开，更清晰。" },
    { start: 240, end: 252, speaker: "lin",  text: "视觉上没问题，但设置项层级太深，用户要多点两次才能到达。" },
    { start: 252, end: 264, speaker: "chen", text: "我调整一下，把最常用的通知和隐私设置提到第一层。" },
    { start: 264, end: 276, speaker: "wang", text: "另外深色模式下的文字对比度有些不足，需要再补一轮走查。" },
    { start: 276, end: 286, speaker: "chen", text: "收到，我会在下周三之前更新设计稿，并同步给开发。" },
    { start: 286, end: 296, speaker: "zhao", text: "最后同步一下测试与发布计划。" },
    { start: 296, end: 308, speaker: "zhao", text: "本周五冻结功能，下周一进入全量回归，预计需要两天。" },
    { start: 308, end: 318, speaker: "zhao", text: "新增用例 46 条，重点覆盖搜索和首页相关模块。" },
    { start: 318, end: 330, speaker: "wang", text: "回归期间如果有阻塞问题，直接拉我进缺陷群，我会第一时间处理。" },
    { start: 330, end: 340, speaker: "liu",  text: "数据埋点会在周三之前全部上线，方便回归期间监控指标。" },
    { start: 340, end: 352, speaker: "lin",  text: "那最后我们总结一下行动项。" },
    { start: 352, end: 362, speaker: "lin",  text: "王磊负责搜索架构评审和首屏优化，周五之前给出结论。" },
    { start: 362, end: 372, speaker: "lin",  text: "陈静下周三更新设计稿，赵明跟进全量回归，有问题及时反馈。" },
    { start: 372, end: 382, speaker: "lin",  text: "刘洋负责埋点和索引重建方案，整理后同步到共享文档。" },
    { start: 382, end: 395, speaker: "lin",  text: "感谢大家，这周辛苦，我们下周三下午三点继续，散会。" }
  ]
};