@echo off
echo ================================================
echo     SAHAYOG - Mental Health Support Setup
echo ================================================
echo.

echo [1/3] Checking Ollama installation...
where ollama >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Ollama is not installed!
    echo Please install from: https://ollama.ai
    pause
    exit /b 1
)
echo OK - Ollama is installed
echo.

echo [2/3] Creating Sahayog model...
echo.
ollama create sahayog -f Modelfile 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Model already exists or creation had warnings
)
echo.
echo OK - Model ready
echo.

echo [3/3] Installing dependencies...
cd /d "%~dp0"
npm install
echo.
echo OK - Dependencies installed
echo.

echo ================================================
echo Setup complete!
echo.
echo To start the server, run:
echo   npm start
echo.
echo Then open: http://localhost:3000
echo ================================================
echo.
pause
