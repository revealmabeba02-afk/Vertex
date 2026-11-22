// The money brief — what the business actually looks like, in numbers a person
// can act on.
//
// King asked the agents to "get info how are we going to make money". That is
// two different questions and mixing them is how reports become useless:
//
//   1. Where does money come from right now?      → arithmetic, not opinion.
//   2. What would make more of it?                → a judgement, and the only
//                                                    place a model is allowed.
//
// So the numbers are computed here from the same admin RPCs the dashboard uses
// (no new tables, no service-role key), and the model only ever sees the
// summary and writes the advice. If the model is unavailable the numbers still
// arrive — a brief with no advice is still useful; a brief with invented advice
// is not.
//
// Deliberately no projections. "You will make $X" is a lie dressed as a
// forecast. Every line is either a fact or a suggestion.

const rpcSafe = async (rpc, name, fallback = null) => {
  try {
    return await rpc(name);
  } catch {
    return fallback;
  }
};

// Turns the raw admin answers into the single object every report and every
// model sees. Kept separate from fetching because there are now two ways in —
// the owner's own session (dashboard) and the agent's own secret (unattended) —
// and both must produce identical numbers. If they ever disagree, the dashboard
// is right and the difference is a bug, so there is exactly one builder.
function buildMoney({ users, paying, paidRows, analytics, months, pending, days }) {
  const rows = Array.isArray(paidRows) ? paidRows : [];
  const totalRevenue = rows.reduce((sum, r) => sum + Number(r.paid_usd || 0), 0);
  const totalPaidScans = rows.reduce((sum, r) => sum + Number(r.paid_scans || 0), 0);
  const totalOrders = rows.reduce((sum, r) => sum + Number(r.orders_count || 0), 0);

  const perDay = Array.isArray(analytics?.per_day) ? analytics.per_day : [];
  const scans14 = perDay.reduce((sum, d) => sum + Number(d.scans || 0), 0);

  return {
    at: new Date().toISOString(),
    users: typeof users === "number" ? users : null,
    payingUsers: typeof paying === "number" ? paying : null,
    orders: totalOrders,
    revenueUsd: Number(totalRevenue.toFixed(2)),
    paidScansSold: totalPaidScans,
    scansLast14Days: scans14,
    thisMonth: months?.this_month || null,
    lastMonth: months?.last_month || null,
    pendingOrders: Array.isArray(pending) ? pending.length : null,
    topPairs: (Array.isArray(analytics?.top_pairs) ? analytics.top_pairs : []).slice(0, 3),
    bestWeekday: Array.isArray(days) && days.length
      ? days.reduce((best, d) => (Number(d.revenue_usd) > Number(best.revenue_usd) ? d : best), days[0])
      : null
  };
}

// Pulls everything the brief needs through the caller's own Supabase session.
// Each call fails soft: one missing RPC (because a migration was never run) must
// not blank the whole report.
async function collectMoney({ rpc }) {
  const [users, paying, paidRows, analytics, months, pending, days] = await Promise.all([
    rpcSafe(rpc, "admin_user_count", null),
    rpcSafe(rpc, "admin_paying_users_count", null),
    rpcSafe(rpc, "admin_paid_summary", []),
    rpcSafe(rpc, "admin_scan_analytics", { per_day: [], top_pairs: [], by_hour: [] }),
    rpcSafe(rpc, "admin_month_comparison", null),
    rpcSafe(rpc, "admin_list_pending_orders", []),
    rpcSafe(rpc, "admin_purchase_day_pattern", [])
  ]);
  return buildMoney({ users, paying, paidRows, analytics, months, pending, days });
}

// The unattended door. The admin readers in Postgres only answer the owner's
// email, so an agent with no login cannot use them — and putting the
// service-role key on the server to bypass that would give one process the whole
// database. Instead there is one function, agent_money(), that takes a shared
// secret and returns the same numbers; the secret is all the server has, and it
// cannot read a single row beyond this summary. See supabase/agent_money.sql.
const AGENT_KEYS = {
  admin_user_count: "users",
  admin_paying_users_count: "paying",
  admin_paid_summary: "paid",
  admin_scan_analytics: "analytics",
  admin_month_comparison: "months",
  admin_list_pending_orders: "pending",
  admin_purchase_day_pattern: "days"
};

