# capture.ps1 — 보이스룸 켜기 HTTP 캡처 원클릭 (Windows + BlueStacks)
#
# 하는 일(손 안 대도 됨):
#   1) adb 를 찾아 BlueStacks 에 붙는다
#   2) 기기 arch 에 맞는 frida-server 를 (설치된 frida 버전과 똑같이) 자동 내려받아 올리고 실행
#   3) capture-voiceroom.js 로 카톡을 띄워 캡처 시작
#
# 쓰기 전 한 번만: BlueStacks 설정 > 고급 > "Android 디버그 브리지(ADB)" 켜기(루트도 켜져 있어야 함).
#   그리고 PC 에 Python + frida 설치:  pip install frida-tools
#
# 실행:  PowerShell 에서 이 파일이 있는 폴더로 cd 한 뒤
#   powershell -ExecutionPolicy Bypass -File .\capture.ps1
# (차단되면 위처럼 -ExecutionPolicy Bypass 를 붙이면 됩니다)

$ErrorActionPreference = 'Stop'
$pkg = 'com.kakao.talk'
$script = Join-Path $PSScriptRoot 'capture-voiceroom.js'
$work = $PSScriptRoot

function Find-Adb {
  $c = Get-Command adb -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @(
    "$env:ProgramFiles\BlueStacks_nxt\HD-Adb.exe",
    "${env:ProgramFiles(x86)}\BlueStacks_nxt\HD-Adb.exe",
    "$env:ProgramFiles\BlueStacks_nxt\Engine\HD-Adb.exe",
    "$env:ProgramFiles\BlueStacks\HD-Adb.exe"
  )) { if (Test-Path $p) { return $p } }
  throw "adb 를 못 찾았어요. BlueStacks 설정에서 ADB 를 켰는지 확인하거나, adb 를 PATH 에 넣어 주세요."
}

$adb = Find-Adb
Write-Host "adb: $adb"

# BlueStacks 에 붙기(이미 붙어 있으면 그대로, 아니면 흔한 포트들 시도)
& $adb start-server | Out-Null
$have = (& $adb devices) -match "`tdevice$"
if (-not $have) {
  foreach ($port in 5555,5556,5565,5575,5585,5037) {
    & $adb connect "127.0.0.1:$port" 2>&1 | Out-Null
  }
  Start-Sleep -Milliseconds 500
}
$serial = ((& $adb devices) | Select-String "`tdevice$" | ForEach-Object { ($_ -split "`t")[0] } | Select-Object -First 1)
if (-not $serial) { throw "기기를 못 잡았어요. BlueStacks 가 켜져 있고 ADB 가 켜졌는지 확인해 주세요 ($adb devices 결과 비어 있음)." }
Write-Host "기기: $serial"
$A = @('-s', $serial)

# frida 버전 확인(없으면 설치 안내)
try { $fver = (& frida --version).Trim() } catch { throw "frida 가 없어요.  pip install frida-tools  로 먼저 설치해 주세요." }
Write-Host "frida: $fver"

# 기기 arch
$abi = (& $adb @A shell getprop ro.product.cpu.abi).Trim()
$arch = if ($abi -match 'x86_64') { 'x86_64' } elseif ($abi -match 'x86') { 'x86' } elseif ($abi -match 'arm64') { 'arm64' } else { 'x86_64' }
Write-Host "기기 arch: $abi -> frida-server-$arch"

# frida-server 준비(없으면 버전·arch 맞춰 다운로드, .xz 는 Python lzma 로 해제)
$fsLocal = Join-Path $work "frida-server-$fver-android-$arch"
if (-not (Test-Path $fsLocal)) {
  $xz = "$fsLocal.xz"
  $url = "https://github.com/frida/frida/releases/download/$fver/frida-server-$fver-android-$arch.xz"
  Write-Host "frida-server 다운로드: $url"
  Invoke-WebRequest -Uri $url -OutFile $xz
  # .xz 해제 (Python 은 frida 설치 전제라 반드시 있음)
  python -c "import lzma,shutil,sys; shutil.copyfileobj(lzma.open(sys.argv[1]),open(sys.argv[2],'wb'))" $xz $fsLocal
  Remove-Item $xz -ErrorAction SilentlyContinue
}

# 이미 떠 있으면 재사용, 아니면 올리고 실행
$running = (& $adb @A shell "pidof frida-server") 2>$null
if (-not $running) {
  Write-Host "frida-server 올리는 중…"
  & $adb @A push $fsLocal /data/local/tmp/frida-server | Out-Null
  & $adb @A shell "chmod 755 /data/local/tmp/frida-server" | Out-Null
  # 백그라운드로(이 창을 막지 않게 숨김 프로세스로 실행)
  Start-Process -WindowStyle Hidden -FilePath $adb -ArgumentList ($A + @('shell', '/data/local/tmp/frida-server'))
  Start-Sleep -Seconds 2
  Write-Host "frida-server 실행됨"
} else {
  Write-Host "frida-server 이미 실행 중(pid $running) — 재사용"
}

Write-Host ""
Write-Host "==================================================================="
Write-Host " 카톡을 띄워 캡처를 시작합니다. 창이 뜨면:"
Write-Host "   오픈채팅방 > 보이스룸 켜기 한 번 > ★ 가 붙은 [REQ]/[RES] 블록 복사"
Write-Host "   멈추려면 이 창에서 Ctrl+C"
Write-Host "==================================================================="
Write-Host ""

& frida -U -f $pkg -l $script --no-pause
