// Calendar membership only: this module does not set trading thresholds, fetch
// schedules, infer recurring event dates or certify an event/return association.
export const calendarContextVersion='ray-calendar-context-v1';
export const calendarWindowPolicy=Object.freeze({preMinutes:30,postMinutes:60,
 basis:'local research window, not an official exchange or economic rule'});
const zone='America/New_York';
const formatter=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',
 hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',weekday:'short'});
const dow={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
const macro=new Set(['cpi','employment','ppi','fomc','fomc_press','fomc_minutes','gdp','pce']);
const equity=new Set(['equity_monthly_expiry','equity_quarterly_expiry','equity_expiry']);
const official=new Set(['official-current-schedule','official-confirmed-past-event','official-date-only']);
// Cache only a derived date for an identical event object and unchanged at.
// All validity, status and knowledge checks still run on every invocation;
// changing the input object has exactly the same result as a fresh object.
const eventDates=new WeakMap();
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
function dateValid(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const t=Date.parse(value+'T12:00:00Z');return Number.isFinite(t)&&new Date(t).toISOString().slice(0,10)===value;
}
function instant(value){
 if(Number.isFinite(value)&&Number.isSafeInteger(value)&&Math.abs(value)<=8640000000000000)return value;
 if(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)){
  const t=Date.parse(value);if(Number.isFinite(t))return t;
 }
 return null;
}
function localParts(now){
 const p=Object.fromEntries(formatter.formatToParts(now).map(p=>[p.type,p.value]));
 return {date:`${p.year}-${p.month}-${p.day}`,dow:dow[p.weekday],
  minute:Number(p.hour)*60+Number(p.minute),time:`${p.hour}:${p.minute}:${p.second}`};
}
function rangeValid(c){return record(c)&&dateValid(c.startDate)&&dateValid(c.endDate)&&c.startDate<=c.endDate;}
function minuteOfDay(time){
 if(typeof time!=='string'||!/^\d{2}:\d{2}$/.test(time))return null;
 const [h,m]=time.split(':').map(Number);return h<24&&m<60?h*60+m:null;
}
const within=(date,c)=>date>=c.startDate&&date<=c.endDate;
const describe=e=>({id:e.id??null,kind:e.kind,date:e.date??null,name:e.name??null,
 status:e.status??null,sourceId:e.sourceId??null,sourceURL:e.sourceURL??null,
 knownAt:e.knownAt??null});

