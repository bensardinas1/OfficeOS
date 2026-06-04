// Minimal email objects keyed by msgid, as the applier receives them.
export const sampleEmailsById = {
  "m-neal": { id: "m-neal", from: "neal.zeleznak@nmi.com", fromName: "Neal Zeleznak", subject: "BrickellPay and NMI at SEAA", account: "brickellpay", received: "2026-05-26T19:56:58Z" },
  "m-brad": { id: "m-brad", from: "bstaudt@north.com", fromName: "Brad Staudt", subject: "Partnership Programs, Made For You", account: "brickellpay", received: "2026-05-27T14:07:27Z" },
  "m-promo1": { id: "m-promo1", from: "news@valorpaytech.com", fromName: "Valor PayTech", subject: "Stop by Booth 107 at SEAA 2026", account: "brickellpay", received: "2026-05-26T13:44:45Z" },
  "m-promo2": { id: "m-promo2", from: "sales@dccsupply.com", fromName: "DCCSupply", subject: "Refurbished Devices Backed by Quality & Care", account: "brickellpay", received: "2026-05-27T11:00:27Z" },
  "m-oneoff": { id: "m-oneoff", from: "someone@new.com", fromName: "Someone", subject: "Quick intro", account: "brickellpay", received: "2026-05-27T10:00:00Z" },
};

// Expected reasoner verdicts for the SEAA golden case.
export const seaaReasonerOutput = [
  { msgid: "m-neal", verdict: "keep", issue: "NEW:SEAA Partner Meetings", reason: "Personalized; NMI is a priority sender", next_action_update: "Reply to Neal (NMI) re: meeting at show", waiting_on_update: "you" },
  { msgid: "m-brad", verdict: "keep", issue: "NEW:SEAA Partner Meetings", reason: "Personalized; North is a priority sender", next_action_update: "Reply to Brad (North) re: partner program", waiting_on_update: "you" },
  { msgid: "m-promo1", verdict: "trash", issue: null, reason: "Broadcast booth promo, has unsubscribe" },
  { msgid: "m-promo2", verdict: "trash", issue: null, reason: "Broadcast booth promo" },
  { msgid: "m-oneoff", verdict: "keep", issue: "NEW:Quick Intro From Someone", reason: "Survivor, no existing issue", next_action_update: "", waiting_on_update: "you" },
];
