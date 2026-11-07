import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {historySourceRegistrationHash,readHistoryApproval} from '../../dashboard/history-approval.mjs';
const lab=resolve(new URL('../../',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'));
const directory=resolve(process.argv[2]),runtime=join(lab,'dashboard/runtime');
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex'),read=p=>JSON.parse(readFileSync(p,'utf8'));
const registration=read(join(directory,'registration.json')),certificate=read(join(directory,'certificate.json'));
const binding={candidateId:'p3-consensus',reportSha256:hash(join(directory,'report.json')),
 registrationSha256:hash(join(directory,'registration.json')),certificateSha256:hash(join(directory,'certificate.json')),
 sourceRegistrationHash:historySourceRegistrationHash(registration.sources)};
assert.equal(certificate.reportSha256,binding.reportSha256);assert.equal(certificate.registrationSha256,binding.registrationSha256);
assert.ok(!existsSync(join(runtime,'history-approval.json')),'Never replace an existing pinned decision silently');
const now=Date.now(),approval={version:'paper-history-approval-v1',scope:'paper-only',approvedAt:now,...binding,
 reportPath:join(directory,'report.json'),registrationPath:join(directory,'registration.json'),certificatePath:join(directory,'certificate.json')},
 approvalPath=join(runtime,'history-approval.json');
writeFileSync(approvalPath,JSON.stringify(approval,null,2)+'\n',{flag:'wx'});
const reviewed=readHistoryApproval({approvalPath,binding,now});
assert.ok(['independently-verified','independent-history-screen-failed'].includes(reviewed.code),JSON.stringify(reviewed));
const sourcePath=join(lab,'dashboard/history-approval-binding.mjs');
assert.match(readFileSync(sourcePath,'utf8'),/historyApprovalBindingPinned\s*=\s*null/,'Only the unused initial template may be filled');
writeFileSync(sourcePath,'// Fixed original historical evidence; eligibility is independently recalculated.\nexport const historyApprovalBindingPinned = Object.freeze('+JSON.stringify(binding,null,2)+');\n');
writeFileSync(join(directory,'history-binding-review.json'),JSON.stringify({at:now,binding,reviewed},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({binding,reviewed}));
