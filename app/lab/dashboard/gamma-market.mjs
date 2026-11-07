// Both URLs are official Gamma lookups. Alternate routing never substitutes a
// nearby round: callers still validate condition, tokens, fees and round times.
export const gammaMarketLookupVersion='gamma-exact-slug-keyset-fallback-v3';

export function publicRequestError(error) {
  let requestUrl=null;
  try {
    const target=new URL(error.requestUrl);target.username='';target.password='';target.hash='';
    if(target.origin==='https://gamma-api.polymarket.com'&&['/markets','/markets/keyset'].includes(target.pathname)) {
      for(const key of [...target.searchParams.keys()])if(!['slug','limit','closed'].includes(key))target.searchParams.delete(key);
    } else target.search='';
    requestUrl=target.href;
  } catch {/* A transport may fail before any URL is available. */}
  return {
    message:error.message,errorName:error.name,
    requestUrl,httpStatus:error.httpStatus??null,
    failureType:error.failureType??null,
    requestStartedAt:error.requestStartedAt??null,
    failedAt:error.failedAt??null,
    responseHeaders:error.responseHeaders??null,
    responseBodyExcerpt:error.responseBodyExcerpt??null,
    ...(error.lookupEvidence?{lookupEvidence:error.lookupEvidence}:{}),
    ...(error.lookupRequests?{lookupRequests:error.lookupRequests}:{}),
  };
}

export async function getGammaMarketBySlug(get,slug,onDiagnostic=()=>{}) {
  if(typeof slug!=='string'||!slug.length)throw Error('Missing market slug');
  const primaryUrl=`https://gamma-api.polymarket.com/markets/slug/${encodeURIComponent(slug)}`;
  let primary;
  try {
    const result=await get(primaryUrl);
    if(!result.data||Array.isArray(result.data)||result.data.slug!==slug)
      throw Error('Gamma exact-slug response identity mismatch');
    return result;
  } catch(error) {
    // The observed outage was HTTP 404 on this route, including old markets.
    // Authentication, malformed payloads and general network faults retain
    // their original failure; only one bounded 404 alternate is attempted.
    if(error.httpStatus!==404)throw error;
    primary=publicRequestError(error);
    onDiagnostic({kind:'gamma-market-primary-error',slug,lookupVersion:gammaMarketLookupVersion,
      primaryUrl,...primary});
  }
  // closed=any is required because this helper also verifies expired rounds;
  // keyset otherwise silently filters them out. No cursor pagination is used.
  const fallbackUrl=`https://gamma-api.polymarket.com/markets/keyset?slug=${encodeURIComponent(slug)}&closed=any&limit=2`;
  try {
    const result=await get(fallbackUrl);
    const markets=result.data?.markets;
    if(!result.data||Array.isArray(result.data)||!Array.isArray(markets)||markets.length!==1||
        markets[0]?.slug!==slug||result.data.next_cursor) {
      const reason=!result.data||Array.isArray(result.data)||!Array.isArray(markets)?'malformed-response':
        markets.length===0?'empty-result':markets.length!==1?'multiple-results':
        markets[0]?.slug!==slug?'wrong-slug':'unexpected-pagination';
      const failure=Error('Gamma fallback requires one exact matching market');
      Object.assign(failure,{failureType:'response-validation',requestUrl:fallbackUrl,
        requestStartedAt:result.requestStartedAt??null,failedAt:result.transportReceivedAt??null,
        lookupEvidence:{reason,expectedSlug:slug.slice(0,128),marketCount:Array.isArray(markets)?markets.length:null,
          returnedSlugs:Array.isArray(markets)?markets.slice(0,2).map(m=>typeof m?.slug==='string'?m.slug.slice(0,128):null):[],
          hasNextCursor:!!result.data?.next_cursor,receivedAt:result.transportReceivedAt??null}});
      throw failure;
    }
    onDiagnostic({kind:'gamma-market-fallback-used',slug,lookupVersion:gammaMarketLookupVersion,
      primaryUrl,fallbackUrl,primaryError:primary,receivedAt:result.transportReceivedAt??null});
    return {...result,data:markets[0],lookupVersion:gammaMarketLookupVersion,
      lookupSource:'exact-slug-keyset',primaryError:primary};
  } catch(error) {
    const fallback=publicRequestError(error);
    const failure=new Error(`Gamma 盘口主入口与备用入口均未取得 ${slug}：${primary.message}；${error.message}`);
    failure.failureType='metadata-lookup';
    failure.lookupRequests=[{url:primaryUrl,...primary},{url:fallbackUrl,...fallback}];
    onDiagnostic({kind:'gamma-market-lookup-failed',slug,lookupVersion:gammaMarketLookupVersion,
      primaryUrl,fallbackUrl,lookupRequests:failure.lookupRequests});
    throw failure;
  }
}
