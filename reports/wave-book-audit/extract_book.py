from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET
import hashlib,json,re
book=Path('books/波浪理论详解.epub')
out=Path('reports/wave-book-audit/book-extract');out.mkdir(parents=True,exist_ok=True)
index=[]
with ZipFile(book) as z:
    opf=ET.fromstring(z.read('EPUB/content.opf'))
    metadata={e.tag.split('}')[-1]:e.text for e in opf.iter() if e.tag.split('}')[-1] in ('title','creator','language','publisher','date')}
    for name in z.namelist():
        if not re.search(r'text/ch\d+\.xhtml$',name):continue
        root=ET.fromstring(z.read(name));lines=[f'# EPUB source: {name}',''];paragraphs=[]
        for e in root.iter():
            tag=e.tag.split('}')[-1]
            if tag in ('h1','h2','h3','h4','h5','h6','p','li'):
                if tag=='li' and any(c.tag.split('}')[-1]=='p' for c in e):continue
                text=' '.join(''.join(e.itertext()).split())
                images=[c.attrib.get('src') for c in e.iter() if c.tag.split('}')[-1]=='img']
                if not text and not images:continue
                pid=f'p{len(paragraphs)+1:04d}'
                anchor=e.attrib.get('id','')
                prefix='#'*int(tag[1])+' ' if re.match(r'h\d',tag) else ''
                lines.append(f'{prefix}[{pid}] {text}')
                if anchor:lines.append(f'EPUB anchor: {anchor}')
                for src in images:lines.append(f'Image: {src}')
                lines.append('')
                paragraphs.append({'id':pid,'anchor':anchor,'text':text,'images':images})
        target=out/(Path(name).stem+'.md');target.write_text('\n'.join(lines),encoding='utf8')
        index.append({'source':name,'file':str(target),'paragraphs':paragraphs})
    toc=ET.fromstring(z.read('EPUB/toc.ncx'));ns={'n':'http://www.daisy.org/z3986/2005/ncx/'}
    nav=[{'title':n.find('n:navLabel/n:text',ns).text,'src':n.find('n:content',ns).attrib['src']} for n in toc.findall('.//n:navPoint',ns)]
manifest={'book':str(book),'sha256':hashlib.sha256(book.read_bytes()).hexdigest(),'metadata':metadata,'toc':nav,'chapters':index}
(out/'index.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps({'metadata':metadata,'sha256':manifest['sha256'],'chapters':[{'source':x['source'],'paragraphs':len(x['paragraphs'])} for x in index]},ensure_ascii=False))
