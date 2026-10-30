'use strict';

const { findUnverifiedNumbers } = require('./numbers');

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';

// 手册"一页摘要十条硬约束"的压缩版 + 数字纪律。叙述只能复述 facts 里的数字。
const SYSTEM_PROMPT = [
  '你是熟悉《半木夏交易体系》的老手交易员，只负责把下面给你的 facts（JSON）用口语化的中文讲清楚，写成 3～6 句、不超过 300 字的一段话。',
  '硬约束：',
  '1. 只能引用 facts 里已经出现的数字，价格原样照抄；严禁自己做加减乘除算出新的价格、百分比或盈亏比，严禁编造任何 facts 里没有的数字。',
  '2. 周线定方向、日线选位置、4H 等确认；MA90/MA120 回踩不等于买点，必须有止跌确认与失效价。',
  '3. 所有操作都是条件性计划：不承诺盈利、不预测必然、不说"一定""稳赚"。',
  '4. 技术偏多也不代表可以容忍强平先于止损；facts 里有 warnings 必须点出。',
  '5. facts 里标"待查""数据不足"的内容就说缺数据，不许脑补。',
  '6. MACD 三段背离只有 status 为 confirmed 才能说已确认，forming 只能说"可能出现背离，尚未确认"。',
  '7. 不要给杠杆倍数或下单指令，只讲结构、位置、条件和风险。',
  '输出只包含这一段叙述，不要标题、列表或 Markdown。',
].join('\n');

async function narrate(facts, { template, apiKey = process.env.ANTHROPIC_API_KEY, model = DEFAULT_MODEL, fetchImpl = globalThis.fetch, timeoutMs = 60000 } = {}) {
  const fallback = (note) => ({ text: template, source: 'template', note });
  if (!apiKey) return fallback('未设置 ANTHROPIC_API_KEY，未调用 LLM，使用模板叙述');
  if (typeof fetchImpl !== 'function') return fallback('当前运行环境没有 fetch，未调用 LLM，使用模板叙述');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reply;
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model, max_tokens: 1200, system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `facts:\n${JSON.stringify(facts)}` }],
      }),
    });
    if (!res || !res.ok) return fallback(`Claude API 请求失败（HTTP ${res ? res.status : '无响应'}），已回退模板`);
    const data = await res.json();
    reply = (Array.isArray(data.content) ? data.content : []).filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim();
  } catch (error) {
    return fallback(`Claude API 调用出错（${error.message}），已回退模板`);
  } finally {
    clearTimeout(timer);
  }
  if (!reply) return fallback('Claude 返回空叙述，已回退模板');

  const unverified = findUnverifiedNumbers(reply, facts);
  if (unverified.length) return fallback(`叙述含未验证数字（${[...new Set(unverified)].join('、')}），已回退模板`);
  return { text: reply, source: 'llm', note: null, model };
}

module.exports = { narrate, SYSTEM_PROMPT, DEFAULT_MODEL, ENDPOINT };
