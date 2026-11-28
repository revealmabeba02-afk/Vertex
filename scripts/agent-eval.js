#!/usr/bin/env node
// 001 regression suite.
//
// Runs in about a second, spends nothing, and needs no AI provider. It exists
// because the deterministic answers are customer-facing money facts — prices,
// refunds, where to pay — and one of them had already gone stale: the credits
// answer kept saying "Whop credits automatically" for days after Whop was
// removed. That is the kind of bug no crash and no log reveals; only a check
// like this does.
//
// Usage: node scripts/agent-eval.js

const { deterministicSupportReply } = require("../server/supportBrain");

const cases = [
  {
    q: "how much do credits cost",
    want: [/4\.99/, /8\.99/, /19\.99/],
    forbid: [/whop/i],
    why: "prices must be current and must not mention the removed processor"
  },
  { q: "what is the price of 20 scans", want: [/8\.99/, /20/], forbid: [/whop/i], why: "bundle lookup" },
  { q: "can i pay with paypal", want: [/paypal\.me\/jthanos/i, /email/i], forbid: [], why: "exact PayPal destination" },
  { q: "i want to do a bank transfer", want: [/bank/i, /reference/i], forbid: [/iban\s*:/i], why: "never print account numbers" },
  { q: "is this financial advice", want: [/not financial advice/i], forbid: [/guaranteed profit/i], why: "the trust question" },
  { q: "what is your win rate", want: [/not a win rate|not financial advice/i], forbid: [/\d+\s*%\s*win/i], why: "no invented statistics" },
  { q: "is it guaranteed", want: [/not/i], forbid: [/guaranteed profit/i, /risk[- ]free/i], why: "no profit promises" },
  { q: "will i make money", want: [/not/i], forbid: [/yes/i], why: "no income promises" },
  { q: "my scan failed", want: [/refund/i], forbid: [], why: "refund rule" },
  { q: "i was charged and got nothing", want: [/refund|check/i], forbid: [], why: "money taken, no credits" },
  { q: "how do i scan", want: [/pick a pair|upload/i], forbid: [], why: "onboarding" },
  { q: "the image upload is not working", want: [/pick a pair/i], forbid: [], why: "image failures point at the reliable path" },
  { q: "i cant log in", want: [/forgot password/i], forbid: [], why: "login recovery" },
  { q: "hello", want: [], expectNull: true, why: "small talk must go to the model, not a canned answer" }
];

const GLOBAL_FORBIDDEN = [
  { re: /whop/i, why: "Whop is removed from the product" },
  { re: /guaranteed profit/i, why: "illegal-adjacent promise" },
  { re: /risk[- ]free/i, why: "no trade is risk free" },
  { re: /\b\d{2,3}\s*%\s*win/i, why: "invented win rate" },
  { re: /unlimited scans/i, why: "there is no unlimited plan" }
];

let failed = 0;
let ran = 0;

for (const c of cases) {
  ran += 1;
  const out = deterministicSupportReply(c.q);
  const problems = [];

  if (c.expectNull) {
    if (out !== null) problems.push("expected no canned answer, got one");
  } else {
    if (!out) {
      problems.push("expected an instant answer, got null (would fall through to the model)");
    } else {
      const reply = out.reply || "";
      for (const re of c.want) if (!re.test(reply)) problems.push(`missing ${re}`);
      for (const re of c.forbid) if (re.test(reply)) problems.push(`must not contain ${re}`);
      for (const g of GLOBAL_FORBIDDEN) if (g.re.test(reply)) problems.push(g.why);
      if (reply.length > 480) problems.push(`too long (${reply.length} chars)`);
      if (out.confidence !== "high") problems.push("deterministic answers must be high confidence");
    }
  }

  if (problems.length) {
    failed += 1;
    console.log(`FAIL  ${c.q}`);
    for (const p of problems) console.log(`      - ${p}`);
    console.log(`      why: ${c.why}`);
  } else {
    console.log(`ok    ${c.q}`);
  }
}

console.log(`\n${ran - failed}/${ran} passed`);
process.exit(failed ? 1 : 0);
