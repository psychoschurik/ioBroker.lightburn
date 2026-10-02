@echo off
setlocal

echo LightBurn REST pairing helper for ioBroker.lightburn
echo.
echo 1. Start LightBurn on this computer.
echo 2. Run this helper on the same computer.
echo 3. Confirm the LightBurn consent dialog within 30 seconds.
echo 4. Paste the copied secret into the ioBroker adapter setting "REST API secret".
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $body=@{application_name='ioBroker.lightburn'; capabilities=@('state','project','upload')} | ConvertTo-Json -Compress; $response=Invoke-RestMethod -Uri 'http://127.0.0.1:19520/api/connect' -Method Post -ContentType 'application/json' -Body $body; if(-not $response.secret){ throw 'LightBurn returned no secret.' }; $response.secret | Set-Clipboard; Write-Host ''; Write-Host 'Secret copied to clipboard:'; Write-Host $response.secret; Write-Host ''; Write-Host 'Paste it into the ioBroker adapter setting REST API secret.'"

if errorlevel 1 (
    echo.
    echo Pairing failed. Check that LightBurn is open and try again.
)

echo.
pause
