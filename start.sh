#!/bin/bash

# Gemini Browser API 启动脚本
# 同时启动带调试端口的 Chrome 和 Node.js 服务器

echo "🚀 Starting Gemini Browser API..."

# Chrome 用户数据目录（保存登录状态）
CHROME_USER_DATA="$HOME/.config/google-chrome-gemini"

# 检查 Chrome 是否已经在调试端口运行
if curl -s http://localhost:9222/json/version > /dev/null 2>&1; then
    echo "✅ Chrome already running on port 9222"
else
    echo "🌐 Starting Chrome with remote debugging..."
    
    # 启动 Chrome（后台运行）
    google-chrome \
        --remote-debugging-port=9222 \
        --user-data-dir="$CHROME_USER_DATA" \
        "https://gemini.google.com/app" \
        &>/dev/null &
    
    # 等待 Chrome 启动
    echo "⏳ Waiting for Chrome to start..."
    for i in {1..30}; do
        if curl -s http://localhost:9222/json/version > /dev/null 2>&1; then
            echo "✅ Chrome started successfully"
            break
        fi
        sleep 1
    done
    
    if ! curl -s http://localhost:9222/json/version > /dev/null 2>&1; then
        echo "❌ Failed to start Chrome. Please start it manually:"
        echo "   google-chrome --remote-debugging-port=9222"
        exit 1
    fi
fi

# 启动 Node.js 服务器
echo "📦 Starting Node.js server..."
cd "$(dirname "$0")"
npm run dev
