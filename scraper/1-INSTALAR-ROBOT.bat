@echo off
cd /d "%~dp0"
set PLAYWRIGHT_BROWSERS_PATH=0
echo ============================================================
echo   STAC - Instalacion del robot de precios (solo una vez)
echo ============================================================
echo.
echo Esto descarga lo necesario. Tarda unos minutos la primera vez.
echo No cierres la ventana hasta que diga LISTO.
echo.
call npm install
call npx playwright install chromium
echo.
echo ============================================================
echo   LISTO. Ya puedes usar  2-ACTUALIZAR-PRECIOS.bat
echo ============================================================
pause
