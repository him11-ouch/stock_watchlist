const express= require('express')
const router= express.Router()
const axios= require('axios')

router.get('/test-ac',async(req,res)=>{
    try {
        const symbol= 'AC.TO';
        const apiKey= process.env.ALPHA_VANTAGE_KEY

        if(!apiKey) {
            return res.status(500).json({
                success:false,
                message:'Alpha Vantage API key not configured',
                action: 'Add ALPHA_VANTAGE_KEY to your .env file'
            })
        }
        console.log(`[${new Date().toISOString()}] Fetching market data for ${symbol}`)
        const response= await axios.get('https://www.alphavantage.co/query',{
            params: {
                function:'TIME_SERIES_DAILY',
                symbol: symbol,
                apikey: apiKey
            },
            timeout:2000
        })
        const timeSeriesData= response.data['Time Series (Daily)']
        if(!timeSeriesData) {
            if(response.data['Error Message']) {
                return res.status(400).json({
                    success: false,
                    message:'Invalid symbol or API error',
                    error:response.data['Error Message'],
                    symbol: symbol
                })
            }
            if(response.data['Note']) {
                return res.status(429).json({
                    success:false,
                    message: 'API rate limit exceeded',
                    note: response.data['Note'],
                    retryAfter: '60 seconds'
                })
            }
            return res.status(502).json({
                success: false,
                message: 'No market data returned from Alpha Vantage',
                rawResponse: response.data,
                troubleshooting: 'Check if market are open and symbol is valid'
            })
        }
        const latestDate= Object.keys(timeSeriesData)[0]
        const latestData= timeSeriesData[latestDate]

        const marketData= {
            open:parseFloat(latestData['1. open']),
            high: parseFloat(latestData['2. high']),
            low: parseFloat(latestData['3. low']),
            close: parseFloat(latestData['4. close']),
            volume: parseFloat(latestData['5. volume'])
        }
        if(marketData.high < Math.max(marketData.open, marketData.close) ||
            marketData.low > Math.min(marketData.open, marketData.close)) {
                console.warn(`[${symbol}] Suspicious OHLC data detected on ${latestDate}  `)
        }
        const dailyChange= marketData.close - marketData.open;
        const dailyChangePercent= ((dailyChange/marketData.open)*100)
        const dailyRange= marketData.high - marketData.low
        const volatilityPercent= ((dailyRange/marketData.close)*100)

        res.json({
            success: true,
            symbol: symbol,
            date: latestDate,
            price: marketData.close ,
            volume: marketData.volume,
            open: marketData.open,
            high: marketData.high,
            low: marketData.low,

            analytics: {
                dailyChange: parseFloat(dailyChange.toFixed(2)),
                dailyChangePercent: parseFloat(dailyChangePercent.toFixed(2)),
                dailyRange: parseFloat(dailyRange.toFixed(2)),
                volatilityPercent: parseFloat(volatilityPercent.toFixed(2)),
                volumeCategory: marketData.volume> 1000000 ? 'High' :
                                marketData.volume > 500000 ? 'Normal' : 'Low'
            },
            signals: {
                trend: dailyChange > 0 ? 'Bullish' : 'Bearish',
                gapStatus: Math.abs(dailyChangePercent) > 2 ? 'Significant Gap' : 'Normal Open',
                liquidityStatus: marketData.volume > 500000 ? 'Good': 'Caution'
            },
            timestamp: new Date().toISOString()
        })
    } catch(error) {
        console.error('Alpha Vantage API Error:', error.message)
        
        if(error.code==='ENOTFOUND'|| error.code === 'ECONNREFUSED') {
            return res.status(503).json({
                success:false,
                message: 'Unable to connect to Alpha Vantage',
                error: 'Network connectivity issue',
                action: 'Check your internet connection and try again'
            })
        }
        if(error.code==='ECONNABORTED') {
            return res.status(408).json({
                success: false,
                message: 'API request timeout',
                error: 'Alpha Vantage response took too long',
                action: 'Try again, market data provider may be slow'
            })
        }
        res.status(500).json({
            success: false,
            message: 'Failed to fetch market data',
            error: error.message,
            timestamp: new Data().toISOString()
        })
    }
    console.log(`[${symbol}] Market data fetched: $${marketData.close} (${dailyChangePercent.toFixed(2)}%)`)
})
module.exports= router
