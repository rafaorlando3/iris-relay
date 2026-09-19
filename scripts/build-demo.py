#!/usr/bin/env python3
"""Build a static, credential-free fictional walkthrough under docs/demo."""
from pathlib import Path
import shutil
root=Path(__file__).resolve().parents[1];target=root/'docs/demo';target.mkdir(exist_ok=True)
for source in (root/'public').iterdir():
 if source.suffix in ['.js','.css','.html']:
  if source.name=='index.html':
   text=source.read_text().replace('<html lang="en">','<html lang="en" data-mode="demo">').replace('IRIS Relay · Operations workspace','IRIS Relay · Interactive walkthrough').replace('<section id="login-panel">','<section id="login-panel" hidden>')
   (target/source.name).write_text(text)
  else:shutil.copyfile(source,target/source.name)
(target/'.nojekyll').touch()
print('Built static demonstration: docs/demo/index.html')
