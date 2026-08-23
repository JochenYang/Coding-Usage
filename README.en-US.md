<p align="center">
  <img src="./assets/images/banner_en.png" alt="Coding Usage" width="100%" />
</p>

<h1 align="center">Coding Usage · Multi-Platform AI Usage Dashboard</h1>

<p align="center"><a href="./README.md">中文</a> | English</p>

<p align="center">View <strong>plan quotas</strong> and <strong>account balances</strong> for multiple AI coding services on a single dashboard.</p>

<p align="center">Pure static · No backend · No tracking · All data stays in your browser</p>

<p align="center">
  <img src="https://img.shields.io/badge/Vite-7.0-646CFF?style=flat-square&logo=vite" alt="Vite" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-5.5-3178C6?style=flat-square&logo=typescript" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Tailwind-4.0-06B6D4?style=flat-square&logo=tailwindcss" alt="Tailwind" />
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License" /></a>
</p>

---

## Supported Providers

| Provider | Type | Description |
|---|---|---|
| **OpenCode Zen Go** | Plan quota | 5h rolling / weekly / monthly windows |
| **Z.ai (Zhipu GLM)** | Plan quota | 5h / weekly windows + MCP monthly calls; China + International |
| **Kimi / Moonshot** | Account balance | Cash + vouchers; CNY (China) / USD (International) |
| **DeepSeek** | Account balance | Multi-currency (CNY / USD), topped-up + granted |
| **SiliconFlow** | Account balance | Total = balance + chargeBalance |
| **OpenRouter** | Credits balance | Remaining = total purchases − usage |
| **MiniMax Token Plan** | Plan quota | Subscription key 5h / weekly window + video bonus |

## Features

- **Multi-account management**: Add multiple accounts per provider with independent API keys and aliases
- **Smart refresh**: Only refresh changed entries when closing settings; silent auto-refresh without loading flash
- **Full i18n**: Chinese / English toggle, all text updates instantly
- **Theme modes**: Light / Dark / System follow, favicon adapts
- **Multi-currency filter**: DeepSeek and others support currency filtering
- **beUI components**: Select / Popover / Switch / Drawer / Loader with spring animations
- **Pure frontend**: Keys stored in browser localStorage only, requests go directly to each provider's API

## Quick Start

```bash
npm install
npm run dev        # Open http://localhost:5173
npm run build      # Output is pure static dist/
```

## Adding a New Provider

1. Create an adapter in `src/providers/` implementing `ProviderDef`
2. Register it in `src/providers/registry.ts`
3. If the API lacks CORS, add the domain to `proxy.mjs` whitelist

## Tech Stack

| Layer | Tech |
|---|---|
| **Framework** | React 19 + Vite 7 |
| **Language** | TypeScript 5 strict |
| **Styling** | Tailwind CSS v4 (`@theme` token driven) |
| **Animation** | `motion/react` + beui.dev |
| **Icons** | `lucide-react` + `lobehub icons` CDN |
| **State** | React hooks + `localStorage` |

## License

MIT