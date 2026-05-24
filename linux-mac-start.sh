#!/bin/bash

# 强制将工作目录切换到脚本所在的文件夹
cd "$(dirname "$0")"

echo -e "\033[36m=== OSU 选课监控启动器 / OSU Course Monitor Launcher ===\033[0m"

# ================= 1. 检测与安装 Node.js =================
# 首先尝试加载可能已经安装但未激活的 nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

if ! command -v node &> /dev/null; then
    echo -e "\033[31m[警告] 未检测到 Node.js 环境！(Node.js not found!)\033[0m"
    echo -e "\033[33m正在为您自动安装 Node.js (通过 nvm)... / Auto-installing Node.js via nvm...\033[0m"
    
    # 检测是否安装了 curl
    if ! command -v curl &> /dev/null; then
        echo -e "\033[31m[错误 / Error] 缺少 'curl' 命令 ('curl' command is missing)。\033[0m"
        echo -e "\033[31m请先通过包管理器安装 curl / Please install curl first (e.g., sudo apt install curl).\033[0m"
        exit 1
    fi

    # 下载并安装 nvm
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    
    # 动态加载 nvm 到当前会话 (代替重启 shell)
    \. "$NVM_DIR/nvm.sh"
    
    # 下载并安装 Node.js v25
    nvm install 25
    
    # 验证是否安装成功
    if ! command -v node &> /dev/null; then
        echo -e "\033[31m[错误 / Error] Node.js 自动安装失败 / Node.js auto-installation failed.\033[0m"
        echo -e "\033[31m请查阅报错信息手动安装 / Please check the error logs and install manually.\033[0m"
        exit 1
    fi
    echo -e "\033[32mNode.js 安装成功！(Installed successfully!) 当前版本 (Current version): $(node -v)\033[0m"
    echo -e "\033[32mnpm 安装成功！(Installed successfully!) 当前版本 (Current version): $(npm -v)\033[0m"
fi

# ================= 2. 检测依赖包 =================
if [ ! -d "node_modules" ]; then
    echo -e "\n\033[33m[提示] 未检测到运行依赖，正在自动为您安装... (Installing required packages...)\033[0m"
    npm install
    echo -e "\033[32m依赖安装完成！(Dependencies installed successfully!)\033[0m\n"
fi

# ================= 3. 语言选择菜单 =================
while true; do
    echo "=================================================="
    echo "请选择界面语言 (Please select your language):"
    echo ""
    echo " [1] 中文 (Chinese)"
    echo " [2] English"
    echo " [3] 退出程序 (Exit)"
    echo "=================================================="
    read -p "请输入 1, 2 或 3 然后按回车 (Enter 1, 2, or 3): " choice

    if [ "$choice" == "1" ]; then
        echo -e "\n\033[32m正在启动中文版监控程序...\033[0m"
        node allInOne.js
        break
    elif [ "$choice" == "2" ]; then
        echo -e "\n\033[32mStarting English version monitor...\033[0m"
        node ENallInOne.js
        break
    elif [ "$choice" == "3" ]; then
        echo -e "\n\033[33m已退出程序。(Program exited.)\033[0m"
        exit 0
    else
        echo -e "\n\033[31m[错误] 输入无效，请重新输入。(Invalid input, please try again.)\033[0m\n"
    fi
done