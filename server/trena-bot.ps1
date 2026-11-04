# TRENA — портативный сервер + мост к Telegram Bot API
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$Root = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $PSScriptRoot 'config.json'
$StatePath = Join-Path $PSScriptRoot 'state.json'

if (-not (Test-Path $ConfigPath)) {
  Copy-Item (Join-Path $PSScriptRoot 'config.example.json') $ConfigPath
}

$Config = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$Token = ([string]$Config.botToken).Trim()
$PreferredPort = if ($Config.port) { [int]$Config.port } else { 8765 }
$DemoMode = [string]::IsNullOrWhiteSpace($Token) -or $Token -match 'ВСТАВЬТЕ|PASTE|YOUR_TOKEN|example'
$Api = if (-not $DemoMode) { "https://api.telegram.org/bot$Token" } else { $null }
$BotUsername = $null
$script:Port = $PreferredPort

function Test-TrenaUp([int]$p) {
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$p/api/status" -TimeoutSec 2
    return [bool]$r.ok
  } catch { return $false }
}

function Open-Browser([int]$p) {
  Start-Process "http://127.0.0.1:$p/"
}

# Уже запущен? Просто открыть браузер
foreach ($p in @($PreferredPort, 8765, 8766, 8767, 8768, 8770)) {
  if (Test-TrenaUp $p) {
    Write-Host ""
    Write-Host "TRENA уже работает: http://127.0.0.1:$p/" -ForegroundColor Green
    Write-Host "Открываю браузер..."
    Open-Browser $p
    Write-Host ""
    Write-Host "Это окно можно закрыть — сервер уже был запущен ранее."
    Write-Host "Если кабинет не открылся, вставьте ссылку в браузер вручную."
    exit 0
  }
}

