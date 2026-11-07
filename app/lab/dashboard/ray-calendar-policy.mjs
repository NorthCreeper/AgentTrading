import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {classifyCalendar} from './calendar-context.mjs';
import {selectCalendarThreshold} from './calendar-threshold.mjs';

const load=name=>{try{const bytes=readFileSync(new URL('./reports/'+name,import.meta.url));
 return {value:JSON.parse(bytes.toString('utf8')),sha256:createHash('sha256').update(bytes).digest('hex'),error:null};
}catch(error){return {value:null,sha256:null,error:error.message};}};
const calendar=load('ray-calendar-data.json'),policy=load('ray-calendar-policy.json');

export function rayCalendarThreshold(now,session){
 const context=classifyCalendar(now,calendar.value);
 const matched=policy.value?.calendarSha256===calendar.sha256;
 const result=selectCalendarThreshold({now,session,context,model:matched?policy.value:null});
 return {...result,...(!matched&&policy.value?{status:'calendar-assets-mismatch',reason:'日历与标定文件字节来源不匹配，沿用原时段门槛'}:{}),
  calendarSourceSha256:calendar.sha256,policySourceSha256:policy.sha256,
  resourceErrors:[calendar.error,policy.error].filter(Boolean)};
}
