@echo off
:: 强制将工作目录切换到 bat 文件所在的文件夹
cd /d "%~dp0"
:: 设置字符集为 UTF-8
chcp 65001 >nul
title OSU 选课监控启动器 / OSU Course Monitor Launcher

:: ================= 1. 检测 Node.js =================
:: 尝试直接运行 node
node -v >nul 2>&1
if %errorlevel% equ 0 goto CHECK_MODULES

:: 尝试去默认安装路径找，防止环境变量没刷新
if exist "%ProgramFiles%\nodejs\node.exe" (
    set "PATH=%PATH%;%ProgramFiles%\nodejs"
    goto CHECK_MODULES
)

:: 如果上面都没找到，说明真没装，开始安装
echo [警告] 未检测到 Node.js 环境！(Node.js not found!)
echo 正在尝试使用 Windows 包管理器自动安装...
winget install OpenJS.NodeJS
echo.
echo --------------------------------------------------------
echo [重要] Node.js 安装程序已执行完毕！
echo 脚本将在 10 秒后自动重启以应用更改...
echo (也可按任意键跳过倒计时直接重启)
echo --------------------------------------------------------
:: 倒计时 10 秒
timeout /t 10
:: 重新打开本脚本（%~f0 代表当前脚本的完整路径）
start "" "%~f0"
:: 关闭当前的旧窗口
exit

:: ================= 2. 检测依赖包 =================
:CHECK_MODULES
if exist "node_modules\" goto MENU

echo.
echo [提示] 未检测到运行依赖，正在自动为您安装... 
echo (Installing required packages...)
call npm install node-fetch chalk nodemailer dotenv
echo.
echo 依赖安装完成！

:: ================= 3. 语言选择菜单 =================
:MENU
echo.
echo ==================================================
echo 请选择界面语言 (Please select your language):
echo.
echo [1] 中文 (Chinese)
echo [2] English
echo ==================================================
set /p choice="请输入 1 或 2 然后按回车 (Enter 1 or 2): "

if "%choice%"=="1" goto RUN_CN
if "%choice%"=="2" goto RUN_EN

echo.
echo [错误] 输入无效，请重新输入。(Invalid input, try again.)
goto MENU

:RUN_CN
echo.
echo 正在启动中文版监控程序...
node checkCourseatAvailable.js
goto END

:RUN_EN
echo.
echo Starting English version monitor...
node ENcheckCourseSeatAvailable.js
goto END

:END
pause