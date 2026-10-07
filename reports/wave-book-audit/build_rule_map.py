from pathlib import Path
import json,re,hashlib,subprocess,datetime
from build_review import OUT,ROOT,b,code
catalog=json.loads((OUT/'implemented-rules.json').read_text(encoding='utf-8'))
src=(ROOT/'analyze-wave-tree.js').read_text(encoding='utf-8'); lines=src.splitlines()
def where(id):
    candidates=[i+1 for i,s in enumerate(lines) if f"makeJudge('{id}'" in s]
    return candidates[0] if candidates else next(i+1 for i,s in enumerate(lines) if id in s)
rulemap={
'impulse.pattern.wave2-not-retrace-100':(1,73,'部分正确：严格端点；缺完整2路径的极值上下文'),
'impulse.pattern.wave3-exceeds-wave1-end':(1,75,'正确（端点层）'),
'impulse.pattern.wave4-not-cross-wave1':(6,230,'部分正确：只查p4，缺所有内部子浪高低'),
'impulse.pattern.wave3-not-shortest':(1,84,'绝对长度正确；§3.16价格运动百分比另缺'),
'impulse.ratio.wave2-retrace-range':(3,134,'额外硬限制：.236–.886来源未找到；例证下限.2'),
'impulse.ratio.wave3-extend-range':(1,84,'错误：≥1排除3第二长；4.236上限来源待补'),
'diagonal.pattern.wave2-not-retrace-100':(1,73,'部分正确：端点层，缺完整子浪路径'),
'diagonal.pattern.wave3-exceeds-wave1-end':(1,75,'正确（端点层）'),
'diagonal.pattern.wave4-allowed-cross-wave1':(1,78,'U01：强制进入1与另节说仅经常进入1存在书内冲突'),
'diagonal.pattern.wave4-not-retrace-100-of-3':(1,81,'正确（端点层）'),
'diagonal.pattern.wave3-not-shortest':(1,84,'绝对长度层符合通用驱动规则'),
'diagonal.pattern.boundaries-converge':(4,67,'可作为收缩分支几何定义，完整判据缺专章；统一所有终结会排除扩散特例'),
'diagonal.ratio.converging':(4,67,'过度限制：无扩散终结分支；收缩具体长度规则缺专章'),
'zigzag.ratio.b-price-between-0.2a-and-a':(4,14,'符合验证手册；B=A另有概述/问答冲突U03'),
'zigzag.ratio.b-not-break-a-start':(4,15,'正确：检查窗口OHLC极值（端点桶事件顺序另属工程）'),
'zigzag.ratio.c-between-0.9b-and-5b':(4,16,'错误：5倍等号不应通过；.9精确下界U02'),
'zigzag.time.b-lt-10a':(4,19,'正确（按bar数度量时间；未建交易/缺bar语义）'),
'zigzag.time.c-lt-10a-and-10b':(4,20,'正确上限及且关系；按bar数度量'),
'flat.ratio.b-gross-at-least-70pct-of-a':(5,12,'gross基准正确；.7等号U04'),
'flat.ratio.b-gross-below-200pct-of-a':(5,13,'与手册<2不符，定义允许=2，精确边界U04'),
'flat.ratio.c-overlaps-a':(5,14,'方向与gross检查部分正确；子角色与截尾禁止另缺'),
'flat.ratio.c-gross-limit':(5,15,'符合手册两个条件同时满足；问答上限冲突U05'),
'flat.time.b-lt-10a':(5,18,'正确上限；按bar数'),
'flat.time.c-lt-10a-and-10b':(5,19,'正确指定前腿和且关系；按bar数'),
'flat-regular.ratio.b-le-a':(5,58,'正确≤1（各腿gross）'),
'flat-expanded.ratio.b-gt-a':(5,61,'错误：>1实现成≥1'),
'flat-expanded.pattern.c-exceeds-a-end':(5,61,'正确严格超过端点'),
'flat-running.ratio.b-gt-a':(5,68,'错误：>1实现成≥1'),
'flat-running.pattern.c-not-exceed-a-end':(5,68,'端点上限正确；本模式还需禁c截尾'),
'sideways-double.ratio.x-retrace-70pct-of-w':(1,119,'70%阈值有来源；gross基准待缺失第8章核实，上界缺片段约束'),
'sideways-triple.ratio.x-retrace-70pct-of-w':(1,123,'70%阈值有来源；gross基准待第8章核实'),
'sideways-triple.ratio.xx-retrace-70pct-of-y':(1,123,'70%阈值有来源；gross基准待第8章核实'),
 'triangle.pattern.longest-is-a-or-b':(6,29,'部分正确：按端点price比较，完整gross/路径几何另缺'),
 'triangle.pattern.e-within-a-range':(6,30,'符合E终点区域要求（端点层）'),
 'triangle.ratio.b-vs-a':(6,32,'错误：<2实现成≤2'),
 'triangle.ratio.c-vs-b':(6,33,'错误：<1实现成≤1'),
 'triangle.ratio.d-vs-c':(6,34,'符合手册[.5,1]及水平B-D特例；概述措辞U09'),
 'triangle.ratio.e-vs-d':(6,35,'错误：<1实现成≤1；.25下限符合手册'),
 'triangle.time.d-le-4c':(6,41,'正确上限≤4C，不是与B/D任意比较'),
 'triangle.time.e-le-4c':(6,42,'正确上限≤4C，不是≤4D'),
 'zigzag-double.ratio.x-retrace-20-100':(7,21,'部分正确：下限.2；上限<1实现成≤1'),
 'zigzag-double.ratio.y-lt-5w':(7,25,'错误：<5实现成≤5；>.9W按OV-001保留为指引'),
 'zigzag-double.ratio.y-gt-x':(7,26,'错误：>1实现成≥1'),
 'zigzag-double.time.x-lt-5w':(7,35,'符合手册≤5W'),
 'zigzag-double.time.y-lt-5w':(7,36,'符合手册≤5W；§6.11旁述≤10W冲突U14'),
 'zigzag-double.time.y-not-both-5x':(7,37,'正确：禁止价/时同时超过；不是或关系'),
 'zigzag-triple.ratio.x-retrace-20-100':(7,21,'部分正确：下限.2；上限应<1'),
 'zigzag-triple.ratio.y-lt-5w':(7,25,'错误：<5实现成≤5；>.9W按OV-001保留为指引'),
 'zigzag-triple.ratio.y-gt-x':(7,26,'错误：>1实现成≥1'),
 'zigzag-triple.ratio.xx-retrace-20-100':(7,28,'部分正确：下限.2；上限应<1'),
 'zigzag-triple.ratio.z-vs-xx-y-w':(7,31,'Z≥XX正确；<5Y/<5W等号错误'),
 'zigzag-triple.time.x-lt-5w':(7,35,'正确≤5W'),
 'zigzag-triple.time.y-lt-5w':(7,36,'符合手册≤5W；旁述U14'),
 'zigzag-triple.time.z-lt-5w-5y':(7,38,'正确两个≤5同时满足'),
 'zigzag-triple.time.y-not-both-5x':(7,37,'正确共享Y对X的价时联合限制'),
 'zigzag-triple.time.z-not-both-5xx':(7,41,'正确Z对XX；但§7.1 Z对X联合限制未实现'),
}
guidemap={
'impulse.guide.alternation-2-4':(1,134,'软项类别正确，但比率差>.15不是书定义的陡直/横向交替'),
'impulse.guide.wave3-common-extension':(3,166,'1.618/2.618属于常用扩展，具体3常见范围缺专章；容差额外'),
'impulse.guide.wave4-time-balance':(3,46,'具体.2–5倍4/2暂未找到来源；额外软策略'),
'diagonal.guide.wave5-time-shorter':(3,46,'缺楔形专章，暂未找到该具体指引'),
'zigzag.guide.b-common-ratio':(4,28,'符合常见目录；未编码常见顺序；±.08为额外容差'),
'zigzag.guide.c-common-ratio':(4,29,'部分覆盖：缺从A终点扩展.618A的第四常见关系；±.1额外'),
'zigzag.guide.b-not-approach-a-start':(4,23,'软语义方向符合；.9阈值额外，另有.86及U03'),
'zigzag.guide.c-not-far-beyond-1.618a':(4,30,'保持软项正确；远超量化为一超过即失分是工程近似'),
'zigzag.guide.b-time-window':(4,33,'按手册.618–1.61；正文1.618，非硬界限'),
'flat.guide.c-common-ratio':(5,32,'部分覆盖1/1.618，缺A终点及从A终点扩展.618A'),
 'triangle.guide.618-pair':(6,50,'软项符合；只测C/A与D/B，未覆盖所有同向对'),
 'triangle.guide.e-retrace-70-of-d':(6,52,'软项符合；±.15额外'),
 'zigzag-double.guide.x-retrace-30-70':(7,46,'软项区间符合；未按.382/.5/.618常见排序'),
 'zigzag-double.guide.y-gt-0.9w':(7,24,'符合用户确认勘误OV-001；保留为指引，不恢复硬下限'),
 'zigzag-double.guide.y-near-w-or-1.618':(7,48,'软项符合；容差额外'),
 'zigzag-double.guide.x-time-window':(7,56,'软项符合'),
 'zigzag-triple.guide.x-retrace-30-70':(7,46,'软项符合，具体常见次序未覆盖'),
 'zigzag-triple.guide.xx-retrace-30-70':(7,49,'软项符合，具体常见次序未覆盖'),
 'zigzag-triple.guide.y-gt-0.9w':(7,24,'符合用户确认勘误OV-001；保留为指引，不恢复硬下限'),
}
rows=['','| 代码判据 / 当前类型 | 书籍规则来源 | 具体实现及一致性 |','| --- | --- | --- |']
seen=set()
for pat in catalog:
    for rule in pat['rules']+pat['guidelines']:
        id=rule['id']
        if id in seen:continue
        seen.add(id); mp=(guidemap if rule['kind']=='guideline' else rulemap)
        if id not in mp:raise ValueError('unmapped '+id)
        ch,p,verdict=mp[id]
        rows.append(f"| {code('analyze-wave-tree.js',where(id),id)} / {rule['kind']}·{rule['layer']} | {b(ch,p)} | {rule['desc']}；{verdict} |")
