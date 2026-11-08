import fs from 'node:fs';
import crypto from 'node:crypto';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const manifest=JSON.parse(fs.readFileSync('tmp/chanlun/center-validation.pine.json','utf8'));
const pine=fs.readFileSync(manifest.output);
const production=fs.readFileSync('chanlun_original.pine');
if(sha(pine)!==manifest.sha256 || sha(production)!==manifest.productionSha256)throw Error('manifest is stale');
const validationSnapshot=`tmp/chanlun/compiled/center-Z13-pending-${manifest.sha256}.pine`;
const productionSnapshot=`tmp/chanlun/compiled/production-center-continuation-pending-${manifest.productionSha256}.pine`;
fs.writeFileSync(validationSnapshot,pine);
fs.writeFileSync(productionSnapshot,production);
const file='tmp/chanlun/center-platform-results.json';
const results=JSON.parse(fs.readFileSync(file,'utf8'));
const historical=(results.pending??[]).filter(p=>p.status==='latest-display-version-not-independently-bound');
results.unverifiedHistoricalVersions=[...(results.unverifiedHistoricalVersions??[]),...historical];
results.pending=[
  {date:'2026-11-04',source:'tmp/chanlun/center-validation.pine',sha256:manifest.sha256,coreHash:manifest.coreHash,fixtureHash:manifest.fixtureHash,snapshot:validationSnapshot,status:'awaiting-user-Pine-result',cases:13,prefixes:91,localChecks:'56 Node tests passed; not Pine execution',change:'Case data moved to 13 independent functions after user CE10205 at line 1295; production and expectations unchanged',expected:'PASS: 13 Z cases, 91 prefixes'},
  {date:'2026-11-04',source:'chanlun_original.pine',sha256:manifest.productionSha256,coreHash:manifest.coreHash,snapshot:productionSnapshot,status:'awaiting-shared-validation-then-entry-check',scope:'Continuous centers and current relation evidence; no R completion or L2 completed input'}
];
fs.writeFileSync(file,JSON.stringify(results,null,2)+'\n');
const logFile='docs/chanlun/validation.md';
const heading='## 连续中枢V2：离开归属与关系证据（2026-11-04）';
const log=fs.readFileSync(logFile,'utf8');
if(!log.includes(heading))fs.appendFileSync(logFile,`\n${heading}\n\n复核仓库PDF第42–44页，以Z-003记录同向分离与波动包络重叠，以E-010单列离开归属暂存、新中枢种子及关闭证明的工程口径。连接段不提前混入旧GG/DD；形成第三部件仍保留必要来源。关系标签是可变化的当前证据，不作为R完成或L2完成输入。旧Z7 PASS和“Z入口正常”保留原版本范围，不能外推本轮。原V1样例保存在tmp/chanlun/compiled/center-Z7-fixtures-v1.json。\n\n生产同核V2增加连续编号、离开／回试证明、形成与关闭事件快照、最近15个关闭记录以及最近前中枢的独立计算引用。正式入口绘制近期紫色中枢、累计形成数、最近位置及关系证据。默认每中枢64来源，超限整输入回滚并保留待定归属，不自动重启。大量中枢裁剪、指定行情、实时及压力检查仍待执行。\n\n独立预期为13组91前缀，新增双向延续、返回合并、范围扩展、相等包络及关系变化；延续组推进到第三中枢，检查两次关闭及历史顺序。生成器只读取人工预期，调用原文生产CORE，检查形成／关闭事件原引用不变、来源、确认时刻、前缀重载、重复输入、深复制及原子停止。补第三中枢时发现一处合成输入方向未交替，已修正该新增输入并重新通过格式检查，未根据生产输出改写答案。\n\n本轮55项Node工具检查通过，OpenSpec严格校验通过。这些不是Pine编译或断言结果。新验证脚本SHA-256为${manifest.sha256}，CORE为${manifest.coreHash}，${manifest.bytes}字节；预期PASS: 13 Z cases, 91 prefixes，需91根已收盘K线。已请求用户运行，实际结果待回传；快照${validationSnapshot}。正式文件SHA-256为${manifest.productionSha256}，快照${productionSnapshot}，尚待共享验证后进行入口复核。结构化结果见tmp/chanlun/center-platform-results.json。任务5.3及8.1保持未完成，总进度20/43。\n`);
console.log(JSON.stringify({validation:manifest.sha256,production:manifest.productionSha256,bytes:manifest.bytes,cases:13,prefixes:91,status:'pending Pine'},null,2));
