#!/usr/bin/env python3
"""One stdin JSON request, one bounded JSON response. Never put payloads in argv."""
import base64
import json
import re
import signal
import sys

from winrm.protocol import Protocol

# The remote command line is constant. The script and its input travel on the encrypted
# WinRS input stream, not -EncodedCommand, environment variables, or temporary scripts.
BOOTSTRAP = r"""
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $frame = [Console]::In.ReadLine() | ConvertFrom-Json
  if ((Get-Item WSMan:\localhost\Service\AllowUnencrypted).Value -ne 'false') { throw 'unencrypted WinRM enabled' }
  if ($frame.kind -eq 'upload') {
    if ($frame.path -notmatch '^C:\\omp-winqual-[0-9a-f-]{36}\\(candidate|predecessor|source)\.tar$') { throw 'upload destination refused' }
    $file = [IO.File]::Open($frame.path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      while ($null -ne ($line = [Console]::In.ReadLine())) {
        if ($line.Length -gt 90000) { throw 'upload frame too large' }
        $bytes = [Convert]::FromBase64String($line)
        $file.Write($bytes, 0, $bytes.Length)
      }
    } finally { $file.Dispose() }
    '{"uploaded":true}'
  } else {
    $inputData = $frame.input
    & ([ScriptBlock]::Create($frame.script)) $inputData
  }
} catch {
  $diagnostic = 'guest execution failed at line ' + $_.InvocationInfo.ScriptLineNumber + ': ' + $_.Exception.GetType().Name
  if ($_.Exception.Message -match '^native command failed: [A-Za-z0-9_.-]+ exit -?[0-9]+$') { $diagnostic += '; ' + $_.Exception.Message }
  [Console]::Error.WriteLine($diagnostic)
  exit 1
}
"""


def main():
    request = json.loads(sys.stdin.buffer.read(1024 * 1024))
    protocol = Protocol(
        endpoint='http://' + request['host'] + ':5985/wsman',
        transport='ntlm', username='Administrator', password=request['password'],
        message_encryption='always', read_timeout_sec=60, operation_timeout_sec=45,
    )
    shell = protocol.open_shell()
    command = None
    try:
        command = protocol.run_command(shell, 'powershell.exe', [
            '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
            base64.b64encode(BOOTSTRAP.encode('utf-16-le')).decode('ascii'),
        ], console_mode_stdin=False)
        upload = request.get('upload')
        header = {'kind': 'upload', 'path': upload['destinationPath']} if upload else {'kind': 'script', 'script': request['script'], 'input': request.get('input')}
        frame = (json.dumps(header) + '\n').encode('utf-8')
        for offset in range(0, len(frame), 32768):
            end = min(offset + 32768, len(frame))
            protocol.send_command_input(shell, command, frame[offset:end], end=not upload and end == len(frame))
        if upload:
            with open(upload['sourcePath'], 'rb') as source:
                while chunk := source.read(65536):
                    protocol.send_command_input(shell, command, base64.b64encode(chunk) + b'\n')
            protocol.send_command_input(shell, command, b'', end=True)
        stdout, stderr, code = protocol.get_command_output(shell, command)
        if len(stdout) > 1024 * 1024 or len(stderr) > 65536:
            raise ValueError('response exceeds bound')
        # No raw stderr: an external program can include its argv or other private data.
        diagnostic = re.search(rb'guest execution failed at line [0-9]+: [A-Za-z0-9]+(?:; native command failed: [A-Za-z0-9_.-]+ exit -?[0-9]+)?', stderr)
        print(json.dumps({'exitCode': code, 'stdout': stdout.decode('utf-8-sig') if code == 0 else '',
                          'diagnostic': diagnostic.group().decode('ascii') if diagnostic else ''}))
    finally:
        if command is not None:
            protocol.cleanup_command(shell, command)
        protocol.close_shell(shell)


if __name__ == '__main__':
    # The controller's timeout sends SIGTERM; run the shell teardown instead of
    # leaving a WinRS job (and a partially written, exclusively locked upload) alive.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    try:
        main()
    except Exception as error:
        code = getattr(error, 'code', None)
        code_text = ' HTTP ' + str(code) if isinstance(code, int) else ''
        fault = getattr(error, 'wsman_fault_code', None)
        fault_text = ' fault ' + str(fault) if isinstance(fault, int) else ''
        print(json.dumps({'exitCode': -1, 'stdout': '', 'diagnostic': type(error).__name__ + code_text + fault_text}))
        sys.exit(1)
