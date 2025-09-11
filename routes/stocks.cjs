const express= require('express')
const router= express.Router();
let watchlist= ['AC.TO']
router.get('/',(req,res)=>{
    res.json({
        success:true,
        count: watchlist.length,
        watchlist: watchlist
    })
})

router.post('/',(req,res)=>{
    const { symbol } = req.body;
    if (!symbol) {
        return res.status(400).json({   
            success: false,
            message: 'Stock symbol is required'
        });
    }
    if(watchlist.includes(symbol.toUpperCase())) {
        return res.status(409).json({
            success:false,
            message:'Stock already in watchlist'
        })
    }
    watchlist.push(symbol.toUpperCase())
    res.json({
        success: true,
        message: 'Stock addec successfully',
        watchlist: watchlist
    })
})

router.delete('/:symbol',(req,res)=> {
    const symbol= req.params.symbol.toUpperCase();
    const index= watchlist.indexOf(symbol)
    if(index===-1) {
        return res.status(400).json({
            success: false,
            message:'Stock not found in watchlist',
        })
    }
    watchlist.splice(index,1)
    res.json({
        success: true,
        message:'Stock removed',
        watchlist: watchlist
    })
})
module.exports= router;
