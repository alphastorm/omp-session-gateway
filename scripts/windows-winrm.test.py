"""Portable standard-library tests; no pywinrm, credentials, or network required."""
import base64
import contextlib
import io
import json
from pathlib import Path
import runpy
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


class Transport:
    frames = []
    arguments = []
    options = {}
    response = (b'{"ready":true}', b'', 0)
    closed = False

    def __init__(self, **options):
        type(self).options = options

    def open_shell(self):
        return 'synthetic-shell'

    def run_command(self, *arguments, **options):
        type(self).arguments = arguments
        return 'synthetic-command'

    def send_command_input(self, _shell, _command, data, end=False):
        type(self).frames.append((data, end))

    def get_command_output(self, *_args):
        return type(self).response

    def cleanup_command(self, *_args):
        pass

    def close_shell(self, *_args):
        type(self).closed = True


class WinrmFramingTests(unittest.TestCase):
    def setUp(self):
        Transport.frames = []
        Transport.arguments = []
        Transport.response = (b'{"ready":true}', b'', 0)
        Transport.closed = False
        module = types.ModuleType('winrm.protocol')
        module.Protocol = Transport
        with patch.dict(sys.modules, {'winrm.protocol': module}):
            self.adapter = runpy.run_path(str(Path(__file__).with_name('windows-winrm.py')))

    def run_request(self, **payload):
        request = {'host': '192.0.2.10', 'password': 'synthetic-transport-only', **payload}
        output = io.StringIO()
        with patch.object(sys, 'stdin', io.TextIOWrapper(io.BytesIO(json.dumps(request).encode()))), contextlib.redirect_stdout(output):
            self.adapter['main']()
        return json.loads(output.getvalue())

    def test_script_and_credential_never_enter_remote_arguments(self):
        script = 'param($p) "synthetic command"'
        result = self.run_request(script=script, input={'fixture': 'z' * 40000})
        self.assertEqual(result['exitCode'], 0)
        self.assertEqual(Transport.options['transport'], 'ntlm')
        self.assertEqual(Transport.options['message_encryption'], 'always')
        self.assertNotIn('synthetic-transport-only', repr(Transport.arguments))
        self.assertNotIn(script, repr(Transport.arguments))
        self.assertFalse(Transport.frames[0][1])
        self.assertTrue(Transport.frames[-1][1])
        frame = json.loads(b''.join(part for part, _end in Transport.frames))
        self.assertEqual(frame['script'], script)
        self.assertEqual(frame['input'], {'fixture': 'z' * 40000})
        self.assertTrue(Transport.closed)

    def test_binary_upload_is_bounded_and_has_exact_eof(self):
        content = bytes(range(256)) * 1025
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source.tar'
            source.write_bytes(content)
            self.run_request(upload={'sourcePath': str(source), 'destinationPath': 'C:\\omp-winqual-11111111-1111-4111-8111-111111111111\\source.tar'})
        header = json.loads(Transport.frames[0][0])
        self.assertEqual(header['kind'], 'upload')
        self.assertEqual(Transport.frames[-1], (b'', True))
        chunks = Transport.frames[1:-1]
        self.assertEqual([len(base64.b64decode(chunk)) for chunk, _end in chunks], [65536, 65536, 65536, 65536, 256])
        self.assertTrue(all(not end and len(chunk) <= 90000 and chunk.endswith(b'\n') for chunk, end in chunks))
        self.assertEqual(b''.join(base64.b64decode(chunk) for chunk, _end in chunks), content)
        self.assertNotIn(str(source), repr(Transport.arguments))

    def test_empty_upload_closes_without_inventing_file_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source.tar'
            source.write_bytes(b'')
            self.run_request(upload={'sourcePath': str(source), 'destinationPath': 'C:\\omp-winqual-11111111-1111-4111-8111-111111111111\\source.tar'})
        self.assertEqual(len(Transport.frames), 2)
        self.assertEqual(Transport.frames[-1], (b'', True))

    def test_oversized_reply_is_rejected_and_shell_closed(self):
        Transport.response = (b'x' * (1024 * 1024 + 1), b'', 0)
        with self.assertRaisesRegex(ValueError, 'response exceeds bound'):
            self.run_request(script='synthetic')
        self.assertTrue(Transport.closed)

    def test_failed_guest_does_not_echo_stdout_or_arbitrary_stderr(self):
        Transport.response = (b'synthetic-private-output', b'synthetic-private-error guest execution failed at line 42: RuntimeException', 1)
        result = self.run_request(script='synthetic')
        self.assertEqual(result, {'exitCode': 1, 'stdout': '', 'diagnostic': 'guest execution failed at line 42: RuntimeException'})


if __name__ == '__main__':
    unittest.main()
