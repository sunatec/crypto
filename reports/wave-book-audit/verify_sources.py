from pathlib import Path
import hashlib,json
r=Path('D:/Workspace/crypto');d=r/'reports/wave-book-audit'; receipt=json.loads((d/'audit-receipt.json').read_text(encoding='utf-8'))
print(json.dumps({'reviewedSourcesUnchangedSinceReceipt':all(hashlib.sha256((r/f).read_bytes()).hexdigest()==sha for f,sha in receipt['sourceFiles'].items())}))
for name in ['refine_cases.py','extend_cases.py','finalize_cases.py']:
    p=(d/name).resolve()
    if not p.is_relative_to(d.resolve()): raise RuntimeError('outside audit directory')
    if p.exists(): p.unlink()
print('removed three audit-only temporary editing helpers')
