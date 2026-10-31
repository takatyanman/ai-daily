from pathlib import Path
import sys,xml.etree.ElementTree as ET
from urllib.parse import urlparse
from html.parser import HTMLParser
import re
class Images(HTMLParser):
 def __init__(self):super().__init__();self.urls=[]
 def handle_starttag(self,tag,attrs):
  if tag=='img':self.urls.append(dict(attrs).get('src',''))
def raster_ok(name,data):
 if not data or len(data)>8*1024*1024:return False
 if name.endswith('.png'):return data[:8]==b'\x89PNG\r\n\x1a\n'
 if name.endswith(('.jpg','.jpeg')):return data[:3]==b'\xff\xd8\xff'
 if name.endswith('.webp'):return data[:4]==b'RIFF' and data[8:12]==b'WEBP'
 return False
root=Path(sys.argv[1] if len(sys.argv)>1 else 'dist')
feed=ET.parse(root/'feed.xml').getroot()
items=feed.findall('./channel/item')
assert items and len(items)<=30
assert len({i.findtext('guid') for i in items})==len(items)
for i in items:
 url=i.findtext('link');assert urlparse(url).scheme=='https'
 assert (root/'articles'/Path(urlparse(url).path).name).is_file()
 assert i.findtext('description') and i.findtext('category')=='AI作成記事'
 rich=Images();rich.feed(i.findtext('{http://purl.org/rss/1.0/modules/content/}encoded')or'')
 for image_url in rich.urls:
  image_url=urlparse(image_url)
  if image_url.hostname=='takatyanman.github.io' and image_url.path.startswith('/ai-daily/figures/'):
   name=image_url.path[len('/ai-daily/figures/'):]
   assert re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(png|jpe?g|webp)',name)
   assert raster_ok(name,(root/'figures'/name).read_bytes())
 thumbnail=i.find('{http://search.yahoo.com/mrss/}thumbnail')
 if thumbnail is not None:
  image_url=thumbnail.attrib['url'];assert urlparse(image_url).scheme=='https'
  image=root/'illustrations'/Path(urlparse(image_url).path).name
  data=image.read_bytes()
  assert data[:8]==b'\x89PNG\r\n\x1a\n'
  assert int.from_bytes(data[16:20],'big')==640 and int.from_bytes(data[20:24],'big')==360
print(f'RSS XML validated; {len(items)} items and matching article pages')
