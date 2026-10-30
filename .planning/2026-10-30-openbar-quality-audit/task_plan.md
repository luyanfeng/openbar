# Task Plan: Open Bar 全面质量审查

## Goal
对 Open Bar GNOME Shell 扩展做全面质量审查，拉出清单后逐项分析确认是否需要修复/优化，避免再出现上次那种导致会话崩溃的致命错误（schema 与代码不同步引发 SIGABRT）。

## Next Step
已将审查清单与修复写入 findings.md 并同步本地扩展目录；下一步提交修复。

## Current Phase
Phase 3: 修复（已完成）；Phase 4: 验证与交付（进行中）

## Phases

### Phase 1: 清单拉取（Discovery）
- [x] 盘点文件/行数/功能入口
- [x] 拆 4 个专项：① schema-code 一致性 ② 生命周期/资源泄漏 ③ Wallhub 集成完整性 ④ 错误处理规范
- [x] 写入 findings.md 初步清单
- **Status:** complete

### Phase 2: 逐项分析确认
- [x] 专项① schema-code 一致性：gjs has_key 核对 290 key，全部存在，动态 key 边界匹配
- [x] 专项② 生命周期：connect/timer/injection 清理路径核对
- [x] 专项③ Wallhub：发现注入清理丢失原函数（高危）+ 重入/异步拒绝/空值
- [x] 专项④ 错误处理：裸 catch 多为防御性，可接受
- **Status:** complete

### Phase 3: 修复（仅确认需要且低风险的项）
- [x] wallhub.js: 注入原函数存储（防 _addBackgroundMenu 丢失）— 高危
- [x] wallhub.js: enable 重入守卫
- [x] wallhub.js: 异步拒绝补 .catch
- [x] wallhub.js: updateQueue/setWallpaper 空值与缺失文件防护
- [x] 重新编译 schema 并完整同步本地扩展目录（含 gschemas.compiled）
- [x] 语法/逻辑验证
- **Status:** complete

### Phase 4: 验证与交付
- [x] 全量 JS 语法检查
- [x] gschema --strict 校验
- [x] gjs 逻辑单测 + has_key 校验
- [ ] 提交修复（待执行）
- **Status:** in_progress
