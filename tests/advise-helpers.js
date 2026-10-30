'use strict';

// 离线测试共用：用日线 fixture 拼出一份 market，4H 用日线拆 6 根（足够跑通全链路，不求真实）。
const { synthesizeWeekly } = require('../advisor/data');

const DAILY = require('./fixtures/btcusdt-1d-20261025.json');

function makeMarket() {
  const h4 = [];
  for (const c of DAILY.slice(-80)) {
    for (let k = 0; k < 6; k += 1) h4.push({ ...c, timestamp: c.timestamp + k * 14400, close: c.close + (k - 3) * 50, volume: 1 });
  }
  return { symbol: 'BTCUSDT', fetchedAt: '2026-10-26T00:00:00.000Z', daily: DAILY, weekly: synthesizeWeekly(DAILY), h4 };
}

const LAST_CLOSE = DAILY[DAILY.length - 1].close;
const FUTURES = { markPrice: LAST_CLOSE + 10.5, indexPrice: LAST_CLOSE, fundingRate: 0.0001, nextFundingTime: null };

module.exports = { makeMarket, DAILY, LAST_CLOSE, FUTURES };
