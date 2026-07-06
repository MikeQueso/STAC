@echo off
rem STAC - Corrida diaria del robot de precios (Programador de tareas de Windows).
rem Corre desde la IP de casa, que si encuentra todos los precios (GitHub Actions
rem tiene IPs de servidor que los sitios bloquean parcialmente).
cd /d "C:\Users\Mikeu\Documents\STAC\scraper"
rem rotar bitacora si pasa de 2 MB
for %%A in (robot-diario.log) do if %%~zA GTR 2000000 del robot-diario.log
echo ===== Corrida %date% %time% ===== >> robot-diario.log
node check-precios.js >> robot-diario.log 2>&1
rem regenerar las paginas de compartir (imagen/precio en WhatsApp) y publicarlas si cambiaron
node generar-paginas-compartir.js >> robot-diario.log 2>&1
git -C .. add p >> robot-diario.log 2>&1
git -C .. diff --cached --quiet || (
  git -C .. commit -m "Robot: paginas de compartir actualizadas" >> robot-diario.log 2>&1
  git -C .. push origin main >> robot-diario.log 2>&1
)
echo. >> robot-diario.log