function Read-State {
  if (Test-Path $StatePath) {
    try { return Get-Content $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
  }
  return [pscustomobject]@{ updateOffset = 0; chats = @(); inbox = @(); reports = @() }
}

function Save-State($state) {
  ($state | ConvertTo-Json -Depth 12) | Set-Content -Path $StatePath -Encoding UTF8
}

function Invoke-Tg($method, $body = $null) {
  if ($DemoMode) { throw 'Telegram недоступен: демо-режим' }
  $uri = "$Api/$method"
  if ($null -eq $body) {
    return Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec 35
  }
  $json = $body | ConvertTo-Json -Depth 12 -Compress
  return Invoke-RestMethod -Uri $uri -Method Post -Body $json -ContentType 'application/json; charset=utf-8' -TimeoutSec 35
}

function Ensure-Chat($state, $chat, $from) {
  $id = [string]$chat.id
  $existing = @($state.chats) | Where-Object { [string]$_.id -eq $id } | Select-Object -First 1
  $username = if ($from.username) { '@' + $from.username } else { $null }
  $name = (@($from.first_name, $from.last_name) | Where-Object { $_ }) -join ' '
  if (-not $existing) {
    $item = [pscustomobject]@{
      id = $id; username = $username; name = $name
      lastSeen = (Get-Date).ToString('s'); lastText = ''
    }
    $state.chats = @(@($state.chats) + $item)
    return $item
  }
  if ($username) { $existing.username = $username }
  if ($name) { $existing.name = $name }
  $existing.lastSeen = (Get-Date).ToString('s')
  return $existing
}

function Add-Inbox($state, $msg) {
  $entry = [pscustomobject]@{
    id = [string]$msg.message_id
    chatId = [string]$msg.chat.id
    username = if ($msg.from.username) { '@' + $msg.from.username } else { $null }
    name = (@($msg.from.first_name, $msg.from.last_name) | Where-Object { $_ }) -join ' '
    text = [string]$msg.text
    time = (Get-Date).ToString('HH:mm')
    ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
  $state.inbox = @(@($entry) + @($state.inbox) | Select-Object -First 200)
}

function Process-Updates($state) {
  if ($DemoMode) { return $state }
  $offset = [long]$state.updateOffset
  try { $resp = Invoke-Tg "getUpdates?timeout=0&offset=$offset" } catch { return $state }
  if (-not $resp.ok) { return $state }
  foreach ($u in @($resp.result)) {
    $state.updateOffset = [long]$u.update_id + 1
    if ($u.message -and $u.message.chat -and $u.message.chat.type -eq 'private') {
      $chat = Ensure-Chat $state $u.message.chat $u.message.from
      if ($u.message.text) {
        $chat.lastText = [string]$u.message.text
        Add-Inbox $state $u.message
        if ($u.message.text -match '^/start') {
          $hello = "Привет! Это бот <b>TRENA</b>.`n`nТренер будет присылать сюда планы.`nОтвечайте кнопками под тренировкой.`n`nВаш chat_id: <code>$($u.message.chat.id)</code>"
          try { Invoke-Tg 'sendMessage' @{ chat_id = $u.message.chat.id; text = $hello; parse_mode = 'HTML' } | Out-Null } catch {}
        }
      }
    }
    if ($u.callback_query) {
      $cq = $u.callback_query
      $data = [string]$cq.data
      $chatId = [string]$cq.message.chat.id
      Ensure-Chat $state $cq.message.chat $cq.from | Out-Null
      if ($data -match '^(done|part|miss):(\d+)$') {
        $map = @{ done = 'completed'; part = 'partial'; miss = 'missed' }
        $status = $map[$Matches[1]]
        $wid = [int]$Matches[2]
        $rep = [pscustomobject]@{
          id = [guid]::NewGuid().ToString('N')
          chatId = $chatId; workoutId = $wid; status = $status
          username = if ($cq.from.username) { '@' + $cq.from.username } else { $null }
          name = (@($cq.from.first_name, $cq.from.last_name) | Where-Object { $_ }) -join ' '
          time = (Get-Date).ToString('HH:mm')
          ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
          consumed = $false
        }
        $state.reports = @(@($rep) + @($state.reports) | Select-Object -First 200)
        $label = @{ completed = 'Выполнено'; partial = 'Частично'; missed = 'Пропущено' }[$status]
        try {
          Invoke-Tg 'answerCallbackQuery' @{ callback_query_id = $cq.id; text = "Отчёт: $label" } | Out-Null
          Invoke-Tg 'sendMessage' @{ chat_id = $chatId; text = "Принято: <b>$label</b>. Тренер увидит отчёт в TRENA."; parse_mode = 'HTML' } | Out-Null
        } catch {}
      } else {
        try { Invoke-Tg 'answerCallbackQuery' @{ callback_query_id = $cq.id; text = 'OK' } | Out-Null } catch {}
      }
    }
  }
  return $state
}

function Send-Json($response, $obj, $code = 200) {
  $json = $obj | ConvertTo-Json -Depth 12 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $response.StatusCode = $code
  $response.ContentType = 'application/json; charset=utf-8'
  try {
    $response.Headers.Add('Access-Control-Allow-Origin', '*')
    $response.Headers.Add('Access-Control-Allow-Headers', 'Content-Type')
    $response.Headers.Add('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  } catch {}
  $response.ContentLength64 = $bytes.Length
  $response.OutputStream.Write($bytes, 0, $bytes.Length)
  $response.Close()
}

function Read-Body($request) {
  $reader = New-Object IO.StreamReader($request.InputStream, [Text.Encoding]::UTF8)
  try { return $reader.ReadToEnd() } finally { $reader.Close() }
}

function Get-ContentType($path) {
  switch ([IO.Path]::GetExtension($path).ToLower()) {
    '.html' { 'text/html; charset=utf-8' }
    '.css'  { 'text/css; charset=utf-8' }
    '.js'   { 'text/javascript; charset=utf-8' }
    '.jpg'  { 'image/jpeg' }
    '.jpeg' { 'image/jpeg' }
    '.png'  { 'image/png' }
    '.svg'  { 'image/svg+xml' }
    '.json' { 'application/json; charset=utf-8' }
    '.ico'  { 'image/x-icon' }
    default { 'application/octet-stream' }
  }
}

if (-not $DemoMode) {
  try {
    $me = Invoke-Tg 'getMe'
    if (-not $me.ok) { throw 'getMe failed' }
    $BotUsername = [string]$me.result.username
    Write-Host "Telegram: @$BotUsername OK" -ForegroundColor Green
  } catch {
    Write-Host "Token failed — demo mode without Telegram." -ForegroundColor Yellow
    $DemoMode = $true
    $BotUsername = $null
  }
} else {
  Write-Host "Demo mode (no Telegram token)." -ForegroundColor Yellow
}

$State = Read-State
Save-State $State

$Listener = $null
$started = $false
foreach ($tryPort in @($PreferredPort, 8766, 8767, 8768, 8770, 8780)) {
  try {
    $Listener = [System.Net.HttpListener]::new()
    $Listener.Prefixes.Add("http://127.0.0.1:$tryPort/")
    $Listener.Start()
    $script:Port = $tryPort
    $started = $true
    break
  } catch {
    try { if ($Listener) { $Listener.Close() } } catch {}
    $Listener = $null
  }
}

if (-not $started) {
  Write-Host ""
  Write-Host "ERROR: cannot bind any port (8765-8780)." -ForegroundColor Red
  Write-Host "Close other TRENA windows or restart the PC." -ForegroundColor Red
  # Fallback: open file directly
  $index = Join-Path $Root 'index.html'
  Write-Host "Opening index.html without server (Telegram API unavailable)..."
  Start-Process $index
  exit 1
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  TRENA  http://127.0.0.1:$Port/" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Do not close this window during the demo."
Write-Host "Ctrl+C to stop."
Write-Host ""

Open-Browser $Port

while ($Listener.IsListening) {
  $ctx = $Listener.GetContext()
  $req = $ctx.Request
  $res = $ctx.Response
  $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath)

  try {
    if ($req.HttpMethod -eq 'OPTIONS') {
      $res.StatusCode = 204
      try {
        $res.Headers.Add('Access-Control-Allow-Origin', '*')
        $res.Headers.Add('Access-Control-Allow-Headers', 'Content-Type')
        $res.Headers.Add('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
      } catch {}
      $res.Close()
      continue
    }

    if ($path -eq '/api/status') {
      if (-not $DemoMode) { $State = Process-Updates (Read-State); Save-State $State }
      Send-Json $res @{
        ok = $true; demo = [bool]$DemoMode; bot = $BotUsername
        chats = @($State.chats).Count; inbox = @($State.inbox).Count
        reports = @(@($State.reports) | Where-Object { -not $_.consumed }).Count
        port = $script:Port
      }
      continue
    }

    if ($path -eq '/api/chats') {
      if (-not $DemoMode) { $State = Process-Updates (Read-State); Save-State $State } else { $State = Read-State }
      Send-Json $res @{ ok = $true; demo = [bool]$DemoMode; chats = @($State.chats) }
      continue
    }

    if ($path -eq '/api/poll') {
      if (-not $DemoMode) { $State = Process-Updates (Read-State) } else { $State = Read-State }
      $chatId = $req.QueryString['chatId']
      $since = 0L
      [void][long]::TryParse($req.QueryString['since'], [ref]$since)
      $inbox = @($State.inbox) | Where-Object {
        (-not $chatId -or [string]$_.chatId -eq [string]$chatId) -and ([long]$_.ts -gt $since)
      }
      $reports = @($State.reports) | Where-Object {
        -not $_.consumed -and (-not $chatId -or [string]$_.chatId -eq [string]$chatId)
      }
      foreach ($r in $reports) { $r.consumed = $true }
      Save-State $State
      Send-Json $res @{
        ok = $true; demo = [bool]$DemoMode; bot = $BotUsername
        inbox = @($inbox); reports = @($reports); chats = @($State.chats)
        now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      }
      continue
    }

    if ($path -eq '/api/send' -and $req.HttpMethod -eq 'POST') {
      if ($DemoMode) {
        Send-Json $res @{ ok = $false; demo = $true; error = 'Demo mode: set bot token in server/config.json' } 503
        continue
      }
      $raw = Read-Body $req
      $body = $raw | ConvertFrom-Json
      if (-not $body.chatId -or -not $body.text) {
        Send-Json $res @{ ok = $false; error = 'chatId and text required' } 400
        continue
      }
      $payload = @{
        chat_id = $body.chatId
        text = [string]$body.text
        parse_mode = if ($body.parseMode) { $body.parseMode } else { 'HTML' }
      }
      if ($body.replyMarkup) { $payload.reply_markup = $body.replyMarkup }
      try {
        $tg = Invoke-Tg 'sendMessage' $payload
        if (-not $tg.ok) { Send-Json $res @{ ok = $false; error = 'Telegram rejected message' } 502; continue }
        Send-Json $res @{ ok = $true; messageId = $tg.result.message_id }
      } catch {
        Send-Json $res @{ ok = $false; error = $_.Exception.Message } 502
      }
      continue
    }

    $rel = if ($path -eq '/') { 'index.html' } else { $path.TrimStart('/') }
    $rel = $rel -replace '/', '\'
    if ($rel.Contains('..')) { Send-Json $res @{ ok = $false; error = 'forbidden' } 403; continue }
    $file = Join-Path $Root $rel
    if (-not (Test-Path $file) -or (Get-Item $file).PSIsContainer) {
      $res.StatusCode = 404
      $bytes = [Text.Encoding]::UTF8.GetBytes('404 Not Found')
      $res.ContentType = 'text/plain; charset=utf-8'
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
      $res.Close()
      continue
    }
    $bytes = [IO.File]::ReadAllBytes($file)
    $res.StatusCode = 200
    $res.ContentType = Get-ContentType $file
    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
    $res.Close()
  } catch {
    try { Send-Json $res @{ ok = $false; error = $_.Exception.Message } 500 }
    catch { try { $res.Close() } catch {} }
  }
}
