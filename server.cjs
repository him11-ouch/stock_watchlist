require('dotenv').config();
const express= require('express')
const app= express()
const PORT= process.env.PORT ||3000;

app.use(express.json())
app.get('/',(req,res)=>{
    res.send('Stock Watchlist API Server - Ready for Trading');
})
app.get("/test-env",(req,res)=>{
    res.json({
        port:PORT,
        hasApiKey: !!process.env.ALPHA_VANTAGE_KEY,
        apiKeyConfigured: process.env.ALPHA_VANTAGE_KEY ? 'Yes' : 'No- Add to .env file',
        serverStatus: "Operational",
        timeStamp: new Date().toISOString()
    })
})
const watchlistRoutes = require('./routes/stocks.cjs');
const marketDataRoutes = require('./routes/movers.cjs');
const { startScheduler, checkAndNotifyOnce } = require('./services/notifications.cjs');
app.use('/watchlist',watchlistRoutes)
app.use('/prices', marketDataRoutes);
startScheduler();
app.get('/test-notification',async(req,res)=> {
    try {
        await checkAndNotifyOnce();
        res.json({ success: true, message: 'Test notification triggered' });
    } catch(error) {
        res.status(500).json({ success: false, error: error.message });
    }
})
app.listen(PORT,()=>{
    console.log(`Server is running on https://localhost:${PORT}`)
})