---
name: visualize-context
description: 把当前 WorkBuddy 对话、宿主实际授权读取的其他任务或用户提供的规划整理成神都猫脉络图，并支持后续增量更新和版本回看。想回顾初心、梳理分支、查看决定原因或追踪未完成事项时使用。
---

# 神都猫脉络 · WorkBuddy

把线性聊天整理成可追溯、可继续生长的结构，不要改写或伪造证据。

## 工作流

1. 确认来源与范围。当前内容已在上下文中时可以直接整理；其他 WorkBuddy 任务或 Codex 对话只有在用户明确指定、且当前宿主确实提供读取能力或用户提供内容时才能使用。插件不会自动读取其他产品的历史。
2. 判断是新图还是续写。没有 `mapId` 时建立新图；已有 `mapId` 时先调用 `get_context_map` 读取最新版及其 `revision`，只提炼这次真正新增或改变的内容。
3. 提炼一个总起点和若干主题。主题按“正在解决什么问题”分组，不按消息轮次机械切分；同一对话可以有多个顶层主题。
4. 新图调用 `prepare_context_map` 持久保存；已有图调用 `update_context_map` 原子应用语义操作。每次逻辑写入使用新的 `mutationId`，只有对完全相同请求的重试才复用原 `mutationId`。更新必须把刚读取到的 `revision` 作为 `expectedRevision`，并写清 `change.kind` 与 `change.summary`。
5. 更新发生版本冲突时，重新调用 `get_context_map` 读取最新版，核对差异后重建操作；不要提高 `expectedRevision` 后盲目覆盖。需要标记来源处理进度时，只根据真实读取结果填写 `sourceCheckpoint`。
6. 展示最新版时调用 `render_context_map`。该工具会启动仅监听本机的页面，并尝试自动在默认浏览器打开；若系统拦截自动打开，把工具返回的本机 URL 作为可点击链接交给用户。回看演变过程时，先用 `list_context_map_revisions` 查看修改原因，再用带 `revision` 的 `get_context_map` 或 `render_context_map` 打开指定历史版本；历史版本用于回看，不直接覆盖。
7. 文字结果中同时给出最重要的目标、转折和未完成事项。不要仅凭工具返回 URL 就声称浏览器已经显示；无法自动打开时如实说明，并提供该 URL。

## 证据与来源

- 每个节点的 `evidence` 必须符合内容来源：用户明确说过的是 `user-stated`；来自 AI 回复或报告的是 `assistant-reported`，不能当作已经发生的事实；基于多段来源压缩表述的是 `summary`；没有被直接陈述的判断是 `inference`；用户手工规划、而非从历史提取的内容是 `manual`。
- 对 `inference` 使用“归纳”“推测”或“待验证”等明确措辞。存在支持材料时填写对应 `sourceRefs`，但引用不应把推断伪装成原话。
- `sourceRefs` 只记录实际可见的来源。`taskId`、`turnId`、`messageId` 仅在宿主明确提供稳定标识时填写，绝不猜测或生成；没有稳定标识时可以只保留真实日期与简短 `excerpt`，完全没有来源时保持空数组。
- `sourceRefs.excerpt` 与节点 `quote` 必须忠实保留原语言和含义。地图级 `sourceTask` 只说明整体来源，不能替代节点级证据。
- `sourceCheckpoint` 的游标、最后 turn、时间与内容哈希只能来自实际读取结果；不具备这些信息时省略相应字段。

## 整理规则

- 不自动翻译或润色用户原文、历史摘录、代码、路径和命令。
- 不把 AI 的回复当作已经发生的事实；使用“AI 报告”“建议”“待验证”等准确表述。
- 多次“继续”或同一方向的小调整可以合并为阶段节点，但必须保留真正改变方向的转折。
- 没有证据的因果关系不要强行连接。
- 只有确有跨主题前置关系或汇合关系时才填写节点 `related`，其值指向另一个前置节点的 `id`；普通同主题顺序无需重复填写。
- 增量更新优先使用 `set_map`、`add_topic`、`update_topic`、`move_topic`、`delete_topic`、`add_node`、`update_node`、`move_node` 与 `delete_node` 表达意图，不重建整图。节点 ID 在全图中保持唯一，不自行改写已有 ID。
- 删除仍被 `related` 引用的节点前先确认语义；确需删除时才设置 `removeIncomingRelations: true` 清除入向关联。
- 优先保留初心、约束、决定理由、失败修正、汇合结论与下一步。
- 单张图建议不超过 8 个主题、每个主题不超过 12 个关键节点；更大的历史先分层摘要，再按需展开。

## 演示

用户只想体验界面时，直接调用 `render_context_map`，省略 `mapId` 即可打开只读虚构演示图。查找本机已保存地图时使用 `list_context_maps`。
