import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('logs',Path(__file__).resolve().parents[1]/'src/Relay/log_reader.py');logs=importlib.util.module_from_spec(spec);spec.loader.exec_module(logs)
class LogTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name);self.path=self.root/'messages.log'
 def test_pages_have_no_duplicates_or_missing_complete_lines(self):
  lines=[f'09/19/26-10:00:00 (123) 0 entry {i}' for i in range(1000)];self.path.write_text('\n'.join(lines)+'\n');cursor='';pages=[]
  for i in range(20):
   p=logs.page(self.root,'runtime',cursor);self.assertNotIn('error',p);self.assertLessEqual(len(p['rows']),150);pages.insert(0,[r['Message'] for r in p['rows']]);cursor=p['nextCursor']
   if not cursor:break
  self.assertFalse(cursor);self.assertEqual([v for page in pages for v in page],[f'entry {i}' for i in range(1000)])
 def test_append_rotation_and_invalid_cursor_require_refresh(self):
  self.path.write_text('a\n'*200);cursor=logs.page(self.root)['nextCursor'];self.path.write_text('b\n'*200);self.assertIn('error',logs.page(self.root,'runtime',cursor));self.assertIn('error',logs.page(self.root,'runtime','bad!'))
 def test_missing_sources_are_unavailable_not_zero_and_paths_are_rejected(self):
  self.assertTrue(all(not r['available'] and r['bytes'] is None for r in logs.catalog(self.root)['sources']));self.assertIn('error',logs.page(self.root,'../private'));self.assertIn('error',logs.page(self.root,'runtime'))
 def test_symlinks_are_not_followed(self):
  other=self.root/'secret';other.write_text('private');self.path.symlink_to(other);self.assertIn('error',logs.page(self.root));self.assertFalse(logs.catalog(self.root)['sources'][0]['available'])
 def test_unterminated_and_oversized_lines_are_not_complete_records(self):
  self.path.write_text('complete\npartial');p=logs.page(self.root);self.assertEqual([r['Message'] for r in p['rows']],['complete']);self.path.write_text('x'*200000+'\n');p=logs.page(self.root);self.assertTrue(p['nextCursor']);self.assertEqual(p['rows'],[])
 def test_rotation_and_message_bounds(self):
  (self.root/'messages.log.1').write_text('a'*3000+'\n');p=logs.page(self.root,'runtime.1');self.assertTrue(p['rows'][0]['MessageTruncated']);self.assertEqual(len(p['rows'][0]['Message']),2000)
