// Reject inconsistent source ordering before it can enter momentum history.
// A repeated unchanged snapshot is allowed; its original age is never refreshed.
export function bookSequenceIssue(previous,current) {
  if(!previous || previous.tokenId!==current.tokenId)return null;
  if(current.timestamp<previous.timestamp)return 'source-time-regression';
  if(current.timestamp===previous.timestamp &&
    (JSON.stringify(current.bids)!==JSON.stringify(previous.bids)||JSON.stringify(current.asks)!==JSON.stringify(previous.asks)))return 'same-time-conflicting-levels';
  return null;
}