export function classifyCalendar(now,data){
 const result={version:calendarContextVersion,decisionAt:Number.isFinite(now)?now:null,timeZone:zone,
  dateNy:null,dowNy:null,timeNy:null,dateUtc:null,weekend:null,known:false,primaryType:'calendar_unknown',
  tags:['calendar_unknown'],nyseClosed:null,earlyClose:null,earlyCloseTime:null,regularSession:null,
  federalHoliday:null,nyseClosureNames:[],federalHolidayNames:[],eventWindows:[],dateEvents:[],
  eventDay:false,eventDayKinds:[],calendarRevision:typeof data?.revision==='string'?data.revision:null,
  coverageReason:'invalid-time',coverageWarnings:[],knowledgeStatus:'unavailable',retrospectiveClassification:false,
  windowPolicy:calendarWindowPolicy};
 try{
  if(!Number.isFinite(now)||Math.abs(now)>8640000000000000)return result;
  const p=localParts(now);Object.assign(result,{dateNy:p.date,dowNy:p.dow,timeNy:p.time,
   dateUtc:new Date(now).toISOString().slice(0,10),weekend:p.dow===0||p.dow===6});
  const unknown=reason=>({...result,known:false,primaryType:'calendar_unknown',
   tags:[...new Set([...result.tags,'calendar_unknown'])],coverageReason:reason});
  if(!record(data)||data.schema!=='btc5m-market-calendar-v1'||typeof data.revision!=='string'||!data.revision)
   return unknown('calendar-missing-or-invalid-schema');
  const coverage=data.coverage;
  if(!rangeValid(coverage)||coverage.timezone!==zone)return unknown('invalid-calendar-coverage');
  if(!within(p.date,coverage))return unknown('calendar-outside-covered-dates');
  for(const name of ['nyseClosures','nyseEarlyCloses','federalHolidays','events'])
   if(!Array.isArray(data[name]))return unknown(`invalid-${name}`);
  if(data.nyseClosures.some(x=>!record(x)||!dateValid(x.date))||
   data.federalHolidays.some(x=>!record(x)||!dateValid(x.date))||
   data.nyseEarlyCloses.some(x=>!record(x)||!dateValid(x.date)||minuteOfDay(x.time)===null))
   return unknown('invalid-holiday-record');
  const required=coverage.requiredEventCategories??[];
  if(!Array.isArray(required)||required.some(x=>typeof x!=='string'))return unknown('invalid-required-event-categories');
  for(const kind of required){
   const c=coverage.eventCoverageByCategory?.[kind];
   if(!rangeValid(c)||c.status!=='complete'||!within(p.date,c))result.coverageWarnings.push(`event-coverage-unknown:${kind}`);
  }
  const closures=data.nyseClosures.filter(x=>x.date===p.date);
  const early=data.nyseEarlyCloses.filter(x=>x.date===p.date);
  if(early.length>1&&new Set(early.map(x=>x.time)).size>1)return unknown('conflicting-early-close-times');
  const federal=data.federalHolidays.filter(x=>x.date===p.date),close=early[0]?minuteOfDay(early[0].time):960;
  Object.assign(result,{nyseClosed:closures.length>0,earlyClose:early.length>0,earlyCloseTime:early[0]?.time??null,
   regularSession:!result.weekend&&!closures.length&&p.minute>=570&&p.minute<close,
   federalHoliday:federal.length>0,nyseClosureNames:closures.map(x=>x.name??x.date),
   federalHolidayNames:federal.map(x=>x.name??x.date)});
  const tags=new Set();if(result.weekend)tags.add('weekend');if(closures.length)tags.add('nyse_closed');
  if(early.length)tags.add('nyse_early_close');if(federal.length)tags.add('us_federal_holiday');
  if(federal.length&&!closures.length)tags.add('federal_only_holiday');
  const ids=new Set(),dayKinds=new Set();
  let retrospective=false;
  for(const event of data.events){
   if(!record(event)||typeof event.id!=='string'||!event.id||ids.has(event.id)||typeof event.kind!=='string')
    return unknown('invalid-or-duplicate-event');
   ids.add(event.id);
   // Formula-derived historical labels do not become confirmed precise events.
   if(!official.has(event.status))continue;
   const at=instant(event.at);if(at===null)return unknown('official-event-without-valid-instant');
   const known=event.knownAt===null||event.knownAt===undefined?null:instant(event.knownAt);
   if(event.knownAt!==null&&event.knownAt!==undefined&&known===null)return unknown('invalid-event-known-time');
   if(known!==null&&known>now)continue;
   let cachedDate=eventDates.get(event);
   if(!cachedDate||cachedDate.at!==at){cachedDate={at,date:localParts(at).date};eventDates.set(event,cachedDate);}
   const date=cachedDate.date,dayEvent={...describe(event),date,at,
    knowledgeStatus:known===null?'current-calendar-retrospective':'known-by-decision'};
   if(date===p.date){result.dateEvents.push(dayEvent);dayKinds.add(event.kind);if(known===null)retrospective=true;}
   const startAt=at-calendarWindowPolicy.preMinutes*60000,endAt=at+calendarWindowPolicy.postMinutes*60000;
   if(now>=startAt&&now<endAt){
    result.eventWindows.push({...dayEvent,startAt,endAt});tags.add(`event:${event.kind}`);
    if(macro.has(event.kind))tags.add('macro_release');
    else if(event.kind==='crypto_expiry')tags.add('crypto_expiry');
    else if(equity.has(event.kind))tags.add('equity_expiry');
    if(known===null)retrospective=true;
   }
  }
  if(data.dateOnlyEvents!==undefined&&!Array.isArray(data.dateOnlyEvents)||
   data.unscheduledTimeEvents!==undefined&&!Array.isArray(data.unscheduledTimeEvents))return unknown('invalid-date-only-events');
  const dateOnly=[...(data.dateOnlyEvents??[]),...(data.unscheduledTimeEvents??[])];
  if(dateOnly.some(x=>!record(x)||!dateValid(x.date)||typeof x.kind!=='string'))return unknown('invalid-date-only-event');
  for(const event of dateOnly){
   if(event.date!==p.date)continue;
   const known=event.knownAt===null||event.knownAt===undefined?null:instant(event.knownAt);
   if(event.knownAt!==null&&event.knownAt!==undefined&&known===null)return unknown('invalid-event-known-time');
   if(known!==null&&known>now)continue;
   result.dateEvents.push({...describe(event),knowledgeStatus:known===null?'current-calendar-retrospective':'known-by-decision'});
   dayKinds.add(event.kind);if(known===null)retrospective=true;
   // Official expiry dates can be classified as a day. They are never assigned
   // a made-up release/expiry instant and never appear in eventWindows.
   if(equity.has(event.kind)&&official.has(event.status)){tags.add('equity_expiry');tags.add(`date:${event.kind}`);}
  }
  result.eventDayKinds=[...dayKinds].sort();result.eventDay=dayKinds.size>0;
  result.retrospectiveClassification=retrospective;
  result.knowledgeStatus=retrospective?'current-calendar-retrospective':'known-by-decision-or-calendar-date';
  result.tags=[...tags];
  if(result.coverageWarnings.length)return unknown('required-event-coverage-incomplete');
  result.known=true;result.coverageReason='calendar-covered';
  result.primaryType=['macro_release','crypto_expiry','equity_expiry','nyse_closed','nyse_early_close',
   'federal_only_holiday','weekend'].find(x=>tags.has(x))??'regular_weekday';
  if(!result.tags.length)result.tags=['regular_weekday'];
  return result;
 }catch{
  return {...result,known:false,primaryType:'calendar_unknown',tags:[...new Set([...result.tags,'calendar_unknown'])],
   coverageReason:'calendar-parse-error'};
 }
}