async function readAgentSnapshot({ url, anonKey, secret, timeoutMs = 15000 }) {
  if (!url || !anonKey || !secret) throw new Error("agent money reader is not configured");
  const res = await fetch(`${String(url).replace(/\/+$/, "")}/rest/v1/rpc/agent_money`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ p_secret: secret }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`agent_money ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("agent_money returned something that was not JSON");
  }
}

async function collectMoneyViaAgent(opts) {
  const raw = await readAgentSnapshot(opts);
  const pick = (name, fallback) => {
    const v = raw?.[AGENT_KEYS[name]];
    return v === undefined || v === null ? fallback : v;
  };
  return buildMoney({
    users: pick("admin_user_count", null),
    paying: pick("admin_paying_users_count", null),
    paidRows: pick("admin_paid_summary", []),
    analytics: pick("admin_scan_analytics", { per_day: [], top_pairs: [], by_hour: [] }),
    months: pick("admin_month_comparison", null),
    pending: pick("admin_list_pending_orders", []),
    days: pick("admin_purchase_day_pattern", [])
  });
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Plain arithmetic with thresholds, not predictions. Each finding names the
// number it came from so it can be checked.
function analyse(m) {
  const findings = [];
  const conversion = m.users && m.payingUsers != null ? (m.payingUsers / m.users) * 100 : null;
  const avgOrder = m.orders ? m.revenueUsd / m.orders : null;

  if (m.users == null) {
    findings.push({ level: "warn", text: "Could not read the user count — check that the admin_setup.sql migration has been run." });
  } else if (m.users === 0) {
    findings.push({ level: "info", text: "No accounts yet. Nothing else in this brief can happen until people sign up." });
  } else if (!m.payingUsers) {
    findings.push({
      level: "warn",
      text: `${m.users} account${m.users === 1 ? "" : "s"}, none of them paying. The gap is between "signed up" and "paid", not between "visitor" and "signed up".`
    });
  } else {
    findings.push({
      level: "ok",
      text: `${m.payingUsers} of ${m.users} accounts have paid — ${conversion.toFixed(1)}% conversion.`
    });
  }

  if (m.orders && avgOrder != null) {
    findings.push({ level: "info", text: `Average order is $${avgOrder.toFixed(2)} across ${m.orders} order${m.orders === 1 ? "" : "s"}.` });
  }

  // Repeat purchase is the cheapest money there is: a paying customer already
  // knows the product works, so the second sale costs no ad spend.
  if (m.payingUsers && m.orders) {
    const perBuyer = m.orders / m.payingUsers;
    if (perBuyer < 1.2) {
      findings.push({
        level: "warn",
        text: `Nearly everyone buys once and stops (${perBuyer.toFixed(2)} orders per buyer). Credits run out and nobody comes back — that is the cheapest revenue being left on the table.`
      });
    } else {
      findings.push({ level: "ok", text: `${perBuyer.toFixed(2)} orders per buyer — people are topping up, not just trying it once.` });
    }
  }

  if (m.paidScansSold > 0 && m.scansLast14Days === 0) {
    findings.push({ level: "warn", text: "Credits were sold but no scans ran in the last 14 days. Either the scanner is broken or nobody is logging in." });
  } else if (m.paidScansSold > 0) {
    findings.push({ level: "info", text: `${m.scansLast14Days} scans ran in the last 14 days, against ${m.paidScansSold} paid credits ever sold.` });
  }

  if (m.pendingOrders) {
    findings.push({
      level: "warn",
      text: `${m.pendingOrders} payment${m.pendingOrders === 1 ? " is" : "s are"} waiting for your approval. Money already sent and not yet credited looks like a broken product from the buyer's side.`
    });
  }

  if (m.thisMonth && m.lastMonth) {
    const now = Number(m.thisMonth.revenue_usd || 0);
    const before = Number(m.lastMonth.revenue_usd || 0);
    if (before > 0) {
      const change = ((now - before) / before) * 100;
      findings.push({
        level: change >= 0 ? "ok" : "warn",
        text: `This month $${now.toFixed(2)} vs $${before.toFixed(2)} last month (${change >= 0 ? "+" : ""}${change.toFixed(0)}%).`
      });
    } else if (now > 0) {
      findings.push({ level: "ok", text: `First revenue month: $${now.toFixed(2)}.` });
    }
  }

  if (m.bestWeekday && Number(m.bestWeekday.revenue_usd) > 0) {
    const day = WEEKDAYS[Number(m.bestWeekday.dow)] || "?";
    findings.push({ level: "info", text: `${day} is the day people actually buy ($${Number(m.bestWeekday.revenue_usd).toFixed(2)}).` });
  }

  // Where money comes from, stated once, so the brief is readable a year from
  // now when the code has changed but the business has not.
  findings.push({
    level: "info",
    text: "How Vertex earns: visitors land on the site → sign up free → get a few free scans → buy scan credits (Quick/Starter/Trader/Pro bundles) when those run out → top up again as they keep scanning. Mentorship applications are a second, smaller stream. Every dollar comes from a person who already used the scanner once and wanted more."
  });

  return { conversion, avgOrder, findings };
}

function renderMoneyBrief(m, analysis, advice) {
  const lines = [];
  lines.push(`001 — MONEY BRIEF`);
  lines.push(new Date(m.at).toUTCString());
  lines.push("");
  lines.push(`Revenue all-time: $${m.revenueUsd.toFixed(2)}`);
  lines.push(`Orders: ${m.orders}   Buyers: ${m.payingUsers == null ? "—" : m.payingUsers}   Accounts: ${m.users == null ? "—" : m.users}`);
  lines.push(`Scans last 14 days: ${m.scansLast14Days}   Paid credits ever sold: ${m.paidScansSold}`);
  if (m.pendingOrders) lines.push(`Pending payments to approve: ${m.pendingOrders}`);
  if (m.topPairs.length) {
    lines.push(`Most scanned: ${m.topPairs.map((p) => `${p.symbol} (${p.scans})`).join(", ")}`);
  }
  lines.push("");
  lines.push(`WHAT THE NUMBERS SAY`);
  analysis.findings.forEach((f) => {
    const mark = f.level === "warn" ? "!" : f.level === "ok" ? "+" : "-";
    lines.push(`${mark} ${f.text}`);
  });
  if (advice) {
    lines.push("");
    lines.push(`WHAT TO DO NEXT`);
    lines.push(advice);
  }
  lines.push("");
  lines.push(`Full detail: https://vertex-9s4c.onrender.com/admin`);
  return lines.join("\n");
}

module.exports = { collectMoney, collectMoneyViaAgent, readAgentSnapshot, buildMoney, analyse, renderMoneyBrief };
