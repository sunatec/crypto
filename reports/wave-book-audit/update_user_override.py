from pathlib import Path
import json
root=Path('D:/Workspace/crypto/reports/wave-book-audit')
override='''# 用户确认的书籍勘误与实现例外

## OV-001：Y > 90% W 降为指引

来源：本次评审后的用户明确确认：

> 这个不用修，这是书籍错误，确实要降成指引

适用范围：双锯齿与三锯齿中的 Y/W > 0.9 比率条件。

书籍原文：§7.1 p0024 将该条件列为必须满足的比率规则；原文提取保留，不改写书籍。

本项目采用的规则：**Soft Guideline**。满足可作为支持，不满足只影响软指引评分，不可仅凭 Y/W <= 0.9 判 invalid。

实现决定：保留现有 zigzag-double.guide.y-gt-0.9w 与 zigzag-triple.guide.y-gt-0.9w，不恢复为硬规则。原评审 F01 的理论错误结论撤回，不列入修复清单；现有相关 golden 断言不因这项勘误而需要修改。

BTC 示例 Y/W≈0.879：不能仅因该比率否定双锯齿；W/Y 单锯齿内部结构、其他适用硬规则及完成证据仍须分别验证。这项例外不改变其他比率规则，也不改变单锯齿 C/B 的90%要求。

依据优先级：用户明确确认的勘误优先于书籍对应原句；其他未经确认的条文继续按原书基线评审。以后再生成或实施修复时必须保留该例外。
'''
(root/'book-rule-overrides.md').write_text(override,encoding='utf-8')
(root/'book-rule-overrides.json').write_text(json.dumps({'overrides':[{'id':'OV-001','source':'用户明确确认书籍勘误','bookSection':'7.1','bookParagraph':'p0024','patterns':['zigzag-double','zigzag-triple'],'condition':'Y/W > 0.9','bookStrength':'hard','effectiveStrength':'guideline','implementation':'preserve','invalidateOnFailure':False}]},ensure_ascii=False,indent=2),encoding='utf-8')
def update(name,pairs):
    p=root/name;s=p.read_text(encoding='utf-8-sig')
    for old,new in pairs:
        if old not in s:raise RuntimeError(f'missing replacement in {name}: {old[:70]}')
        s=s.replace(old,new)
    p.write_text(s,encoding='utf-8')
