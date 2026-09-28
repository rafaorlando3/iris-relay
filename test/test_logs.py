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
 def test_archived_rotations_are_listed_newest_first_and_readable(self):
  a=self.root/'messages.old_20260927';b=self.root/'messages.old_20260928';c=self.root/'messages.old_20260928_1'
  for i,f in enumerate([a,b,c]):
   f.write_text(''.join(f'09/2{7+min(i,1)}/26-10:00:00 (1) 0 {f.name} line {n}\n' for n in range(400)));os.utime(f,(1000+i,1000+i))
  (self.root/'messages.old_20260926.gz').write_text('compressed');(self.root/'notes.old_1').write_text('x')
  cat=logs.catalog(self.root);old=[r for r in cat['sources'] if r.get('archived')]
  self.assertEqual([r['id'] for r in old],['runtime.old_20260928_1','runtime.old_20260928','runtime.old_20260927'])
  self.assertEqual([r['name'] for r in old],['messages.old_20260928_1','messages.old_20260928','messages.old_20260927'])
  self.assertTrue(all(r['available'] and r['bytes']>0 and r['modified'] for r in old));self.assertEqual(cat['archivedOmitted'],0)
  p=logs.page(self.root,'runtime.old_20260927');self.assertNotIn('error',p);self.assertEqual(p['source'],'messages.old_20260927');self.assertEqual(p['rows'][-1]['Message'],'messages.old_20260927 line 399');self.assertEqual(p['rows'][-1]['Pid'],1)
  seen=[];cursor=''
  for _ in range(10):
   p=logs.page(self.root,'runtime.old_20260927',cursor);self.assertNotIn('error',p);seen=[r['Message'] for r in p['rows']]+seen;cursor=p['nextCursor']
   if not cursor:break
  self.assertEqual(seen,[f'messages.old_20260927 line {n}' for n in range(400)])
  self.assertIn('error',logs.page(self.root,'runtime.old_20260928_1',logs.page(self.root,'runtime.old_20260927')['nextCursor']))
 def test_archived_ids_cannot_escape_or_follow_links(self):
  for bad in ['runtime.old_../x','runtime.old_a/b','runtime.old_','runtime.old_'+'a'*49,'system-monitor.old_1','alerts.old_1','runtime.old_a.gz','runtime.old_%2e%2e','messages.old_1']:
   self.assertIn('error',logs.page(self.root,bad),bad)
  other=self.root/'secret';other.write_text('private\n');(self.root/'messages.old_20260101').symlink_to(other)
  self.assertFalse([r for r in logs.catalog(self.root)['sources'] if r.get('archived')]);self.assertIn('error',logs.page(self.root,'runtime.old_20260101'))
  self.assertIn('error',logs.page(self.root,'runtime.old_20260102'))
 def test_archived_listing_is_bounded(self):
  for i in range(30):
   f=self.root/f'messages.old_202609{i:02d}';f.write_text('x\n');os.utime(f,(2000+i,2000+i))
  (self.root/'cconsole.old_20200101').write_text('legacy\n');os.utime(self.root/'cconsole.old_20200101',(1,1))
  cat=logs.catalog(self.root);old=[r for r in cat['sources'] if r.get('archived')]
  self.assertEqual(len(old),logs.ARCHIVE_LIMIT);self.assertEqual(cat['archivedOmitted'],31-logs.ARCHIVE_LIMIT);self.assertEqual(old[0]['id'],'runtime.old_20260929')
  self.assertEqual(logs.page(self.root,'console.old_20200101')['rows'][0]['Message'],'legacy')
