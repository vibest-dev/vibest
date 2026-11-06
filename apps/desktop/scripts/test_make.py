#!/usr/bin/env python3
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


class MakeTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="test-vibest-desktop-make-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        shutil.copyfile(Path(__file__).resolve().parents[1] / "Makefile", self.root / "Makefile")
        (self.root / "scripts").mkdir()
        (self.root / "bin").mkdir()
        (self.root / "scripts/patch-mygo.sh").write_text('''echo setup-start >> "$EVENTS"
sleep 0.1
[ "$FAIL_SETUP" = 0 ] || exit 17
echo setup-done >> "$EVENTS"
''')
        mock = self.root / "bin/go"
        mock.write_text(f"#!{sys.executable}" + chr(10) + '''import json, os, pathlib, sys
log = pathlib.Path(os.environ['EVENTS'])
lines = log.read_text().splitlines()
assert lines.count('setup-start') == lines.count('setup-done') == 1, lines
with log.open('a') as f: f.write(json.dumps([pathlib.Path(sys.argv[0]).name, *sys.argv[1:]]) + chr(10))
if sys.argv[1:2] == ['build']:
    app = pathlib.Path('build/vibest-desktop')
    app.write_text('#!/bin/sh' + chr(10) + 'exec go app '+chr(34)+'$@'+chr(34)+chr(10))
    app.chmod(0o755)
if sys.argv[1:] == ['test', './...'] and os.environ.get('FAIL_TEST'): sys.exit(19)
''')
        mock.chmod(0o755)
        shutil.copyfile(mock, self.root / "bin/python3")
        (self.root / "bin/python3").chmod(0o755)
        shasum = self.root / "bin/shasum"
        shasum.write_text("#!/bin/sh" + chr(10) + "echo 6f385d3221f8c776ba40530db9baf8c71478907897959849896eeb0ddbf16b41 -" + chr(10))
        shasum.chmod(0o755)
        (self.root / "vt.dylib").write_text("")
        self.events = self.root / "events"
        self.env = dict(os.environ, PATH=str(self.root / "bin") + os.pathsep + os.environ["PATH"],
                        EVENTS=str(self.events), MYGO_GHOSTTY_VT=str(self.root / "vt.dylib"), FAIL_SETUP="0", MAKEFLAGS="", MFLAGS="", MAKELEVEL="0")

    def make(self, *targets, ok=True, **env):
        result = subprocess.run(["make", "-j8", *targets], cwd=self.root,
                                env=dict(self.env, **env), capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode == 0, ok, result.stdout + result.stderr)
        return self.events.read_text().splitlines() if self.events.exists() else []

    def test_parallel_consumers_wait_for_one_preparation(self):
        lines = self.make("setup", "build", "test", "vet", "package", "run", "ARGS=-core-session work -autostart=false")
        self.assertEqual(lines[:2], ["setup-start", "setup-done"])
        commands = [json.loads(line) for line in lines[2:]]
        self.assertCountEqual(commands, [
            ["go", "build", "-o", "build/vibest-desktop", "./cmd/vibest-desktop"],
            ["python3", "scripts/test_patch_mygo.py"],
            ["python3", "scripts/test_make.py"],
            ["go", "test", "./..."],
            ["go", "vet", "./..."],
            ["go", "run", "./scripts/hcgen", "-check"],
            ["go", "run", "github.com/egoist/mygo/cmd/mygo", "build", "-sign", "-", "-skip-notarize", "-skip-dmg", "-o", "out", "."],
            ["go", "app", "-core-session", "work", "-autostart=false"],
        ])
        self.events.unlink()
        self.assertEqual(self.make("build")[:2], ["setup-start", "setup-done"])

    def test_preparation_failure_blocks_all_consumers(self):
        self.assertEqual(self.make("build", "test", "vet", "package", "run",
                                   ok=False, FAIL_SETUP="1"), ["setup-start"])

    def test_test_failure_fails_make(self):
        lines = self.make("test", ok=False, FAIL_TEST="1")
        self.assertIn('["go", "test", "./..."]', lines)

    def test_test_refuses_an_unverified_vt_library(self):
        lines = self.make("test", ok=False, MYGO_GHOSTTY_VT=str(self.root / "missing.dylib"))
        self.assertNotIn('["go", "test", "./..."]', lines)


if __name__ == "__main__":
    unittest.main(verbosity=2)
