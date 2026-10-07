from pathlib import Path
import re,json
root=Path('D:/Workspace/crypto');d=root/'reports/wave-book-audit'
files=['review.md','book-rules-baseline.md'];issues=[]
for f in files:
    s=(d/f).read_text(encoding='utf-8');
    for target in re.findall(r'\]\((D:/Workspace/crypto/[^)]+)\)',s):
        mm=re.match(r'(.*):(\d+)$',target); p=Path(mm[1] if mm else target)
        if not p.exists():issues.append({'file':f,'missing':target})
        elif mm and int(mm[2])>len(p.read_text(encoding='utf-8-sig').splitlines()):issues.append({'file':f,'lineOutOfRange':target})
    if '@B:' in s:issues.append({'file':f,'unresolvedBookLinks':True})
print(json.dumps({'linkIssues':issues,'sections':re.findall(r'^## (\d+)\.',(d/'review.md').read_text(encoding='utf-8'),re.M)},ensure_ascii=False))
