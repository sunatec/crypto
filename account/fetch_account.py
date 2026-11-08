#!/usr/bin/env python3
"""只读导出币安合约账户(U本位 + 币本位)的全部信息, 供 AI 做风险与仓位分析。

输出:
  account/latest.json                     结构化快照(全量字段 + 派生指标)
  account/latest.md                       可读报告(汇总/风险提示/全部持仓/挂单/收支)
  account/history/account_<时间戳>.json   历史快照
  account/history/account_<时间戳>.md

用法:
  python account/fetch_account.py                 # 默认实盘, 凭证取 trade_analysis/.env
  python account/fetch_account.py --env demo      # 模拟盘
  python account/fetch_account.py --env-file path/to/.env

只发只读 GET 请求, 不下单、不撤单、不改仓。
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

ACCOUNT_DIR = Path(__file__).resolve().parent
REPO_ROOT = ACCOUNT_DIR.parent
HISTORY_DIR = ACCOUNT_DIR / "history"

LIVE = {"usdm": "https://fapi.binance.com", "coinm": "https://dapi.binance.com"}
DEMO = {"usdm": "https://demo-fapi.binance.com", "coinm": "https://demo-dapi.binance.com"}


# --------------------------------------------------------------------------- #
# .env / HTTP
# --------------------------------------------------------------------------- #
def load_env(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def http_get_json(url: str, headers: dict[str, str] | None = None):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        raise SystemExit(f"HTTP {exc.code} on {url.split('?')[0]}: {body}") from exc


def api_get(base: str, path: str, params: dict | None, key: str, secret: str):
    payload = {k: v for k, v in (params or {}).items() if v is not None}
    payload["timestamp"] = int(time.time() * 1000)
    payload["recvWindow"] = 60000
    query = urllib.parse.urlencode(payload)
    payload["signature"] = hmac.new(secret.encode(), query.encode(), hashlib.sha256).hexdigest()
    return http_get_json(f"{base}{path}?{urllib.parse.urlencode(payload)}",
                         {"X-MBX-APIKEY": key})


def f(x, default=0.0) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


def rnd(x, n=8):
    return round(x, n) if isinstance(x, (int, float)) else x


def iso_now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


# --------------------------------------------------------------------------- #
# USD-M
# --------------------------------------------------------------------------- #
def fetch_usdm(base: str, key: str, secret: str, prices: dict) -> dict:
    mode = api_get(base, "/fapi/v1/positionSide/dual", None, key, secret)
    acct = api_get(base, "/fapi/v2/account", None, key, secret)
    try:
        pos_raw = api_get(base, "/fapi/v2/positionRisk", None, key, secret)
    except SystemExit:
        pos_raw = api_get(base, "/fapi/v3/positionRisk", None, key, secret)
    orders = api_get(base, "/fapi/v1/openOrders", None, key, secret)

    start = int(time.time() * 1000) - 24 * 3600 * 1000
    income = []
    cursor = start
    while True:
        page = api_get(base, "/fapi/v1/income",
                       {"startTime": cursor, "endTime": int(time.time() * 1000), "limit": 1000},
                       key, secret)
        if not page:
            break
        income.extend(page)
        if len(page) < 1000:
            break
        cursor = int(page[-1]["time"]) + 1

    order_count: dict[str, int] = {}
    for o in orders:
        order_count[o.get("symbol", "")] = order_count.get(o.get("symbol", ""), 0) + 1

    positions = []
    for p in pos_raw if isinstance(pos_raw, list) else [pos_raw]:
        amt = f(p.get("positionAmt"))
        if abs(amt) < 1e-12:
            continue
        side = p.get("positionSide", "BOTH")
        if side == "BOTH":
            side = "LONG" if amt > 0 else "SHORT"
        entry = f(p.get("entryPrice"))
        mark = f(p.get("markPrice"))
        upnl = f(p.get("unRealizedProfit"))
        notional = abs(f(p.get("notional")))
        lev = f(p.get("leverage"))
        if not lev:
            im = f(p.get("initialMargin"))
            lev = notional / im if im else 0.0
        iso = f(p.get("isolatedMargin"))
        margin = iso if (str(p.get("marginType", "")).lower() == "isolated" and iso > 0) else (
            notional / lev if lev else 0.0)
        liq = f(p.get("liquidationPrice"))
        liq_dist = abs(mark - liq) / mark * 100 if (liq > 0 and mark > 0) else None
        positions.append({
            "symbol": p.get("symbol"),
            "direction": side,
            "position_side": p.get("positionSide", "BOTH"),
            "quantity": rnd(amt),
            "entry_price": rnd(entry),
            "mark_price": rnd(mark),
            "notional_usdt": rnd(notional, 4),
            "initial_margin_usdt": rnd(margin, 4),
            "unrealized_pnl_usdt": rnd(upnl, 4),
            "roe_pct": rnd(upnl / margin * 100, 2) if margin else None,
            "leverage": rnd(lev, 2),
            "margin_type": p.get("marginType"),
            "liquidation_price": rnd(liq) if liq else None,
            "liquidation_distance_pct": rnd(liq_dist, 2) if liq_dist is not None else None,
            "open_orders": order_count.get(p.get("symbol", ""), 0),
            "raw": p,
        })

    acct_slim = {k: v for k, v in acct.items() if k not in ("positions",)}
    acct_slim["assets"] = [a for a in acct.get("assets", [])
                           if abs(f(a.get("walletBalance"))) > 1e-12]

    income_by = {}
    for i in income:
        k = (i.get("incomeType", "?"), i.get("asset", "?"))
        income_by[k] = income_by.get(k, 0.0) + f(i.get("income"))
    income_out = [{"income_type": k[0], "asset": k[1], "amount": rnd(v),
                   "amount_usdt": rnd(v)} for k, v in sorted(income_by.items())]

    long_notional = sum(p["notional_usdt"] for p in positions if p["direction"] == "LONG")
    short_notional = sum(p["notional_usdt"] for p in positions if p["direction"] == "SHORT")
    totals = {
        "wallet_balance_usdt": rnd(f(acct.get("totalWalletBalance")), 4),
        "unrealized_pnl_usdt": rnd(f(acct.get("totalUnrealizedProfit")), 4),
        "equity_usdt": rnd(f(acct.get("totalMarginBalance")), 4),
        "available_usdt": rnd(f(acct.get("availableBalance")), 4),
        "initial_margin_usdt": rnd(f(acct.get("totalInitialMargin")), 4),
        "maintenance_margin_usdt": rnd(f(acct.get("totalMaintMargin")), 4),
        "position_notional_usdt": rnd(long_notional + short_notional, 4),
        "long_notional_usdt": rnd(long_notional, 4),
        "short_notional_usdt": rnd(short_notional, 4),
        "position_count": len(positions),
    }
    totals["effective_leverage"] = rnd(
        totals["position_notional_usdt"] / totals["equity_usdt"], 2) if totals["equity_usdt"] else None
    totals["margin_ratio_pct"] = rnd(
        totals["maintenance_margin_usdt"] / totals["equity_usdt"] * 100, 2) if totals["equity_usdt"] else None
    totals["income_24h_total_usdt"] = rnd(sum(i["amount_usdt"] for i in income_out), 4)

    return {
        "position_mode": "hedge" if mode.get("dualSidePosition") else "one-way",
        "total_wallet_balance_usdt": rnd(f(acct.get("totalWalletBalance")), 4),
        "multi_assets_margin": acct.get("multiAssetsMargin"),
        "totals": totals,
        "account": acct_slim,
        "positions": positions,
        "open_orders": orders,
        "income_24h": income_out,
    }


# --------------------------------------------------------------------------- #
# COIN-M
# --------------------------------------------------------------------------- #
def fetch_prices(base: str, assets: set[str]) -> dict[str, float]:
    prices = {}
    for asset in sorted(assets):
        for sym in (f"{asset}USD_PERP", f"{asset}USD"):
            try:
                data = http_get_json(f"{base}/dapi/v1/ticker/price?symbol={sym}")
                if isinstance(data, list):
                    data = data[0]
                prices[asset] = f(data.get("price"))
                break
            except SystemExit:
                continue
    return prices


def fetch_coinm(base: str, key: str, secret: str) -> dict:
    mode = api_get(base, "/dapi/v1/positionSide/dual", None, key, secret)
    acct = api_get(base, "/dapi/v1/account", None, key, secret)
    pos_risk = api_get(base, "/dapi/v1/positionRisk", None, key, secret)
    orders = api_get(base, "/dapi/v1/openOrders", None, key, secret)
    income = api_get(base, "/dapi/v1/income",
                     {"startTime": int(time.time() * 1000) - 24 * 3600 * 1000,
                      "endTime": int(time.time() * 1000), "limit": 1000},
                     key, secret)

    assets = [a for a in acct.get("assets", [])
              if abs(f(a.get("walletBalance"))) > 1e-12
              or abs(f(a.get("unrealizedProfit"))) > 1e-12]
    prices = fetch_prices(base, {a.get("asset", "") for a in assets})

    assets_out = []
    for a in assets:
        asset = a.get("asset", "")
        px = prices.get(asset)
        assets_out.append({
            "asset": asset,
            "price_usd": rnd(px, 6) if px else None,
            "wallet_balance": rnd(f(a.get("walletBalance"))),
            "unrealized_pnl": rnd(f(a.get("unrealizedProfit"))),
            "margin_balance": rnd(f(a.get("marginBalance"))),
            "available_balance": rnd(f(a.get("availableBalance"))),
            "initial_margin": rnd(f(a.get("initialMargin"))),
            "maintenance_margin": rnd(f(a.get("maintMargin"))),
            "wallet_balance_usdt": rnd(f(a.get("walletBalance")) * px, 4) if px else None,
            "unrealized_pnl_usdt": rnd(f(a.get("unrealizedProfit")) * px, 4) if px else None,
            "margin_balance_usdt": rnd(f(a.get("marginBalance")) * px, 4) if px else None,
            "available_balance_usdt": rnd(f(a.get("availableBalance")) * px, 4) if px else None,
            "initial_margin_usdt": rnd(f(a.get("initialMargin")) * px, 4) if px else None,
            "maintenance_margin_usdt": rnd(f(a.get("maintMargin")) * px, 4) if px else None,
            "raw": a,
        })

    acct_pos = {}
    for p in acct.get("positions", []):
        acct_pos[(p.get("symbol"), p.get("positionSide", "BOTH"))] = p

    order_count: dict[str, int] = {}
    for o in orders:
        order_count[o.get("symbol", "")] = order_count.get(o.get("symbol", ""), 0) + 1

    positions = []
    for p in pos_risk if isinstance(pos_risk, list) else [pos_risk]:
        amt = f(p.get("positionAmt"))
        if abs(amt) < 1e-12:
            continue
        sym = p.get("symbol", "")
        asset = sym.split("USD")[0]
        mark = f(p.get("markPrice"))
        px = prices.get(asset) or mark
        if asset not in prices and px:
            prices[asset] = px
        side = p.get("positionSide", "BOTH")
        if side == "BOTH":
            side = "LONG" if amt > 0 else "SHORT"
        ap = acct_pos.get((sym, p.get("positionSide", "BOTH")), {})
        upnl = f(p.get("unRealizedProfit"))
        notional_coin = abs(f(ap.get("notionalValue"))) or abs(f(p.get("notionalValue")))
        margin_coin = f(ap.get("initialMargin"))
        if not margin_coin:
            lev = f(p.get("leverage"))
            margin_coin = notional_coin / lev if lev else 0.0
        lev = f(p.get("leverage"))
        entry = f(p.get("entryPrice"))
        liq = f(p.get("liquidationPrice"))
        liq_dist = abs(mark - liq) / mark * 100 if (liq > 0 and mark > 0) else None
        positions.append({
            "symbol": sym,
            "direction": side,
            "position_side": p.get("positionSide", "BOTH"),
            "contracts": rnd(amt),
            "entry_price": rnd(entry),
            "mark_price": rnd(mark),
            "notional_coin": rnd(notional_coin),
            "notional_usdt": rnd(notional_coin * mark, 4),
            "initial_margin_coin": rnd(margin_coin),
            "initial_margin_usdt": rnd(margin_coin * mark, 4),
            "unrealized_pnl_coin": rnd(upnl),
            "unrealized_pnl_usdt": rnd(upnl * px, 4) if px else None,
            "roe_pct": rnd(upnl / margin_coin * 100, 2) if margin_coin else None,
            "leverage": rnd(lev, 2),
            "margin_type": p.get("marginType") or ("isolated" if ap.get("isolated") else "cross"),
            "liquidation_price": rnd(liq) if liq else None,
            "liquidation_distance_pct": rnd(liq_dist, 2) if liq_dist is not None else None,
            "open_orders": order_count.get(sym, 0),
            "raw": {"position_risk": p, "account_position": ap},
        })

    income_by = {}
    for i in income:
        k = (i.get("incomeType", "?"), i.get("asset", "?"))
        income_by[k] = income_by.get(k, 0.0) + f(i.get("income"))
    income_out = []
    for k, v in sorted(income_by.items()):
        px = prices.get(k[1])
        income_out.append({"income_type": k[0], "asset": k[1], "amount": rnd(v),
                           "amount_usdt": rnd(v * px, 4) if px else None})

    def sum_usdt(field: str) -> float:
        return sum(a[field] or 0.0 for a in assets_out)

    long_notional = sum(p["notional_usdt"] for p in positions if p["direction"] == "LONG")
    short_notional = sum(p["notional_usdt"] for p in positions if p["direction"] == "SHORT")
    totals = {
        "wallet_balance_usdt": rnd(sum_usdt("wallet_balance_usdt"), 4),
        "unrealized_pnl_usdt": rnd(sum_usdt("unrealized_pnl_usdt"), 4),
        "equity_usdt": rnd(sum_usdt("margin_balance_usdt"), 4),
        "available_usdt": rnd(sum_usdt("available_balance_usdt"), 4),
        "initial_margin_usdt": rnd(sum_usdt("initial_margin_usdt"), 4),
        "maintenance_margin_usdt": rnd(sum_usdt("maintenance_margin_usdt"), 4),
        "position_notional_usdt": rnd(long_notional + short_notional, 4),
        "long_notional_usdt": rnd(long_notional, 4),
        "short_notional_usdt": rnd(short_notional, 4),
        "position_count": len(positions),
    }
    totals["effective_leverage"] = rnd(
        totals["position_notional_usdt"] / totals["equity_usdt"], 2) if totals["equity_usdt"] else None
    totals["margin_ratio_pct"] = rnd(
        totals["maintenance_margin_usdt"] / totals["equity_usdt"] * 100, 2) if totals["equity_usdt"] else None
    totals["income_24h_total_usdt"] = rnd(
        sum(i["amount_usdt"] for i in income_out if i.get("amount_usdt") is not None), 4)

    return {
        "position_mode": "hedge" if mode.get("dualSidePosition") else "one-way",
        "totals": totals,
        "assets": assets_out,
        "positions": positions,
        "open_orders": orders,
        "income_24h": income_out,
    }


# --------------------------------------------------------------------------- #
# 汇总 / 风险提示
# --------------------------------------------------------------------------- #
def build_summary(usdm: dict | None, coinm: dict | None) -> dict:
    def g(d, *keys):
        cur = d
        for k in keys:
            cur = (cur or {}).get(k) if isinstance(cur, dict) else None
        return cur or 0.0

    equity = g(usdm, "totals", "equity_usdt") + g(coinm, "totals", "equity_usdt")
    upnl = g(usdm, "totals", "unrealized_pnl_usdt") + g(coinm, "totals", "unrealized_pnl_usdt")
    notional = g(usdm, "totals", "position_notional_usdt") + g(coinm, "totals", "position_notional_usdt")
    available = g(usdm, "totals", "available_usdt") + g(coinm, "totals", "available_usdt")
    maint = g(usdm, "totals", "maintenance_margin_usdt") + g(coinm, "totals", "maintenance_margin_usdt")
    long_n = g(usdm, "totals", "long_notional_usdt") + g(coinm, "totals", "long_notional_usdt")
    short_n = g(usdm, "totals", "short_notional_usdt") + g(coinm, "totals", "short_notional_usdt")
    summary = {
        "equity_usdt": rnd(equity, 4),
        "unrealized_pnl_usdt": rnd(upnl, 4),
        "position_notional_usdt": rnd(notional, 4),
        "long_notional_usdt": rnd(long_n, 4),
        "short_notional_usdt": rnd(short_n, 4),
        "net_notional_usdt": rnd(long_n - short_n, 4),
        "available_usdt": rnd(available, 4),
        "maintenance_margin_usdt": rnd(maint, 4),
        "position_count": int(g(usdm, "totals", "position_count") + g(coinm, "totals", "position_count")),
    }
    summary["effective_leverage"] = rnd(notional / equity, 2) if equity else None
    summary["margin_ratio_pct"] = rnd(maint / equity * 100, 2) if equity else None
    summary["available_pct_of_equity"] = rnd(available / equity * 100, 2) if equity else None

    all_positions = [("USD-M", p) for p in (usdm or {}).get("positions", [])] + \
                    [("COIN-M", p) for p in (coinm or {}).get("positions", [])]
    for _, p in all_positions:
        p["notional_share_pct"] = rnd((p.get("notional_usdt") or 0) / notional * 100, 2) if notional else None
        p["upnl_pct_of_equity"] = rnd((p.get("unrealized_pnl_usdt") or 0) / equity * 100, 2) if equity else None
    summary["long_position_count"] = sum(1 for _, p in all_positions if p.get("direction") == "LONG")
    summary["short_position_count"] = sum(1 for _, p in all_positions if p.get("direction") == "SHORT")

    flags = []
    if summary["margin_ratio_pct"] is not None and summary["margin_ratio_pct"] >= 50:
        flags.append(f"维持保证金/权益 = {summary['margin_ratio_pct']:.1f}%，强平缓冲很低")
    elif summary["margin_ratio_pct"] is not None and summary["margin_ratio_pct"] >= 30:
        flags.append(f"维持保证金/权益 = {summary['margin_ratio_pct']:.1f}%，缓冲偏低")
    if summary["effective_leverage"] is not None and summary["effective_leverage"] >= 5:
        flags.append(f"总名义价值/权益 = {summary['effective_leverage']:.1f}x，账户杠杆偏高")
    if summary["available_pct_of_equity"] is not None and summary["available_pct_of_equity"] < 5:
        flags.append(f"可用余额仅占权益 {summary['available_pct_of_equity']:.1f}%")

    liq_risk = [(kind, p) for kind, p in all_positions
                if (p.get("liquidation_distance_pct") is not None
                    and p["liquidation_distance_pct"] < 15)]
    if liq_risk:
        liq_risk.sort(key=lambda x: x[1]["liquidation_distance_pct"])
        flags.append("距强平 <15%：" + "、".join(
            f"{kind} {p['symbol']} {p['liquidation_distance_pct']:.1f}%" for kind, p in liq_risk))

    losing = [(kind, p) for kind, p in all_positions
              if p.get("roe_pct") is not None and p["roe_pct"] <= -50]
    if losing:
        losing.sort(key=lambda x: x[1]["roe_pct"])
        flags.append("亏损最重仓位(ROE)：" + "、".join(
            f"{kind} {p['symbol']} {p['roe_pct']:.0f}%" for kind, p in losing[:5]))

    if not (usdm or {}).get("open_orders") and not (coinm or {}).get("open_orders"):
        flags.append("两个账户都没有任何挂单（无止损/止盈委托）")
    if long_n > 0 and short_n == 0 and all_positions:
        flags.append(f"全部为多头敞口（名义 {long_n:,.0f} USDT，无空头对冲）")
    if all_positions and notional:
        top = max(all_positions, key=lambda x: x[1].get("notional_usdt") or 0)
        share = (top[1].get("notional_usdt") or 0) / notional * 100
        if share >= 30:
            flags.append(f"仓位集中：{top[1]['symbol']} 占总名义 {share:.1f}%")
    summary["risk_flags"] = flags
    return summary


# --------------------------------------------------------------------------- #
# Markdown
# --------------------------------------------------------------------------- #
def md_table(headers, rows) -> list[str]:
    out = ["| " + " | ".join(headers) + " |",
           "|" + "|".join(["---"] * len(headers)) + "|"]
    for row in rows:
        out.append("| " + " | ".join(str(c) for c in row) + " |")
    return out


def fmt_num(x, n=2, plus=False):
    if x is None:
        return "-"
    try:
        return f"{float(x):+,.{n}f}" if plus else f"{float(x):,.{n}f}"
    except (TypeError, ValueError):
        return str(x)


def render_markdown(snapshot: dict) -> str:
    usdm = snapshot.get("usdm")
    coinm = snapshot.get("coinm")
    s = snapshot["summary"]
    lines = [
        "# 币安合约账户快照",
        "",
        f"- 生成时间：{snapshot['generated_at']}",
        f"- 环境：{snapshot['env']}（只读导出，未下单/撤单/改仓）",
        f"- 数据：USD-M(U本位) + COIN-M(币本位) 全部持仓、账户余额、挂单、近24h收支",
        "",
        "## 汇总",
        "",
    ]
    lines += md_table(
        ["指标", "数值"],
        [
            ["总权益(保证金余额)", f"{fmt_num(s['equity_usdt'])} USDT"],
            ["未实现盈亏", f"{fmt_num(s['unrealized_pnl_usdt'], plus=True)} USDT"],
            ["总名义价值", f"{fmt_num(s['position_notional_usdt'])} USDT"],
            ["多头名义 / 空头名义", f"{fmt_num(s['long_notional_usdt'])} / {fmt_num(s['short_notional_usdt'])} USDT"],
            ["账户有效杠杆", f"{fmt_num(s['effective_leverage'])}x"],
            ["维持保证金/权益", f"{fmt_num(s['margin_ratio_pct'])}%"],
            ["可用余额", f"{fmt_num(s['available_usdt'])} USDT（占权益 {fmt_num(s['available_pct_of_equity'])}%）"],
            ["持仓数量", f"{s['position_count']}（多 {s.get('long_position_count', 0)} / 空 {s.get('short_position_count', 0)}）"],
        ],
    )
    lines += ["", "## 风险提示", ""]
    if s["risk_flags"]:
        lines += [f"- {x}" for x in s["risk_flags"]]
    else:
        lines.append("- 无自动触发的风险标记（仍需人工复核）")

    for title, data in (("USD-M（U本位）", usdm), ("COIN-M（币本位）", coinm)):
        if not data:
            lines += ["", f"## {title}", "", "- 获取失败（见 snapshot.errors）"]
            continue
        t = data["totals"]
        lines += ["", f"## {title}", "",
                  f"- 持仓模式：{data['position_mode']}",
                  f"- 权益：{fmt_num(t['equity_usdt'])} USDT；未实现盈亏：{fmt_num(t['unrealized_pnl_usdt'], plus=True)} USDT；"
                  f"可用：{fmt_num(t['available_usdt'])} USDT",
                  f"- 名义价值：{fmt_num(t['position_notional_usdt'])} USDT（多 {fmt_num(t['long_notional_usdt'])} / "
                  f"空 {fmt_num(t['short_notional_usdt'])}）；有效杠杆：{fmt_num(t['effective_leverage'])}x",
                  f"- 维持保证金：{fmt_num(t['maintenance_margin_usdt'])} USDT；维持保证金/权益：{fmt_num(t['margin_ratio_pct'])}%",
                  f"- 近 24h 收支合计：{fmt_num(t.get('income_24h_total_usdt'), plus=True)} USDT",
                  "", f"### 持仓（{len(data['positions'])}）", ""]
        if not data["positions"]:
            lines.append("- 无持仓")
        elif title.startswith("USD-M"):
            rows = []
            for p in sorted(data["positions"], key=lambda x: -(x.get("notional_usdt") or 0)):
                rows.append([
                    p["symbol"], p["direction"], fmt_num(p["quantity"], 4),
                    fmt_num(p["entry_price"], 6), fmt_num(p["mark_price"], 6),
                    fmt_num(p["notional_usdt"]), fmt_num(p.get("notional_share_pct")),
                    fmt_num(p["initial_margin_usdt"]),
                    fmt_num(p["unrealized_pnl_usdt"], plus=True),
                    f"{fmt_num(p['roe_pct'])}%", f"{fmt_num(p['leverage'], 0)}x",
                    p.get("margin_type") or "-",
                    fmt_num(p.get("liquidation_price"), 6) if p.get("liquidation_price") else "-",
                    f"{fmt_num(p['liquidation_distance_pct'])}%" if p.get("liquidation_distance_pct") is not None else "-",
                    p.get("open_orders", 0),
                ])
            lines += md_table(
                ["币种", "方向", "数量", "开仓价", "标记价", "名义(USDT)", "名义占比", "起始保证金",
                 "未实现(USDT)", "ROE", "杠杆", "模式", "强平价", "距强平", "挂单数"], rows)
        else:
            rows = []
            for p in sorted(data["positions"], key=lambda x: -(x.get("notional_usdt") or 0)):
                rows.append([
                    p["symbol"], p["direction"], fmt_num(p["contracts"], 0),
                    fmt_num(p["entry_price"], 6), fmt_num(p["mark_price"], 6),
                    fmt_num(p["notional_coin"], 6), fmt_num(p["notional_usdt"]),
                    fmt_num(p.get("notional_share_pct")), fmt_num(p["initial_margin_usdt"]),
                    fmt_num(p["unrealized_pnl_coin"], 8),
                    fmt_num(p["unrealized_pnl_usdt"], plus=True),
                    f"{fmt_num(p['roe_pct'])}%", f"{fmt_num(p['leverage'], 0)}x",
                    p.get("margin_type") or "-",
                    fmt_num(p.get("liquidation_price"), 6) if p.get("liquidation_price") else "-",
                    f"{fmt_num(p['liquidation_distance_pct'])}%" if p.get("liquidation_distance_pct") is not None else "-",
                    p.get("open_orders", 0),
                ])
            lines += md_table(
                ["合约", "方向", "张数", "开仓价", "标记价", "名义(币)", "名义(USDT)", "名义占比",
                 "起始保证金(USDT)", "未实现(币)", "未实现(USDT)", "ROE", "杠杆", "模式",
                 "强平价", "距强平", "挂单数"], rows)

        lines += ["", f"### 资产（{len(data.get('assets', data.get('account', {}).get('assets', [])))}）", ""]
        if title.startswith("USD-M"):
            assets = data["account"].get("assets", [])
            rows = [[a.get("asset"), fmt_num(a.get("walletBalance"), 6),
                     fmt_num(a.get("unrealizedProfit"), 6), fmt_num(a.get("marginBalance"), 6),
                     fmt_num(a.get("availableBalance"), 6)] for a in assets]
            lines += md_table(["资产", "钱包余额", "未实现盈亏", "保证金余额", "可用余额"], rows)
        else:
            rows = [[a["asset"], fmt_num(a.get("price_usd"), 2), fmt_num(a["wallet_balance"], 6),
                     fmt_num(a["unrealized_pnl"], 6), fmt_num(a["margin_balance"], 6),
                     fmt_num(a["available_balance"], 6),
                     fmt_num(a.get("margin_balance_usdt"))] for a in data["assets"]]
            lines += md_table(["资产", "价格(USD)", "钱包余额", "未实现盈亏", "保证金余额", "可用余额", "≈USDT"], rows)

        lines += ["", f"### 挂单（{len(data['open_orders'])}）", ""]
        if not data["open_orders"]:
            lines.append("- 无挂单")
        else:
            rows = [[o.get("symbol"), o.get("side"), o.get("type"), fmt_num(o.get("price"), 6),
                     fmt_num(o.get("origQty"), 4), fmt_num(o.get("executedQty"), 4),
                     o.get("reduceOnly"), o.get("positionSide"),
                     datetime.fromtimestamp(f(o.get("time")) / 1000).strftime("%Y-%m-%d %H:%M:%S")]
                    for o in data["open_orders"]]
            lines += md_table(["合约", "方向", "类型", "价格", "数量", "已成交", "reduceOnly", "持仓方向", "时间"], rows)

        lines += ["", "### 近 24h 收支", ""]
        if not data["income_24h"]:
            lines.append("- 无")
        else:
            rows = [[i["income_type"], i["asset"], fmt_num(i["amount"], 8),
                     fmt_num(i.get("amount_usdt"), 2) if i.get("amount_usdt") is not None else "-"]
                    for i in data["income_24h"]]
            lines += md_table(["类型", "资产", "数量", "≈USDT"], rows)

    if snapshot.get("errors"):
        lines += ["", "## 错误", ""] + [f"- {e}" for e in snapshot["errors"]]
    lines += ["", "## 指标说明", ""]
    lines += [f"- {k}：{v}" for k, v in snapshot.get("definitions", {}).items()]
    lines += ["", "---", "",
              "说明：本文件由 `account/fetch_account.py` 只读生成；JSON 版本包含 API 原始字段，"
              "适合直接提供给其他 AI 做风险与仓位分析。", ""]
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser(description="只读导出币安合约账户快照")
    ap.add_argument("--env", choices=["live", "demo"], default="live")
    ap.add_argument("--env-file", default=str(REPO_ROOT / "trade_analysis" / ".env"),
                    help="凭证文件，默认 trade_analysis/.env")
    args = ap.parse_args()

    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    load_env(Path(args.env_file))
    key = os.environ.get("BINANCE_API_KEY", "")
    secret = os.environ.get("BINANCE_API_SECRET", "")
    if not key or not secret or key.lower().startswith("your"):
        raise SystemExit(f"未找到有效凭证，请检查 {args.env_file} 中的 BINANCE_API_KEY / BINANCE_API_SECRET")

    bases = LIVE if args.env == "live" else DEMO
    errors = []
    usdm = coinm = None
    try:
        usdm = fetch_usdm(bases["usdm"], key, secret, {})
    except SystemExit as exc:
        errors.append(f"USD-M: {exc}")
    try:
        coinm = fetch_coinm(bases["coinm"], key, secret)
    except SystemExit as exc:
        errors.append(f"COIN-M: {exc}")

    if usdm is None and coinm is None:
        raise SystemExit("两个账户都拉取失败：\n" + "\n".join(errors))

    snapshot = {
        "generated_at": iso_now(),
        "env": args.env,
        "source": "Binance USD-M (fapi) + COIN-M (dapi), read-only GET",
        "errors": errors,
        "definitions": {
            "equity_usdt": "总权益 = USD-M 的 totalMarginBalance + COIN-M 各资产 marginBalance 按标记价折算成 USDT",
            "effective_leverage": "账户有效杠杆 = 总名义价值 / 总权益",
            "margin_ratio_pct": "维持保证金 / 权益；越高越接近强平",
            "roe_pct": "仓位未实现盈亏 / 该仓位起始保证金；全仓模式下单仓亏损可超过 -100%",
            "liquidation_distance_pct": "|标记价 - 强平价| / 标记价；越小越危险，空值表示交易所未返回或为 0",
            "notional_usdt": "USD-M 使用 API notional；COIN-M 使用 notionalValue(币) × 标记价",
            "open_orders": "该合约当前挂单数（含止盈/止损等所有委托，不区分类型）",
        },
        "summary": build_summary(usdm, coinm),
        "usdm": usdm,
        "coinm": coinm,
    }

    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    json_text = json.dumps(snapshot, indent=2, ensure_ascii=False)
    md_text = render_markdown(snapshot)
    outputs = [
        (ACCOUNT_DIR / "latest.json", json_text),
        (ACCOUNT_DIR / "latest.md", md_text),
        (HISTORY_DIR / f"account_{stamp}.json", json_text),
        (HISTORY_DIR / f"account_{stamp}.md", md_text),
    ]
    for path, text in outputs:
        path.write_text(text, encoding="utf-8")

    s = snapshot["summary"]
    print(f"已生成账户快照: {snapshot['generated_at']} ({args.env})")
    print(f"  权益 {s['equity_usdt']:,.2f} USDT | 未实现 {s['unrealized_pnl_usdt']:+,.2f} | "
          f"名义 {s['position_notional_usdt']:,.2f} | 杠杆 {s['effective_leverage']}x | "
          f"持仓 {s['position_count']}")
    for p in [ACCOUNT_DIR / "latest.json", ACCOUNT_DIR / "latest.md",
              HISTORY_DIR / f"account_{stamp}.json", HISTORY_DIR / f"account_{stamp}.md"]:
        print(f"  - {p}")
    if errors:
        print("部分失败:")
        for e in errors:
            print(f"  ! {e}")


if __name__ == "__main__":
    main()
