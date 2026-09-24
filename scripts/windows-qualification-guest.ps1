param($p)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = 'C:\omp-winqual-' + $p.epoch
$bun = "$root\bun\bun-windows-x64\bun.exe"
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
$base = "$env:LOCALAPPDATA\OMP Session Gateway"
$cli = "$root\candidate\apps\gateway\src\cli.js"
$env:PATH = "$root\bun\bun-windows-x64;C:\Program Files\Tailscale;" + $env:PATH
if ($p.ompPath) { $env:PATH = [IO.Path]::GetDirectoryName($p.ompPath) + ';' + $env:PATH }
function Digest($path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() }
function PrivateDirectory($path) {
  New-Item -ItemType Directory -Force -Path $path | Out-Null
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @([System.Security.Principal.WindowsIdentity]::GetCurrent().User, (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')))) {
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  }
  Set-Acl -LiteralPath $path -AclObject $acl
}
function Run($exe, $arguments) {
  # Windows PowerShell 5 treats native stderr as ErrorRecord, even for exit 0.
  # Judge the native exit code, not its choice of output stream.
  $previousPreference = $ErrorActionPreference
  try { $ErrorActionPreference = 'Continue'; $global:LASTEXITCODE = $null; $output = & $exe @arguments 2>&1 }
  finally { $ErrorActionPreference = $previousPreference }
  if ($global:LASTEXITCODE -ne 0) { throw ('native command failed: ' + [IO.Path]::GetFileName($exe) + ' exit ' + $global:LASTEXITCODE) }
  $output
}
function Status {
  $text = & $bun $cli status 2>$null
  if (-not $text) { return @{ ready = $false } }
  $text | ConvertFrom-Json
}
function DoctorReport {
  $previousPreference = $ErrorActionPreference
  try { $ErrorActionPreference = 'Continue'; $text = & $bun $cli doctor 2>$null; $code = $global:LASTEXITCODE }
  finally { $ErrorActionPreference = $previousPreference }
  if ($code -notin @(0, 1)) { throw 'doctor execution failed' }
  ($text | Out-String) | ConvertFrom-Json
}
function State {
  $task = Get-ScheduledTask -TaskName 'OMP Session Gateway' -ErrorAction SilentlyContinue
  $logonTrigger = $false; $interactivePrincipal = $false
  if ($task) {
    $definition = [xml](Export-ScheduledTask -TaskName 'OMP Session Gateway')
    $triggers = @($definition.Task.Triggers.ChildNodes | Where-Object { $_ -is [Xml.XmlElement] })
    $principals = @($definition.Task.Principals.Principal)
    $logonTrigger = $triggers.Count -eq 1 -and $triggers[0].LocalName -eq 'LogonTrigger' -and $task.Triggers[0].Enabled -eq $true
    $interactivePrincipal = $principals.Count -eq 1 -and $principals[0].LogonType -eq 'InteractiveToken' -and $task.Principal.RunLevel -eq 'Limited'
  }
  $procs = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('OMP Session Gateway\state\') -and $_.CommandLine -match 'cli\.js.+serve' })
  $listeners = @(Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue)
  @{ taskPresent = $null -ne $task; taskRunning = $task.State -eq 'Running'; gatewayProcesses = $procs.Count; listeners = $listeners.Count;
    loopbackOnly = $listeners.Count -eq 1 -and $listeners[0].LocalAddress -eq '127.0.0.1'; logonTrigger = $logonTrigger; interactivePrincipal = $interactivePrincipal }
}
function Preserved {
  @{ configPreserved = (Digest "$base\config.json") -eq $p.configDigest;
    readinessPreserved = (Digest "$base\readiness-token") -eq $p.credentialDigest }
}
function Installed($version) {
  $s = Status
  if (-not $s.ready -or -not $s.installed -or -not $s.active -or $s.diverged -or $s.authMode -ne 'tailscale-serve' -or $s.activeVersion -ne $s.serviceVersion -or -not $s.activeVersion.StartsWith($version + '-')) { throw 'installed identity/readiness mismatch' }
  $config = Get-Content -Raw "$base\config.json" | ConvertFrom-Json
  if ($config.auth.mode -ne 'tailscale-serve' -or @($config.auth.allowedLogins).Count -ne 1 -or $config.auth.allowedLogins[0] -ne $p.login) { throw 'gateway exact-login allowlist mismatch' }
  $state = State
  if (-not $state.loopbackOnly) { throw 'gateway listener is not loopback-only' }
  $r = Preserved; $r.ready = $true; $r.loopbackOnly = $true; $r
}
switch ($p.action) {
  'transport' {
    $os = Get-CimInstance Win32_OperatingSystem
    $hostInfo = Get-CimInstance Win32_ComputerSystem
    if ($os.Caption -notmatch 'Windows Server 2025 Standard' -or $hostInfo.NumberOfLogicalProcessors -ne 2) { throw 'provider guest shape mismatch' }
    @{ windowsBuild = [int]$os.BuildNumber; cpus = [int]$hostInfo.NumberOfLogicalProcessors; memoryMiB = [int][Math]::Round($hostInfo.TotalPhysicalMemory / 1MB) } | ConvertTo-Json -Compress
  }
  'fingerprint' {
    $binding = Get-CimInstance -Namespace root\cimv2\terminalservices -ClassName Win32_TSGeneralSetting -Filter "TerminalName='RDP-tcp'"
    $cert = Get-ChildItem 'Cert:\LocalMachine\Remote Desktop' | Where-Object { $_.Thumbprint -eq $binding.SSLCertificateSHA1Hash }
    if (@($cert).Count -ne 1) { throw 'active RDP certificate missing' }
    @{ fingerprint = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($cert.RawData))).Replace('-', '').ToLowerInvariant() } | ConvertTo-Json -Compress
  }
  'interactive' { @{ interactive = @(Get-Process explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -gt 0 }).Count -gt 0 } | ConvertTo-Json -Compress }
  'stage' {
    PrivateDirectory $root
    foreach ($folder in @('bun', 'candidate', 'predecessor', 'source', 'native', 'omp-winqual-fixture')) { PrivateDirectory "$root\$folder" }
    $downloads = @(
      @{ url = "https://github.com/oven-sh/bun/releases/download/bun-v$($p.pins.bunVersion)/bun-windows-x64.zip"; file = 'bun.zip'; digest = $p.pins.bunSha256 },
      @{ url = "https://pkgs.tailscale.com/stable/tailscale-setup-$($p.pins.tailscaleVersion)-amd64.msi"; file = 'tailscale.msi'; digest = $p.pins.tailscaleSha256 },
      @{ url = "https://registry.npmjs.org/@oh-my-pi/pi-natives-win32-x64/-/pi-natives-win32-x64-$($p.pins.omp.version).tgz"; file = 'native.tgz'; digest = $p.pins.omp.nativeTarballSha256 }
    )
    foreach ($d in $downloads) {
      if (-not (Test-Path "$root\$($d.file)") -or (Digest "$root\$($d.file)") -ne $d.digest) { Invoke-WebRequest -UseBasicParsing -Uri $d.url -OutFile "$root\$($d.file)" }
      if ((Digest "$root\$($d.file)") -ne $d.digest) { throw 'toolchain archive digest mismatch' }
    }
    Expand-Archive -LiteralPath "$root\bun.zip" -DestinationPath "$root\bun" -Force
    if ((Run $bun @('--version')).Trim() -ne $p.pins.bunVersion) { throw 'Bun version mismatch' }
    $signature = Get-AuthenticodeSignature "$root\tailscale.msi"
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch ('CN=' + [regex]::Escape($p.pins.tailscalePublisher) + '(,|$)')) { throw 'Tailscale Authenticode mismatch' }
    if (-not (Test-Path $ts)) {
      $installer = Start-Process msiexec.exe -ArgumentList @('/i', "$root\tailscale.msi", '/qn', '/norestart') -Wait -PassThru
      if ($installer.ExitCode -ne 0) { throw 'Tailscale install failed' }
    }
    $installedVersion = (Run $ts @('version') | Out-String).Trim().Split([char]10)[0].Trim()
    if ($installedVersion -ne $p.pins.tailscaleVersion) { throw 'installed Tailscale version mismatch' }
    Run tar.exe @('-xzf', "$root\native.tgz", '-C', "$root\native") | Out-Null
    if ((Digest "$root\native\package\$($p.pins.omp.nativeFile)") -ne $p.pins.omp.nativeBinarySha256) { throw 'OMP native digest mismatch' }
    @{ staged = $true } | ConvertTo-Json -Compress
  }
  'unpack' {
    foreach ($role in @('candidate', 'predecessor', 'source')) {
      if ((Digest "$root\$role.tar") -ne $p.$role) { throw 'uploaded archive digest mismatch' }
      Run tar.exe @('-xf', "$root\$role.tar", '-C', "$root\$role", '--strip-components', '1') | Out-Null
    }
    @{ unpacked = $true } | ConvertTo-Json -Compress
  }
  'join' {
    $keyPath = "$root\join.key"
    $status = (& $ts status --json 2>$null | Out-String) | ConvertFrom-Json
    if ($status.BackendState -ne 'Running') {
      try {
        [IO.File]::WriteAllText($keyPath, $p.joinValue, (New-Object Text.UTF8Encoding($false)))
        Run $ts @('up', "--auth-key=file:$keyPath", "--hostname=omp-winqual-$($p.epoch)", '--accept-dns=true', '--ssh=false', '--unattended=true', '--timeout=120s') | Out-Null
      } finally { Remove-Item -LiteralPath $keyPath -Force -ErrorAction SilentlyContinue }
    }
    $status = (Run $ts @('status', '--json') | Out-String) | ConvertFrom-Json
    if ($status.BackendState -ne 'Running' -or $status.Self.Tags -notcontains 'tag:omp-session-gateway') { throw 'tagged Tailscale join failed' }

    $tun = @(Get-NetAdapter | Where-Object { $_.InterfaceDescription -match 'Tailscale' -and $_.Status -eq 'Up' }).Count -gt 0
    if (-not $tun) { throw 'TUN adapter is not up' }
    Run $ts @('serve', '--bg', '--https=443', 'http://127.0.0.1:4317') | Out-Null
    $serve = (Run $ts @('serve', 'status', '--json') | Out-String) | ConvertFrom-Json
    $serveHost = $status.Self.DNSName.TrimEnd('.') + ':443'
    if ($serve.Web.$serveHost.Handlers.'/'.Proxy -ne 'http://127.0.0.1:4317' -or -not $serve.TCP.'443'.HTTPS) { throw 'Serve mapping mismatch' }
    if (($serve.AllowFunnel.PSObject.Properties | Where-Object { $_.Value -eq $true }).Count -gt 0) { throw 'Funnel enabled' }
    @{ origin = 'https://' + $status.Self.DNSName.TrimEnd('.'); machine = $status.Self.ID; taggedNode = $true; tunMode = $tun; funnelOff = $true } | ConvertTo-Json -Compress
  }
  'build' {
    Push-Location "$root\source"
    try {
      Run $bun @('install', '--frozen-lockfile') | Out-Null
      Copy-Item "$root\native\package\$($p.pins.omp.nativeFile)" "$root\source\packages\natives\native\$($p.pins.omp.nativeFile)"
      if ((Digest "$root\source\packages\natives\native\$($p.pins.omp.nativeFile)") -ne $p.pins.omp.nativeBinarySha256) { throw 'staged native mismatch' }
      Run $bun @('--cwd=packages/coding-agent', 'run', 'build') | Out-Null
    } finally { Pop-Location }
    $omp = "$root\source\packages\coding-agent\dist\omp.exe"
    if (-not (Test-Path $omp)) { $omp = "$root\source\packages\coding-agent\dist\omp" }
    if ((Run $omp @('--version') | Out-String).Trim() -ne ('omp/' + $p.pins.omp.version)) { throw 'built OMP version mismatch' }
    Run $omp @('config', 'set', 'collab.autoStart', 'control') | Out-Null
    @{ ompPath = $omp; binarySha256 = Digest $omp } | ConvertTo-Json -Compress
  }
  'installPredecessor' {
    Run $bun @("$root\predecessor\apps\gateway\src\cli.js", 'install', '--origin', $p.origin, '--allow', $p.login) | Out-Null
    $s = Status
    @{ ready = $s.ready -and $s.activeVersion.StartsWith($p.previousVersion + '-'); configDigest = Digest "$base\config.json"; credentialDigest = Digest "$base\readiness-token" } | ConvertTo-Json -Compress
  }
  'inspectPredecessor' { Installed $p.previousVersion | ConvertTo-Json -Compress }
  { $_ -in 'upgrade', 'restore' } {
    Run $bun @($cli, 'install', '--origin', $p.origin, '--allow', $p.login) | Out-Null
    $r = Installed $p.candidateVersion; $r.restored = $_ -eq 'restore'; $r | ConvertTo-Json -Compress
  }
  'doctor' {
    $doctor = DoctorReport
    $state = State
    @{ checks = $doctor.checks; loopbackOnly = $state.loopbackOnly; logonTrigger = $state.logonTrigger; interactivePrincipal = $state.interactivePrincipal } | ConvertTo-Json -Compress -Depth 4
  }
  'reboot' { Run shutdown.exe @('/r', '/t', '3', '/f') | Out-Null; '{"requested":true}' }
  'prelogin' { State | ConvertTo-Json -Compress }
  'ready' {
    $state = Status
    if (-not $state.ready) { '{"ready":false}'; break }
    # HMAC readiness can precede the Windows TUN adapter after logon. Reuse the
    # artifact's real doctor rather than inventing a weaker network predicate.
    $doctor = DoctorReport
    @{ ready = $doctor.checks.tailscaleConnected -and $doctor.checks.loopbackTrustSound; tunMode = $doctor.checks.loopbackTrustSound } | ConvertTo-Json -Compress
  }
  'startOmp' {
    # WinRS closes its process job at disconnect. An owned Interactive task places the
    # hidden OMP console in the RDP session instead; this is NOT the gateway task.
    $launcherPath = "$root\omp-start.ps1"
    $pidPath = "$root\omp.pid"
    $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $launcherPath + '"'
    $taskName = 'OMP Winqual ' + $p.epoch
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
      if (@($task.Actions).Count -ne 1 -or $task.Actions.Execute -ne 'powershell.exe' -or $task.Actions.Arguments -ne $arguments) { throw 'owned OMP task changed' }
      if (Test-Path $pidPath) {
        $ownedPid = [int](Get-Content -Raw $pidPath)
        if ($ownedPid -le 0) { throw 'owned OMP PID is invalid' }
        $ownedProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$ownedPid"
        if ($ownedProcess) {
          if ($ownedProcess.ExecutablePath -ne $p.ompPath) { throw 'owned OMP PID was reused' }
          @{ ompPid = $ownedPid } | ConvertTo-Json -Compress
          break
        }
      }
      if ($task.State -ne 'Running') {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
        $task = $null
      }
    }
    # windowsHostScript writes its PID to Console.Out, not the PowerShell pipeline.
    $launcher = @(
      '$priorOut = [Console]::Out; $writer = New-Object IO.StringWriter'
      'try { [Console]::SetOut($writer)'
      ('& { ' + $p.launcher + ' }')
      '$ownedId = 0; if (-not [int]::TryParse($writer.ToString(), [ref]$ownedId) -or $ownedId -le 0) { throw "invalid OMP launcher PID" }'
      ('[IO.File]::WriteAllText(' + "'$pidPath'" + ', [string]$ownedId)')
      '} finally { [Console]::SetOut($priorOut); $writer.Dispose() }'
    ) -join "`n"
    if (-not $task) {
      [IO.File]::WriteAllText($launcherPath, $launcher, (New-Object Text.UTF8Encoding($false)))
      $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
      $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
      Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal | Out-Null
      Start-ScheduledTask -TaskName $taskName
    }
    $deadline = (Get-Date).AddSeconds(60)
    while (-not (Test-Path $pidPath)) { if ((Get-Date) -gt $deadline) { throw 'owned OMP start timed out' }; Start-Sleep -Seconds 1 }
    $ownedPid = [int](Get-Content -Raw $pidPath)
    if ($ownedPid -le 0) { throw 'owned OMP PID is invalid' }
    @{ ompPid = $ownedPid } | ConvertTo-Json -Compress
  }
  'publication' {
    $entries = @(Get-ChildItem "$env:USERPROFILE\.omp\run\collab-hosts\*.json" -ErrorAction SilentlyContinue)
    $owned = @($entries | ForEach-Object { Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json } | Where-Object { $_.pid -eq $p.ompPid })
    @{ namedPipe = $owned.Count -eq 1 -and $owned[0].endpoint.StartsWith('\\.\pipe\') } | ConvertTo-Json -Compress
  }
  'stopOmp' {
    $taskName = 'OMP Winqual ' + $p.epoch
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) {
      $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + "$root\omp-start.ps1" + '"'
      if (@($task.Actions).Count -ne 1 -or $task.Actions.Execute -ne 'powershell.exe' -or $task.Actions.Arguments -ne $arguments) { throw 'owned OMP task changed' }
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
    if (-not $p.ompPid -and (Test-Path "$root\omp.pid")) { $p | Add-Member -Force -NotePropertyName ompPid -NotePropertyValue ([int](Get-Content -Raw "$root\omp.pid")) }
    if ($p.ompPid) {
      if ($p.ompPid -le 0) { throw 'owned OMP PID is invalid' }
      $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ompPid)"
      if ($process) {
        if ($process.ExecutablePath -ne $p.ompPath) { throw 'owned OMP PID was reused' }
        Run taskkill.exe @('/PID', [string]$p.ompPid, '/T', '/F') | Out-Null
      }
    }
    if (Test-Path "$root\omp.pid") {
      if ($p.ompPid -le 0 -or [int](Get-Content -Raw "$root\omp.pid") -ne $p.ompPid) { throw 'owned OMP PID changed during stop' }
      Remove-Item -LiteralPath "$root\omp.pid" -Force
    }
    '{"stopped":true}'
  }
  'rotate' {
    Run $bun @($cli, 'rotate-readiness-token') | Out-Null
    $r = Preserved; $r.readinessChanged = -not $r.readinessPreserved; $r.credentialDigest = Digest "$base\readiness-token"; $r.ready = (Status).ready; $r | ConvertTo-Json -Compress
  }
  'rollback' {
    $history = Get-Content -Raw "$base\state\installation\history.json" | ConvertFrom-Json
    $to = @($history.activations | Where-Object { $_.StartsWith($p.previousVersion + '-') })[-1]
    if (-not $to) { throw 'predecessor missing from activation history' }
    Run $bun @($cli, 'rollback', '--to', $to) | Out-Null
    $r = Installed $p.previousVersion; $r.historySelected = $true; $r | ConvertTo-Json -Compress
  }
  'uninstall' {
    if (Test-Path $cli) { Run $bun @($cli, 'uninstall') | Out-Null }
    $state = State
    $r = @{ uninstalled = -not $state.taskPresent -and $state.gatewayProcesses -eq 0 -and $state.listeners -eq 0 }
    if ($p.configDigest) { $preserved = Preserved; $r.configPreserved = $preserved.configPreserved; $r.readinessPreserved = $preserved.readinessPreserved }
    $r | ConvertTo-Json -Compress
  }
  'resetServe' {
    if (Test-Path $ts) {
      $status = (Run $ts @('status', '--json') | Out-String) | ConvertFrom-Json
      if ($status.BackendState -eq 'Running') { Run $ts @('serve', 'reset') | Out-Null }
    }
    '{"reset":true}'
  }
  'logout' {
    if (Test-Path $ts) {
      $status = (Run $ts @('status', '--json') | Out-String) | ConvertFrom-Json
      if ($status.BackendState -ne 'NeedsLogin') { Run $ts @('logout') | Out-Null }
    }
    '{"loggedOut":true}'
  }
  default { throw 'unknown qualification action' }
}
