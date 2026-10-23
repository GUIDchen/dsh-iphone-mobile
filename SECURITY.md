# Security Policy

## 设计边界

本项目把本机 DeepSeek Harness 暴露给手机，安全模型有三条硬约束：

1. dsh web 永远只监听 127.0.0.1，任何情况下都不要改成对外监听；对外入口只能由隧道提供。
2. 不要使用免鉴权的公网隧道。Cloudflare Tunnel 必须叠加 Access 身份策略；Tailscale 必须保持设备级鉴权。
3. 密钥只存在于 .env 与本地文件系统：VAPID 私钥、APNs 的 .p8、隧道凭据目录都不得入库。

## 已实现的防护

- 访问令牌换 HttpOnly Cookie；令牌为 32 字节随机值，存于 ~/.dsh-mobile/token（0600）。
- 登录失败限流：同一来源连续失败达到阈值后返回 429（Retry-After），但**持有正确令牌始终放行**，
  避免把主人自己锁在门外。阈值与时长可用 LOGIN_MAX_FAILURES / LOGIN_LOCK_MS 调整。
- 经隧道（x-forwarded-proto: https）访问时，Cookie 自动附加 Secure。
- 静态移动端资产（manifest、图标、样式、脚本）可匿名读取；推送与状态接口一律要求 Cookie。
- 目录穿越请求被拒（静态服务限定在 public 目录内）。

## 上报漏洞

请通过仓库的私密安全通告（Security Advisories）或维护者邮箱上报，不要在公开 Issue 中披露可利用细节。
