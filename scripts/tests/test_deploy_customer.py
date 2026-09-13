"""Exercise deployment sequencing and failure handling without Docker or a server."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'deploy_customer.sh'
STUB = r'''#!/usr/bin/env python3
import hashlib,json,os,pathlib,sys
name=pathlib.Path(sys.argv[0]).name
args=sys.argv[1:]
with open(os.environ['CALL_LOG'],'a') as f: f.write(name+' '+ ' '.join(args)+'\n')
failure=os.environ.get('FAILURE','')
if name=='git':
 if args[:2]==['branch','--show-current']: print('main')
 elif args[:2]==['status','--porcelain']: print(' M changed' if failure=='dirty' else '',end='')
 elif args[:2]==['rev-parse','--git-path']: print('.git/lock')
 elif args[:1]==['rev-parse']: print('old' if args[1]=='HEAD' else 'new')
 elif args[:1]==['fetch'] and failure=='fetch': sys.exit(1)
elif name=='docker':
 if 'config' in args: print(json.dumps({'name':'wrong' if failure=='project' else 'invenzo-test'}))
 elif 'ps' in args and '-q' in args:
  if not (failure=='missing-db' and args[-1]=='postgres'): print('container-id')
 elif '/backup.sh' in args and failure=='backup': sys.exit(1)
 elif 'sha256sum' in args and failure=='checksum': sys.exit(1)
 elif 'readlink' in args: print('/backups/test.dump')
 elif 'cp' in args:
  source,dest=args[-2:]; filename=source.split('/')[-1]
  content=(hashlib.sha256(b'backup').hexdigest()+'  /backups/test.dump\n').encode() if filename.endswith('.sha256') else b'backup'
  if failure=='copy-corrupt' and filename.endswith('.dump'): content=b'corrupt'
  pathlib.Path(dest,filename).write_bytes(content)
 elif 'build' in args and failure=='build': sys.exit(1)
 elif 'curl' in args: print(json.dumps({'status':'healthy','dependencies':{'database':'up','redis':'up'}}))
 elif 'python' in args and failure=='migration': sys.exit(1)
elif name=='curl':
 if failure=='public-health': sys.exit(1)
 print('{"status":"healthy","dependencies":{"database":"up","redis":"up"}}')
'''


class DeploymentTests(unittest.TestCase):
    def run_deploy(self, failure=''):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'scripts').mkdir()
            (root / '.git').mkdir()
            customer = root / 'customers/test'
            customer.mkdir(parents=True)
            (customer / '.env').touch()
            (customer / 'docker-compose.override.yml').touch()
            script = root / 'scripts/deploy_customer.sh'
            shutil.copyfile(SCRIPT, script)
            bin_dir = root / 'bin'
            bin_dir.mkdir()
            for tool in ('git', 'docker', 'curl', 'flock'):
                stub = bin_dir / tool
                stub.write_text(STUB)
                stub.chmod(0o755)
            env = dict(os.environ, PATH=str(bin_dir)+os.pathsep+os.environ['PATH'],
                       CALL_LOG=str(root / 'calls'), FAILURE=failure)
            result = subprocess.run(['bash', str(script), 'test'], env=env,
                                    capture_output=True, text=True)
            calls = (root / 'calls').read_text()
            return result, calls

    def test_success_and_order(self):
        result, calls = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        for before, after in [('/backup.sh', 'git fetch'), ('sha256sum', 'git fetch'),
                              ('git merge --ff-only', 'build backend'),
                              ('build backend', 'up -d --no-deps')]:
            self.assertLess(calls.index(before), calls.index(after))
        self.assertNotIn('down', calls)
        self.assertIn('Deployed new', result.stdout)

    def test_failures_before_restart(self):
        for failure in ('dirty', 'project', 'missing-db', 'backup', 'checksum',
                        'copy-corrupt', 'fetch', 'build'):
            with self.subTest(failure=failure):
                result, calls = self.run_deploy(failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('up -d', calls)
                if failure in ('backup', 'checksum', 'copy-corrupt'):
                    self.assertNotIn('git fetch', calls)

    def test_post_restart_failures_do_not_claim_success(self):
        for failure in ('migration', 'public-health'):
            result, calls = self.run_deploy(failure)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('Deployed new', result.stdout)
            self.assertNotIn('restore.sh', calls)


if __name__ == '__main__':
    unittest.main()