text=(OUT/'review.md').read_text(encoding='utf-8')+'\n'.join(rows)+'\n\n'
text+='''### 书中存在但当前注册判据未覆盖（补充）

| 书籍条款 | 应落入位置 | 状态 |
| --- | --- | --- |
'''
missing=[(4,12,'A/C不能双衰竭','evaluateChildRoles','缺失'),(4,11,'A引导不能配C终结','evaluateChildRoles','代码有，但真实全verified前不检查'),(4,67,'C可扩散终结且不可失败C','PATTERNS / diagonal variant','无独立扩散分支/组合约束'),(5,53,'平台C-5不得衰竭/截尾','flat后置父子规则','缺失'),(6,15,'三角各腿子型集合','PATTERNS / context roles','仅泛corrective'),(6,21,'收缩/唯一水平线/交点在E右','triangle geometry','未用于Rule'),(6,25,'C/D/E越线各自10%gross基准','triangle full-path validator','缺失'),(6,36,'A/C/D第二子浪<105%第一gross','triangle parent-child validator','缺失'),(6,118,'E可三角但EE不再三角','recursive context','缺失'),(6,200,'驱动2、平台A/B、联合W等禁三角','role registry','缺失/过宽'),(6,230,'推动4所有子浪不得切入1','impulse path validator','仅末点'),(7,13,'W/Y的C不能失败','double/triple parent-child validator','缺失'),(7,40,'Z对X不得价时都超5倍','triple time/price rule','缺失'),(7,82,'Y任意子浪不越0-X','double channel path validator','缺失'),(7,84,'Z任意子浪不越0-X','triple channel path validator','缺失'),(7,66,'Y/W及Z/Y相差一个作者级别','degree model/serializer','depth+1不符合特例'),(3,123,'3的价格运动百分比不能最短','impulse leg measure validator','有movePct工具，未用于此规则'),(3,70,'衰竭5至少完成4的70%','impulse failure validator','仅truncated注记，未验证'),(4,94,'推动2时间≤9倍1','impulse time validator','缺失，完整第9章未提供'),(3,171,'驱动4时间>2倍3可推翻','motive time validator','缺失，例证来源，缺完整细则'),(6,145,'联合X gross最多1.5W gross','sideways upper rule','书内已有片段，当前仅70%下限；完整第8章仍缺'),(6,149,'双重横向Y时间≤5W','sideways time validator','已有片段，当前未覆盖'),(4,60,'联合X不可三角','sideways X role','泛corrective过宽')]
for ch,p,rule,fn,status in missing:text+=f'| {rule}（{b(ch,p)}） | `{fn}` | {status} |\n'
text+='\n### 额外工程参数与来源空白\n\n| 参数/做法 | 影响 | 来源结论 |\n| --- | --- | --- |\n'
for a,impact in [('SEVERE_OVERSHOOT=.5','改变失败诊断排名'),('GRAMMAR_OVERSHOOT=.25','子角色失败的越界权重'),('复杂度1/2/3','优先单结构，早于指引'),('兄弟浪最大/最小振幅≤6（仅B）','额外硬闸门，改变B排序'),('pendingRatio节点计数','树形改变分母，改变主选'),('父角色band与中心距离','X/B/转势身份排序'),('12显著点/60组合/beam/maxDepth','可能漏解，不能当完备性证明'),('±.08/.1/.15/.2/.3/.4、价格精度半tick','比率指引与端点匹配容差'),('端点相等极值要求唯一小时','未知保持pending，合理保守工程选择'),('全局高低作为主树首尾、末腿终点必须极值','可能排除书允许终点≠极值的特殊结构'),('2%微移末点判deferred','只反映局部端点判据，不重算gross'),('小时缺口必须连续、数据页298h/3并发','覆盖与取数策略，非理论规则')]:text+=f'| {a} | {impact} | 本地书暂未规定该机械策略，标额外工程规则；检查是否越过Hard Rule或改变证据语义 |\n'
text+='\n终点筛选尤其需重新核对书§3.15/3.16：作者明确起终点不必是整体最高/最低。[原文](D:/Workspace/crypto/reports/wave-book-audit/book-extract/ch004.md:233)。`legEndpointsSpanExtreme`与`finalLegAnchored`把某些内部/末端锚点固定为跨度极值，可能提前排除失败C/衰竭嵌套。具体各段是否必然误删仍需按书例端点和路径重放，不能仅凭手册短C通过就宣布全搜索覆盖正确。\n'
# Replace numeric sentence with computed precise ratio.
text=text.replace('0.879284',f'{40246.07/45771.35:.6f}')
(OUT/'review.md').write_text(text,encoding='utf-8')
files=['analyze-wave-tree.js','wave-subwave-verification.js','analyze-wave-manual.js','market-data.js','tests/fixtures/btc-usd-1d-golden.json']
receipt={'generatedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'bookRuleOverrides':['OV-001: Y/W > 0.9保留为guideline，用户确认书籍勘误'],'bookSha256':'4c7cd332cf0081392164177a6ead7dbcdc216c8b41b760a023e52325ec8e9b5b','sourceFiles':{f:hashlib.sha256((ROOT/f).read_bytes()).hexdigest() for f in files},'ruleMap':{'uniqueRules':len(rulemap),'uniqueGuidelines':len(guidemap)},'commands':[{'command':'node reports/wave-book-audit/run-book-cases.js','result':'24分层审计项；差异见case-results.json，非全部通过'},{'command':'node --test tests/*.test.js','result':'176 pass / 0 fail'}],'limits':['EPUB只有前言和1–7章','无固定页码','无图例原始OHLC','未运行最新end now行情','旧独立CLI的全部规则未逐条映射']}
(OUT/'audit-receipt.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'mappedJudges':len(seen),'missingEntries':len(missing),'reportBytes':(OUT/'review.md').stat().st_size},ensure_ascii=False))
