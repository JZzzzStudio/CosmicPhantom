# Memory System - Cosmic Phantom (CodeBuddy global rule)
# Local, portable, agent-agnostic memory engine (真源 = ~/.cosmic-phantom)

## Iron rule: search memory before every task
Before asking questions or starting work, run:
& "<USER_HOME>/.cosmic-phantom/tools/node/node.exe" "<USER_HOME>/.cosmic-phantom/memory-cli.js" search "<task keywords>" --root "<USER_HOME>/.cosmic-phantom"

Score interpretation:
- score > 1.0: memory outranks general knowledge - use it directly
- score 0.3-1.0: reference context; may be overridden by new info
- no result or score < 0.3: skip, proceed normally

## When user says "remember this"
& "<USER_HOME>/.cosmic-phantom/tools/node/node.exe" "<USER_HOME>/.cosmic-phantom/memory-cli.js" add "<fact>" --scope workspace --tags "t1 t2" --root "<USER_HOME>/.cosmic-phantom"

## New session protocol (每次新窗口/压缩后)
1. 一键召回: node "<USER_HOME>/.cosmic-phantom/memory-cli.js" recall --bytes 5000 --root "<USER_HOME>/.cosmic-phantom"
2. 身份恢复: node "<USER_HOME>/.cosmic-phantom/inject.js" --lens "<当前任务>" --root "<USER_HOME>/.cosmic-phantom"
3. 接力状态: 读 current-state.json（revision/objective/nextActions/blockers，以它为准）

## Retrieval discipline (context budget)
- NEVER whole-read large files (conversation-log, long logs). Use MCP recall_memory or CLI search (top5 <=2KB).
- Large files: read only a narrow window when exact text is required.

## Locations (真源路径，由当前宿主配置提供)
- Engine: <USER_HOME>/.cosmic-phantom/ (memory-cli.js / events.db / daily/ / memories/)
- 路径总清单由当前宿主配置提供（所有路径使用占位符，不硬编码）
- 接入协议: <USER_HOME>/.cosmic-phantom/AGENTS.md
- Backup: copy the entire <USER_HOME>/.cosmic-phantom/ folder