update('book-rules-baseline.md',[
('本文件只依据本地书籍，未读取程序实现。用于随后建立', '本文件先依据本地书籍独立建立，未读取程序实现；后续用户确认的勘误另行覆盖，见 [OV-001](D:/Workspace/crypto/reports/wave-book-audit/book-rule-overrides.md)。用于随后建立'),
('| D05 | H | **price(Y)>.9price(W)**且<5price(W)，并且>price(X)。这是比率规则，不是“Y常接近W”的指引。 | §7.1 p0024–0026 |', '| D05 | H + S（用户勘误） | Y<5W、Y>X仍为硬规则；**Y>.9W按用户确认勘误降为指引**。原书p0024列硬规则的事实保留；本项目不据此比率单独判invalid。 | §7.1 p0024–0026；[OV-001](D:/Workspace/crypto/reports/wave-book-audit/book-rule-overrides.md) |'),
('| .9 | H：zigzag c/b下限（等号U02）、double Y/W> .9。 | §4.1 p0016；§7.1 p0024 |', '| .9 | H：zigzag c/b下限（等号U02）；S：双/三锯齿Y/W>.9，按用户确认勘误。 | §4.1 p0016；§7.1 p0024；[OV-001](D:/Workspace/crypto/reports/wave-book-audit/book-rule-overrides.md) |')])
update('build_review.py',[
('把双/三锯齿 Y>0.9W 硬规则降为指引、',''),
('没有借通用 Elliott 理论补齐缺章。','没有借通用 Elliott 理论补齐缺章。\n\n**用户确认的例外 OV-001**：Y>90%W 是书籍错误，本项目保留为指引，优先于原书p0024。此前对此项“理论错误”的结论撤回；代码与相关golden断言不因这项勘误而需要修改。[勘误记录](D:/Workspace/crypto/reports/wave-book-audit/book-rule-overrides.md)。其他未经用户确认的条文仍按书籍基线评审。'),
('X∈[.2W,W)；**Y>.9W**、Y<5W、Y>X；','X∈[.2W,W)；Y<5W、Y>X；'),
('Y≈W/1.618W、X≈.3–.7W是指引。','Y>.9W按用户确认勘误为指引；Y≈W/1.618W、X≈.3–.7W也为指引。'),
('| F01 A / P0 硬→软 | §7.1：“y浪的价格必须大于w浪的价格的90%。”@B:7:24@ | [双锯齿](D:/Workspace/crypto/analyze-wave-tree.js:771)、[三锯齿](D:/Workspace/crypto/analyze-wave-tree.js:828)删除下界，改guideline，注释称“书籍勘误”。没有书内勘误依据；BTC Y/W≈.8793自身价格规则仍全过。 |', '| F01 已撤回 / 用户勘误 | 原书§7.1将Y>.9W列为硬规则，用户明确确认该处书籍错误，应降为指引。@B:7:24@ | 现有双/三锯齿guideline实现保留，符合本项目采用的勘误；不进入修复清单。见[OV-001](D:/Workspace/crypto/reports/wave-book-audit/book-rule-overrides.md)。 |'),
('禁用类型、Y>90%、扩散终结许可','禁用类型、扩散终结许可'),
('已确认反向错误是Y>.9W **Hard被降成Soft**（F01）。','Y>.9W保留为Soft，属于用户确认的书籍勘误（OV-001），不再作为Hard降Soft错误。'),
('| P0 | 恢复§7.1 Y>.9W硬规则；清理无依据“勘误”注释及锁定错误的golden断言；合法候选与失败诊断分开 | BTC所列Y/W≈.8793作为该双锯齿必须有明确硬失败；没有合法主选就输出待证/暂无，不用违规最少充当成立。不能顺手宣布新的唯一浪型。 |', '| P0 | 合法候选与失败诊断分开；保留用户确认的Y>.9W软指引 | 没有合法主选就输出待证/暂无，不用违规最少充当成立；Y/W≈.879不能单独构成硬失败。不得恢复OV-001为硬规则，也不能顺手宣布新的唯一浪型。 |'),
('按§7.1它不能通过**双锯齿**Y>90%W的硬规则；W/Y是否单锯齿是独立的第二层问题。不能因为内部下探到1h就让这个已知外层价格失败消失。','按用户确认的OV-001，Y>90%W是指引，**不能仅因Y/W≈.879否定双锯齿**。W/Y是否分别为单锯齿、其他硬规则与完成状态须独立验证；比率失分不等于完整结构已成立。'),
('| §7.1真实BTC Y/W<.9 | 不一致（自身规则）：零失败；未来子浪证据不能修复外层已知硬失败 | Rule错误降级→Candidate评分错误 |','| §7.1真实BTC Y/W<.9，用户勘误OV-001 | 一致（自身规则层）：Y>.9W为软指引，.879不单独构成硬失败；子浪与其他硬规则另验 | 无该项偏离；保留现有实现 |'),
('golden测试直接断言Y/W≈.879“规则全过”，应按首要书籍修订。','golden中Y/W≈.879不构成自身硬失败的断言符合用户勘误，不因这项比率需要修订；仍需分别验证子浪约束。')])
update('build_rule_map.py',[
('错误：<5实现成≤5；另一硬下限>.9W被降级','错误：<5实现成≤5；>.9W按OV-001保留为指引'),
('错误：<5实现成≤5；硬下限>.9W被降级','错误：<5实现成≤5；>.9W按OV-001保留为指引'),
('错误强度：原文Hard Rule，应恢复硬下限','符合用户确认勘误OV-001；保留为指引，不恢复硬下限'),
("'bookSha256':'4c7cd332cf0081392164177a6ead7dbcdc216c8b41b760a023e52325ec8e9b5b'", "'bookRuleOverrides':['OV-001: Y/W > 0.9保留为guideline，用户确认书籍勘误'],'bookSha256':'4c7cd332cf0081392164177a6ead7dbcdc216c8b41b760a023e52325ec8e9b5b'")])
update('run-book-cases.js',[
("manualCase('BTC_WXY_y_below_90pct','§7.1 p0024',[126296,80524.65,97963.62,57717.55],e.buildDoubleZigzagManual,null,{reject:true,reason:'Y/W=0.8793 <0.9，违反比率规则'});", "manualCase('BTC_WXY_y_below_90pct','§7.1 p0024；用户确认勘误OV-001',[126296,80524.65,97963.62,57717.55],e.buildDoubleZigzagManual,null,{reject:false,reason:'Y/W≈0.879 <0.9，仅软指引失分，不单独构成硬失败；子浪另验'});")])
p=root/'book-reading-record.md';s=p.read_text(encoding='utf-8-sig');s+='\n\n## 后续用户确认勘误\n\n上述阅读记录描述原书文本，不改写原文。用户在评审后明确确认：§7.1 Y>90%W为书籍错误，应降为指引。后续评审与修复以[OV-001](D:/Workspace/crypto/reports/wave-book-audit/book-rule-overrides.md)覆盖这项原始基线，保留现有代码，不按该比率否定BTC双锯齿。\n';p.write_text(s,encoding='utf-8')
print('updated override, baseline, review generators and audit expectation; no engine changes')
