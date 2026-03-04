import * as ccxt from 'ccxt';

async function testBinance(): Promise<void> {
    // 1. 初始化 Binance 实例
    const exchange = new ccxt.binance({
        apiKey: '你的Testnet_API_KEY', // 替换为测试网获取的 Key
        secret: '你的Testnet_SECRET',  // 替换为测试网获取的 Secret
        enableRateLimit: true,         // 开启内置的速率限制，防止被封 IP
    });

    // 2. 将环境切换到测试网 (Sandbox)
    exchange.setSandboxMode(true);

    try {
        // 3. 连通性测试：获取 BTC/USDT 最新行情
        console.log('正在获取 BTC/USDT 行情...');
        const ticker: ccxt.Ticker = await exchange.fetchTicker('BTC/USDT');
        
        // TS 的严格类型检查：确保 ticker.last 不是 undefined
        if (ticker.last === undefined) {
            throw new Error('未能获取到最新价格 (ticker.last is undefined)');
        }
        console.log(`获取成功！BTC 当前价格: $${ticker.last}`);

        // 4. 准备订单参数并声明类型
        const symbol: string = 'BTC/USDT';
        const type: ccxt.OrderType = 'limit';
        const side: ccxt.OrderSide = 'buy';
        const amount: number = 0.1;
        
        // 计算价格并处理精度：向下浮动 5%，保留两位小数，并转回 number 类型
        const price: number = Number((ticker.last * 0.95).toFixed(2));

        console.log(`\n准备下达限价买单: 价格 $${price}, 数量 ${amount} BTC`);
        
        // 5. 执行下单
        const order: ccxt.Order = await exchange.createOrder(symbol, type, side, amount, price);
        
        console.log('✅ 测试订单已成功下达！订单详情:');
        console.log(`订单 ID: ${order.id}, 状态: ${order.status}`);

    } catch (error: unknown) {
        // TS 中推荐的 error 捕获类型处理方式
        if (error instanceof Error) {
            console.error('❌ API 请求失败:', error.message);
        } else {
            console.error('❌ 发生未知错误:', error);
        }
    }
}

// 执行主函数
testBinance();