from pathlib import Path
import json
from pypdf import PdfReader

book = next(Path('books').glob('*.pdf'))
target = Path('tmp/chanlun/r-completion-pages.json')
if target.exists():
    pages = json.loads(target.read_text(encoding='utf-8'))
else:
    pages = [{'page': i+1, 'text': page.extract_text()} for i, page in enumerate(PdfReader(book).pages)]
    target.write_text(json.dumps(pages, ensure_ascii=False, indent=2), encoding='utf-8')
selected = [39,40,74,75,94,95,97,98,164,165,214,215,217,218,219,220,221,222,223,224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,240,241,242,243,244,245,246,247,248,249,250,251,252,253,254,255]
Path('tmp/chanlun/r-completion-source.txt').write_text('\n\n'.join(f'PAGE {p}\n{pages[p-1]["text"]}' for p in selected), encoding='utf-8')
terms = ['走势类型的完成','走势类型完成','走势的完成','走势结束','走势类型的结束','完全分类','唯一','分解定理','结合律','确认','递归','同级别分解']
hits = []
for p in pages:
    text = p['text'].replace('\n', '')
    for term in terms:
        offset = 0
        while (at := text.find(term, offset)) >= 0:
            hits.append({'page': p['page'], 'term': term, 'context': text[max(0, at-80):at+160]})
            offset = at + len(term)
Path('tmp/chanlun/r-completion-hits.json').write_text(json.dumps(hits, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'pages':len(pages), 'selected':len(selected), 'hits':len(hits)}))
