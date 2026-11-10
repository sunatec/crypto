# 缠论历史原型（已归档）

这里是缠论指标重建前的两份 Pine 原型，已按 OpenSpec 变更 `rebuild-chanlun-tradingview-indicator` 的 9.1 原样迁入，内容未改，仅供对照。当前使用的正式入口是仓库根目录的 [chanlun_original.pine](../../chanlun_original.pine)。

| 文件 | 指标名 | 说明 | SHA-256（仓库中的 LF 版本） | 同内容 CRLF 版本 |
| --- | --- | --- | --- | --- |
| [chanlun_czsc.pine](chanlun_czsc.pine) | ChanLun | 重建前的原始实现，分型→笔→线段→中枢→走势类型 | `17ff2265b069eb06634afc8fcd38758232045c38c28b8af925d8d6bde12c0372` | `8be803bf2503a35e566850580982c5f5ff763c65c46df66533aedf61075fc115` |
| [chanlun_czsc_strict.pine](chanlun_czsc_strict.pine) | ChanLun-Strict | 按《教你炒股票108课》第62、65、67课调整的版本 | `d72bd1fe7317b1c7b055ab090bae647e240277b562700025ece17cdbe9e1c311` | `8135ee85271e74e1c86f4f0d3011e557a756354fef576782cd6ffe54235392ad` |

两份文件与新版没有共享内核，没有经过新版的逐前缀验收，不代表当前规则。

## 恢复

在仓库根目录执行（文件内容不变，恢复后核对上表中的 SHA-256）：

```bash
git mv archive/chanlun/chanlun_czsc.pine chanlun_czsc.pine
git mv archive/chanlun/chanlun_czsc_strict.pine chanlun_czsc_strict.pine
shasum -a 256 chanlun_czsc.pine chanlun_czsc_strict.pine
```

若在 Windows 上以 CRLF 检出，哈希应与表中最后一列一致。
