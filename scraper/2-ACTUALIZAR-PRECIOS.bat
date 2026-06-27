@echo off
cd /d "%~dp0"
echo ============================================================
echo   STAC - Actualizando precios de proveedores...
echo   (No cierres esta ventana, tarda unos minutos)
echo ============================================================
echo.
node check-precios.js
echo.
echo ============================================================
echo   Terminado. Revisa el Panel Admin - Precios de proveedores.
echo ============================================================
pause
