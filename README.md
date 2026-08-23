<p align="center">
  <img src="./assets/images/banner_cn.png" alt="Coding Usage" width="100%" />
</p>

<h1 align="center">Coding Usage · 多平台 AI 用量面板</h1>

<p align="center"><a href="./README.en-US.md">English</a> | 中文</p>

<p align="center">在统一面板上查看多家 AI 编程服务的<strong>套餐配额</strong>与<strong>账户余额</strong>。</p>

<p align="center">纯静态 · 无后端 · 无追踪 · 数据仅存于本浏览器</p>

<p align="center">
  <img src="https://img.shields.io/badge/Vite-7.0-646CFF?style=flat-square&logo=vite" alt="Vite" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-5.5-3178C6?style=flat-square&logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Tailwind-4.0-06B6D4?style=flat-square&logo=tailwindcss" alt="Tailwind" />
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License" /></a>
</p>

---

## 支持的 Provider

| Provider | 类型 | 说明 |
|---|---|---|
| **OpenCode Zen Go** | 套餐配额 | 5h 滚动 / 每周 / 每月窗口 |
| **Z.ai（智谱 GLM）** | 套餐配额 | 5h / 每周窗口 + MCP 月度次数；国内 + 国际站 |
| **Kimi / Moonshot** | 账户余额 | 现金 + 代金券；国内站 CNY / 国际站 USD |
| **DeepSeek** | 账户余额 | 多币种（CNY / USD），区分充值与赠送 |
| **SiliconFlow** | 账户余额 | 总余额 = 充值 + 赠送 |
| **OpenRouter** | Credits 余额 | 剩余 = 累计充值 − 已用 |
| **MiniMax Token Plan** | 套餐配额 | 订阅 Key 的 5h / 周窗口 + 视频赠送 |

## 功能

- **多账号管理**：每个 Provider 支持添加多个账号，独立配置 API Key 与别名
- **智能刷新**：关闭设置时仅刷新配置变化的条目；定时自动刷新静默更新，不闪 loading
- **全站国际化**：中文 / 英文一键切换，所有文案随语言切换同步更新
- **主题模式**：浅色 / 深色 / 跟随系统，favicon 同步适配
- **多币种过滤**：DeepSeek 等支持按币种筛选显示余额
- **beUI 组件库**：Select / Popover / Switch / Drawer / Loader 均使用 spring 动效
- **纯前端**：Key 仅存于浏览器 localStorage，请求由浏览器直连各官方接口

## 快速开始

```bash
npm install
npm run dev        # 打开 http://localhost:5173
npm run build      # 产物为纯静态 dist/
```

## 新增 Provider

1. 在 `src/providers/` 新建 adapter，实现 `ProviderDef`
2. 在 `src/providers/registry.ts` 注册
3. 若接口不支持 CORS，在 `proxy.mjs` 白名单追加域名

## 技术栈

| 层 | 技术 |
|---|---|
| **框架** | React 19 + Vite 7 |
| **语言** | TypeScript 5 strict |
| **样式** | Tailwind CSS v4（`@theme` token 驱动） |
| **动画** | `motion/react` + beui.dev |
| **图标** | `lucide-react` + `lobehub icons` CDN |
| **状态** | React hooks + `localStorage` |

## 许可

MIT