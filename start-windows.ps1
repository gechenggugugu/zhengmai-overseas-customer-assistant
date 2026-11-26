$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add('http://127.0.0.1:4173/')
try {
  $listener.Start()
} catch {
  Write-Host '本地网页服务未能启动。请关闭已占用 4173 端口的程序后重试。'
  throw
}
$url = 'http://127.0.0.1:4173/'
Write-Host "正麦海外客户开发助手已启动：$url"
Write-Host '关闭此窗口即可停止服务。'
if ($env:ZHENGMAI_NO_BROWSER -ne '1') { Start-Process $url }
$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
}
try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    try {
      if ($context.Request.HttpMethod -notin @('GET', 'HEAD')) {
        $context.Response.StatusCode = 405
      } else {
        $relative = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath.TrimStart('/'))
        if ([string]::IsNullOrWhiteSpace($relative)) { $relative = 'index.html' }
        $candidate = [System.IO.Path]::GetFullPath((Join-Path $root $relative))
        if (-not $candidate.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
          $context.Response.StatusCode = 400
        } elseif (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
          $context.Response.StatusCode = 404
        } else {
          $extension = [System.IO.Path]::GetExtension($candidate).ToLowerInvariant()
          if ($types.ContainsKey($extension)) { $context.Response.ContentType = $types[$extension] }
          $context.Response.Headers['X-Content-Type-Options'] = 'nosniff'
          if ($context.Request.HttpMethod -eq 'GET') {
            $bytes = [System.IO.File]::ReadAllBytes($candidate)
            $context.Response.ContentLength64 = $bytes.Length
            $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
          }
        }
      }
    } finally {
      $context.Response.Close()
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
