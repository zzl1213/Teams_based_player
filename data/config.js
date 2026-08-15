// ============================================================
// 会议回放配置
// 修改此文件即可替换为自己的会议数据：
//   - videoUrl: 视频地址（可填远程 URL 或留空后用本地文件）
//   - speakers: 发言人信息
//   - chapters: 章节（可选）
//   - transcript: 逐字稿数组 [{ start, end, speaker, text }]
// 默认无逐字稿：右侧 Transcript 显示为空，导入自己的 JSON / VTT / SRT 后自动填充
// ============================================================
window.MEETING_CONFIG = {
  title: "会议回放",
  date: "",
  participants: 0,
  duration: 0,

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

  chapters: [],

  transcript: []
};