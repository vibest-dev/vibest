#!/usr/bin/env python3
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest


SCRIPT = Path(__file__).with_name("patch-mygo.sh")


def snapshot(root):
    return {str(p.relative_to(root)): ("link", os.readlink(p)) if p.is_symlink()
            else ("file", p.read_bytes())
            for p in root.rglob("*") if p.is_symlink() or p.is_file()}


class PreparationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="test-patch-mygo-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "project"
        (self.root / "scripts").mkdir(parents=True)
        (self.root / "patches/mygo").mkdir(parents=True)
        shutil.copyfile(SCRIPT, self.root / "scripts/patch-mygo.sh")
        (self.root / "go.mod").write_text(
            "module test\nrequire (\n example.com/mygo v0.0.1\n)\n"
            "replace example.com/mygo => ./third_party/mygo\n")
        (self.root / "patches/mygo/BASE").write_text(
            "MODULE=example.com/mygo\nVERSION=v0.0.1\nSUM=h1:test\n")
        self.patch = self.root / "patches/mygo/0001.patch"
        self.patch.write_text("diff --git a/source.go b/source.go\n"
                              "--- a/source.go\n+++ b/source.go\n@@ -1 +1,2 @@\n"
                              " package mygo\n+// patched\n")
        upstream = self.base / "upstream"
        upstream.mkdir()
        (upstream / "go.mod").write_text("module example.com/mygo\n")
        (upstream / "source.go").write_text("package mygo\n")
        (self.root / "source.go").write_text("package mygo\n")
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.bin = self.base / "bin"
        self.bin.mkdir()
        go = self.bin / "go"
        go.write_text("#!/usr/bin/env python3\n"
                      "import os, pathlib, sys, time\n"
                      "assert sys.argv[1:] == ['mod', 'download', '-json', 'example.com/mygo@v0.0.1']\n"
                      "time.sleep(float(os.environ.get('FAKE_GO_DELAY', '0')))\n"
                      "for p in (pathlib.Path.cwd(), *pathlib.Path.cwd().parents):\n"
                      "    if (p / 'go.mod').exists():\n"
                      "        assert 'replace ' not in (p / 'go.mod').read_text()\n"
                      "        break\n"
                      f"print({json.dumps({'Dir': str(upstream), 'Sum': 'h1:test', 'GoModSum': 'h1:mod'}, indent=2)!r})\n")
        go.chmod(0o755)
        tmp = self.base / "tmp"
        tmp.mkdir()
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ["PATH"],
                        TMPDIR=str(tmp))
        self.output = self.root / "third_party/mygo"

    def prepare(self, ok=True):
        result = subprocess.run(["sh", "scripts/patch-mygo.sh"], cwd=self.root,
                                env=self.env, text=True, capture_output=True, timeout=20)
        if ok:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.root / "source.go").read_text(), "package mygo\n")
        return result.stdout + result.stderr

    def change_inputs(self):
        self.patch.write_text(self.patch.read_text() + "\n")

    def fail_moves(self, restore=False):
        mv = self.bin / "mv"
        mv.write_text("#!/bin/sh\ncase \"$1\" in\n"
                      "*/src) echo 'test: installation failed' >&2; exit 73;;\n"
                      + ("*/old) echo 'test: restoration failed' >&2; exit 74;;\n" if restore else "")
                      + "esac\nexec /bin/mv \"$@\"\n")
        mv.chmod(0o755)

    def test_runs_started_together_all_succeed(self):
        env = dict(self.env, FAKE_GO_DELAY="0.5")
        runs = [subprocess.Popen(["sh", "scripts/patch-mygo.sh"], cwd=self.root, env=env, text=True,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT) for _ in range(3)]
        outputs = [r.communicate(timeout=20)[0] for r in runs]
        for r, out in zip(runs, outputs):
            self.assertEqual(r.returncode, 0, out)
        self.assertEqual(sum("made third_party/mygo" in out for out in outputs), 1, outputs)
        self.assertIn("// patched", (self.output / "source.go").read_text())
        self.assertFalse((self.root / "third_party/.mygo.lock").exists())

    def test_empty_lock_counts_as_stale_after_30_seconds(self):
        lock = self.root / "third_party/.mygo.lock"
        lock.mkdir(parents=True)
        old = time.time() - 31
        os.utime(lock, (old, old))
        self.assertIn("made third_party/mygo", self.prepare())
        self.assertFalse(lock.exists())

    def test_fresh_empty_lock_is_waited_for(self):
        lock = self.root / "third_party/.mygo.lock"
        lock.mkdir(parents=True)
        run = subprocess.Popen(["sh", "scripts/patch-mygo.sh"], cwd=self.root, env=self.env, text=True,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        time.sleep(1)
        self.assertIsNone(run.poll())
        self.assertFalse(self.output.exists())
        lock.rmdir()
        out = run.communicate(timeout=20)[0]
        self.assertEqual(run.returncode, 0, out)
        self.assertIn("made third_party/mygo", out)

    def test_lock_of_a_dead_process_is_taken_over(self):
        dead = subprocess.Popen(["true"])
        dead.wait()
        lock = self.root / "third_party/.mygo.lock"
        lock.mkdir(parents=True)
        (lock / f"pid.{dead.pid}").touch()
        self.assertIn("made third_party/mygo", self.prepare())
        self.assertFalse(lock.exists())

    def test_first_idempotent_and_changed_inputs(self):
        self.assertIn("made third_party/mygo", self.prepare())
        self.assertEqual((self.output / "source.go").read_text(), "package mygo\n// patched\n")
        before = snapshot(self.output)
        stamp = self.output / ".reherdr-patched"
        mtime = stamp.stat().st_mtime_ns
        self.assertIn("up to date", self.prepare())
        self.assertEqual(snapshot(self.output), before)
        self.assertEqual(stamp.stat().st_mtime_ns, mtime)
        self.change_inputs()
        self.assertIn("made third_party/mygo", self.prepare())
        after = snapshot(self.output)
        self.assertNotEqual(after.pop(".reherdr-patched"), before.pop(".reherdr-patched"))
        self.assertEqual(after, before)
        self.assertIn("up to date", self.prepare())

    def test_failed_install_restores_tree_and_stamp(self):
        self.prepare()
        before = snapshot(self.output)
        self.change_inputs()
        self.fail_moves()
        self.assertIn("test: installation failed", self.prepare(ok=False))
        self.assertEqual(snapshot(self.output), before)
        self.assertEqual(list(self.output.parent.iterdir()), [self.output])

    def test_failed_restore_preserves_backup_and_recovery_path(self):
        self.prepare()
        before = snapshot(self.output)
        self.change_inputs()
        self.fail_moves(restore=True)
        message = self.prepare(ok=False)
        backups = list(self.output.parent.glob(".mygo.*/old"))
        self.assertEqual(len(backups), 1, message)
        self.assertEqual(snapshot(backups[0]), before)
        self.assertIn(str(backups[0]), message)
        self.assertIn("restore", message)

    def test_added_symlink_rejected_before_and_after_input_change(self):
        self.prepare()
        target = self.base / "local.go"
        target.write_text("package mygo\n// local edit\n")
        link = self.output / "local.go"
        link.symlink_to(target)
        before = snapshot(self.output)
        for changed in (False, True):
            with self.subTest(changed=changed):
                if changed:
                    self.change_inputs()
                self.assertIn("symlink", self.prepare(ok=False))
                self.assertEqual(snapshot(self.output), before)
                self.assertEqual(target.read_text(), "package mygo\n// local edit\n")
                self.assertTrue(link.is_symlink())

    def test_dirty_tree_rejected_before_and_after_input_change(self):
        self.prepare()
        (self.output / "source.go").write_text("package mygo\n// local edit\n")
        before = snapshot(self.output)
        for changed in (False, True):
            with self.subTest(changed=changed):
                if changed:
                    self.change_inputs()
                self.assertIn("edits of its own", self.prepare(ok=False))
                self.assertEqual(snapshot(self.output), before)

    def test_wrong_download_checksum_rejected(self):
        go = self.bin / "go"
        go.write_text(go.read_text().replace("h1:test", "h1:wrong"))
        self.assertIn("has checksum h1:wrong", self.prepare(ok=False))
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.output.parent.iterdir()), [])

    def test_failed_patch_preserves_previous_tree(self):
        self.prepare()
        before = snapshot(self.output)
        self.patch.write_text("not a patch\n")
        self.assertIn("does not apply", self.prepare(ok=False))
        self.assertEqual(snapshot(self.output), before)
        self.assertEqual(list(self.output.parent.iterdir()), [self.output])

    def test_unmanaged_tree_rejected(self):
        self.output.mkdir(parents=True)
        (self.output / "local.go").write_text("package mygo\n")
        before = snapshot(self.output)
        self.assertIn("was not made by this script", self.prepare(ok=False))
        self.assertEqual(snapshot(self.output), before)

    def test_root_symlink_rejected_including_dangling(self):
        self.prepare()
        target = self.base / "external-tree"
        self.output.rename(target)
        before = snapshot(target)
        for destination in (target, self.base / "missing"):
            with self.subTest(destination=destination):
                self.output.symlink_to(destination, target_is_directory=True)
                try:
                    self.assertIn("symlink", self.prepare(ok=False))
                    self.assertTrue(self.output.is_symlink())
                    self.assertEqual(os.readlink(self.output), str(destination))
                    self.assertEqual(snapshot(target), before)
                finally:
                    self.output.unlink()


if __name__ == "__main__":
    unittest.main(verbosity=2)
