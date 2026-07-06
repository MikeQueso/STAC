@echo off
rem STAC - Registra la corrida diaria del robot de precios (doble clic UNA vez).
rem Crea una tarea de Windows: todos los dias 8:30am, y si la PC estaba apagada,
rem corre en cuanto se encienda. Corre sin abrir ventanas y deja bitacora en
rem robot-diario.log.
powershell -NoProfile -Command ^
  "$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '\"C:\Users\Mikeu\Documents\STAC\scraper\robot-diario-silencioso.vbs\"' -WorkingDirectory 'C:\Users\Mikeu\Documents\STAC\scraper';" ^
  "$trigger = New-ScheduledTaskTrigger -Daily -At 8:30am;" ^
  "$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew;" ^
  "Register-ScheduledTask -TaskName 'STAC Robot de Precios' -Action $action -Trigger $trigger -Settings $settings -Description 'Robot de precios STAC: diario 8:30am desde casa; si la PC estaba apagada corre al encenderla.' -Force | Out-Null;" ^
  "Write-Host 'Tarea registrada. Proxima corrida:' (Get-ScheduledTaskInfo -TaskName 'STAC Robot de Precios').NextRunTime"
echo.
echo Listo. El robot correra todos los dias a las 8:30am (o al encender la PC).
pause
