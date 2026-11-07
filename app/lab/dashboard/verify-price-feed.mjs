// Read-only live feed check. Does not open, reset or operate the dashboard account.
import { PublicFeed } from './public-feed.mjs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
let frames=0, latestPrice=null;
const times=new Set(), sources={};
const feed=new PublicFeed({onFrame:()=>frames++,onPrice:price=>{latestPrice=price;times.add(price.timestamp);},
  onStatus:status=>{sources[status.name]=status.state;}});
feed.start();
await new Promise(resolve=>setTimeout(resolve,20_000));
feed.stop();
const result={checkedAt:new Date().toISOString(),readOnly:true,frames,uniquePriceSamples:times.size,
  latestPriceTime:latestPrice?.timestamp??null,priceFresh:Boolean(latestPrice&&Date.now()-latestPrice.timestamp<5000),sources};
console.log(JSON.stringify(result,null,2));
writeFileSync(fileURLToPath(new URL('./runtime/price-feed-verification.json',import.meta.url)),JSON.stringify(result,null,2));
if(!result.priceFresh||frames<2||times.size<2) process.exitCode=1;
