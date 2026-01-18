# Gemini Browser API

本地 API 服务器，通过浏览器自动化与 Gemini 交互。支持多账号配置。

## 安装

```bash
npm install
npx playwright install chromium
```

## 使用

### 1. 保存登录状态

```bash
# 默认账号
npm run save-auth

# 添加其他账号（如工作账号）
npm run save-auth -- --profile=work
```

浏览器会打开，登录你的 Google 账号，登录成功后自动保存。

### 2. 启动 API 服务器

```bash
npm start
```

### 3. API 端点

#### 发送消息（核心功能）
```bash
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "你好，介绍一下你自己", "profile": "default"}'
```

#### 列出可用账号
```bash
curl http://localhost:3000/profiles
```

#### 初始化账号浏览器
```bash
curl -X POST http://localhost:3000/init \
  -H "Content-Type: application/json" \
  -d '{"profile": "work"}'
```

#### 开始新对话
```bash
curl -X POST http://localhost:3000/new-chat \
  -H "Content-Type: application/json" \
  -d '{"profile": "default"}'
```

#### 服务状态
```bash
curl http://localhost:3000/health
```

## 多账号配置

1. 每个账号用不同的 profile 名保存：
   - `npm run save-auth` → 保存为 `default`
   - `npm run save-auth -- --profile=work` → 保存为 `work`

2. 发送消息时指定 profile：
   ```json
   {"message": "Hello", "profile": "work"}
   ```

## 项目结构

```
gemini-api/
├── src/
│   ├── server.js         # Express API 服务器
│   ├── gemini-browser.js # Playwright 浏览器自动化
│   └── save-auth.js      # 登录认证脚本
├── auth/                  # 认证文件 (gitignore)
│   ├── default.json
│   └── work.json
├── package.json
└── README.md
```
