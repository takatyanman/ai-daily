from pathlib import Path
import sys,xml.etree.ElementTree as ET
from urllib.parse import urlparse
root=Path(sys.argv[1] if len(sys.argv)>1 else 'dist')
feed=ET.parse(root/'feed.xml').getroot()
items=feed.findall('./channel/item')
assert items and len(items)<=30
assert len({i.findtext('guid') for i in items})==len(items)
for i in items:
 url=i.findtext('link');assert urlparse(url).scheme=='https'
 assert (root/'articles'/Path(urlparse(url).path).name).is_file()
 assert i.findtext('description') and i.findtext('category')=='AI作成記事'
 thumbnail=i.find('{http://search.yahoo.com/mrss/}thumbnail')
 if thumbnail is not None:
  image_url=thumbnail.attrib['url'];assert urlparse(image_url).scheme=='https'
  image=root/'illustrations'/Path(urlparse(image_url).path).name
  data=image.read_bytes()
  assert data[:8]==b'\x89PNG\r\n\x1a\n'
  assert int.from_bytes(data[16:20],'big')==640 and int.from_bytes(data[20:24],'big')==360
print(f'RSS XML validated; {len(items)} items and matching article pages')
