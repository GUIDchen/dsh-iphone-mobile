# Contributing

## 开发环境

- Node.js 22 及以上
- macOS 或 Linux
- 本地已有可运行的 dsh web（默认 http://127.0.0.1:3080）

## 改动前

1. 先读 docs/架构与协议.md，尤其是事件序号契约：新增任何流式能力都必须走同一套序号与回放机制。
2. 涉及接入方式的改动，同步更新 docs/接入手册.md。

## 提交前自检

~~~bash
bash -n scripts/*.sh
node --check scripts/check-stream.mjs
node scripts/check-stream.mjs --selftest
~~~

## 提交规范

- 一个提交只做一件事，提交信息用祈使句。
- 不提交 .env、密钥、日志与本机路径。
