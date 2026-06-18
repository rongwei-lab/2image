## 2image-v0.6.8.1（2026-06-18）

### 修复
- **修复云端 Agent 图片任务一直转圈**
  - 服务端现在会把 Responses API 中 `image_generation_call` 的失败事件转发给前端。
  - 前端收到 `image_tool_failed` 后会及时结束对应图片任务并展示失败原因，避免任务卡在“生成中”。

### 验证
- 已通过 Agent 图片失败事件相关回归测试。
- 已在家庭服务器完成 Docker Compose 重建与 Web/API 健康检查。
