"use strict";

// Read-only Phase 6 counts from a records file. Parses JSON and prints.
// Does not migrate the file, write anything, or contact the network.

const fs = require("node:fs");

const RANGE = "Range: --since and --until are inclusive UTC dates matched to offer.createdAt and request.createdAt; --exclude-company is repeatable and drops an offer whose seller is that company and a request whose buyer or seller is that company, including a request between an excluded company and any other company.";
const OFFERS = "Offers: created is every offer in range; published means publishedAt is set; on chain means a chain record has an action whose kind is publish and whose status is confirmed.";
const REQUESTS = "Requests: arrived is every request in range; accepted, declined and withdrawn are the stored state; open is a stored state of pending or countered.";
const FIRST_RESPONSE = "First response: hours from createdAt to the first history entry whose to is countered, accepted or declined; the creation entry (to pending) does not count; a buyer decline of a counter is a later entry and is not this response; withdrawn is not a response; requests with no such entry are not yet; median is the middle value, or the mean of the two middle values; p90 is the nearest-rank value at ceil(0.9 times the count); hours are shown to one decimal.";
const FINAL_DECISION = "Final decision: hours from createdAt to the first history entry whose to is accepted, declined or withdrawn; withdrawn is final and is not a seller response; a buyer who declines a counter is this decision; requests with no such entry are not yet; median and p90 use the same rules as the first response; hours are shown to one decimal.";
const AFTER_ACCEPTANCE = "After acceptance: only a request whose stored state is accepted; completed, cancelled and carrier rejected are the current fulfilment status; rolled means a fulfilment history entry whose to is rolled; disputed means cancellation.state is disputed, or a cancellation event is refused.";
const COUNTERS = "Counters: requests is the number of requests with at least one counter; total is the number of counter rows.";
const PARTICIPANTS = "Participants: one row per company with an offer or a request in range; offers is offers that company created; made is requests where it is the buyer; received is requests where it is the seller; accepted is requests whose stored state is accepted and this company is the buyer or the seller; activity dates are the UTC day of each offer createdAt for its seller, each request createdAt for its buyer and its seller, each history at for the company that acted (actor equal to buyerSub is the buyer, any other actor is the seller), and acceptance.at for both companies when the request is accepted; again means activity on 2 or more distinct UTC days; the summary count is how many companies qualify; the name is a buyer or seller company name stored on a request, when the records have one.";

const FIRST_RESPONSE_TO = new Set(["countered", "accepted", "declined"]);
const FINAL_DECISION_TO = new Set(["accepted", "declined", "withdrawn"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseDay(text) {
  if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(5, 7));
  const day = Number(text.slice(8, 10));
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return null;
  return text;
}

function utcDay(iso) {
  if (typeof iso !== "string" || iso === "") return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

function inRange(iso, since, until) {
  const day = utcDay(iso);
  if (!day) return false;
  if (since && day < since) return false;
  if (until && day > until) return false;
  return true;
}

function recordsOf(map) {
  if (!isRecord(map)) return [];
  return Object.values(map).filter(isRecord).sort((left, right) => {
    return String(left.id).localeCompare(String(right.id));
  });
}

function publishedOnChain(offer) {
  const chain = offer.chain;
  if (!isRecord(chain) || !Array.isArray(chain.actions)) return false;
  return chain.actions.some((action) => {
    return isRecord(action) && action.kind === "publish" && action.status === "confirmed";
  });
}

function wasPublished(offer) {
  return typeof offer.publishedAt === "string" && offer.publishedAt !== "";
}

function firstHistory(request, kinds) {
  const history = Array.isArray(request.history) ? request.history : [];
  for (const entry of history) {
    if (isRecord(entry) && kinds.has(entry.to)) return entry;
  }
  return null;
}

function durationHours(request, entry) {
  if (!entry) return null;
  const start = Date.parse(request.createdAt);
  const end = Date.parse(entry.at);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return (end - start) / 3600000;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

// ceil(0.9 * n) in integer arithmetic, so the rank does not drift.
function p90Rank(count) {
  return Math.floor((9 * count + 9) / 10);
}

function summarize(hours) {
  if (hours.length === 0) {
    return { count: 0, medianHours: null, p90Hours: null, maxHours: null };
  }
  const sorted = hours.slice().sort((left, right) => left - right);
  const count = sorted.length;
  const mid = Math.floor(count / 2);
  const median = count % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    count,
    medianHours: round1(median),
    p90Hours: round1(sorted[p90Rank(count) - 1]),
    maxHours: round1(sorted[count - 1]),
  };
}

function fulfilmentOf(request) {
  return request.state === "accepted" && isRecord(request.fulfilment) ? request.fulfilment : null;
}

function statusIs(request, status) {
  const fulfilment = fulfilmentOf(request);
  return Boolean(fulfilment) && fulfilment.status === status;
}

function everRolled(request) {
  const fulfilment = fulfilmentOf(request);
  if (!fulfilment || !Array.isArray(fulfilment.history)) return false;
  return fulfilment.history.some((entry) => isRecord(entry) && entry.to === "rolled");
}

function isDisputed(request) {
  const fulfilment = fulfilmentOf(request);
  if (!fulfilment) return false;
  if (isRecord(fulfilment.cancellation) && fulfilment.cancellation.state === "disputed") return true;
  const events = Array.isArray(fulfilment.cancellationEvents) ? fulfilment.cancellationEvents : [];
  return events.some((event) => isRecord(event) && event.event === "refused");
}

function rowFor(companies, companyId) {
  if (typeof companyId !== "string" || companyId === "") return null;
  let row = companies.get(companyId);
  if (!row) {
    row = {
      companyId,
      companyName: null,
      offersCreated: 0,
      requestsMade: 0,
      requestsReceived: 0,
      requestsAccepted: 0,
      days: new Set(),
    };
    companies.set(companyId, row);
  }
  return row;
}

function addDay(row, iso) {
  if (!row) return;
  const day = utcDay(iso);
  if (day) row.days.add(day);
}

function rememberName(row, name) {
  if (!row || row.companyName) return;
  if (typeof name === "string" && name.trim() !== "") row.companyName = name;
}

function addHistoryDays(request, buyer, seller) {
  const history = Array.isArray(request.history) ? request.history : [];
  for (const entry of history) {
    if (!isRecord(entry) || typeof entry.actor !== "string" || entry.actor === "") continue;
    if (entry.actor === request.buyerSub) addDay(buyer, entry.at);
    else addDay(seller, entry.at);
  }
}

function compute(data, options) {
  const since = options.since;
  const until = options.until;
  const excluded = new Set(options.excludeCompany);
  const offers = { created: 0, published: 0, onChain: 0 };
  const requests = { arrived: 0, accepted: 0, declined: 0, withdrawn: 0, open: 0 };
  const afterAcceptance = { completed: 0, cancelled: 0, rolled: 0, disputed: 0, carrierRejected: 0 };
  const counters = { requests: 0, total: 0 };
  const firstHours = [];
  const finalHours = [];
  let firstNotYet = 0;
  let finalNotYet = 0;
  const companies = new Map();

  for (const offer of recordsOf(data.offers)) {
    if (excluded.has(offer.companyId)) continue;
    if (!inRange(offer.createdAt, since, until)) continue;
    offers.created += 1;
    if (wasPublished(offer)) offers.published += 1;
    if (publishedOnChain(offer)) offers.onChain += 1;
    const seller = rowFor(companies, offer.companyId);
    if (seller) {
      seller.offersCreated += 1;
      addDay(seller, offer.createdAt);
    }
  }

  for (const request of recordsOf(data.requests)) {
    if (excluded.has(request.buyerCompanyId) || excluded.has(request.sellerCompanyId)) continue;
    if (!inRange(request.createdAt, since, until)) continue;
    requests.arrived += 1;
    if (request.state === "accepted") requests.accepted += 1;
    else if (request.state === "declined") requests.declined += 1;
    else if (request.state === "withdrawn") requests.withdrawn += 1;
    else if (request.state === "pending" || request.state === "countered") requests.open += 1;

    const first = durationHours(request, firstHistory(request, FIRST_RESPONSE_TO));
    if (first == null) firstNotYet += 1;
    else firstHours.push(first);
    const final = durationHours(request, firstHistory(request, FINAL_DECISION_TO));
    if (final == null) finalNotYet += 1;
    else finalHours.push(final);

    if (statusIs(request, "completed")) afterAcceptance.completed += 1;
    if (statusIs(request, "cancelled")) afterAcceptance.cancelled += 1;
    if (everRolled(request)) afterAcceptance.rolled += 1;
    if (isDisputed(request)) afterAcceptance.disputed += 1;
    if (statusIs(request, "rejected")) afterAcceptance.carrierRejected += 1;

    const counterRows = Array.isArray(request.counters) ? request.counters : [];
    if (counterRows.length > 0) counters.requests += 1;
    counters.total += counterRows.length;

    const buyer = rowFor(companies, request.buyerCompanyId);
    const seller = rowFor(companies, request.sellerCompanyId);
    if (buyer) {
      buyer.requestsMade += 1;
      addDay(buyer, request.createdAt);
      rememberName(buyer, request.buyerCompanyName);
    }
    if (seller) {
      seller.requestsReceived += 1;
      addDay(seller, request.createdAt);
      rememberName(seller, request.sellerCompanyName);
    }
    if (request.state === "accepted") {
      if (buyer) buyer.requestsAccepted += 1;
      if (seller) seller.requestsAccepted += 1;
      if (isRecord(request.acceptance)) {
        addDay(buyer, request.acceptance.at);
        addDay(seller, request.acceptance.at);
      }
    }
    addHistoryDays(request, buyer, seller);
  }

  const participants = [...companies.values()].map((row) => {
    const days = [...row.days].sort();
    return {
      companyId: row.companyId,
      companyName: row.companyName,
      offersCreated: row.offersCreated,
      requestsMade: row.requestsMade,
      requestsReceived: row.requestsReceived,
      requestsAccepted: row.requestsAccepted,
      firstActivity: days[0] || null,
      lastActivity: days[days.length - 1] || null,
      again: days.length >= 2,
    };
  }).sort((left, right) => left.companyId.localeCompare(right.companyId));

  return {
    offers,
    requests,
    firstResponse: { ...summarize(firstHours), notYet: firstNotYet },
    finalDecision: { ...summarize(finalHours), notYet: finalNotYet },
    afterAcceptance,
    counters,
    repeat: {
      again: participants.filter((row) => row.again).length,
      participants,
    },
  };
}

function hoursText(value) {
  return value == null ? "none" : value.toFixed(1);
}

function formatParticipant(row) {
  const again = row.again ? "yes" : "no";
  const first = row.firstActivity == null ? "none" : row.firstActivity;
  const last = row.lastActivity == null ? "none" : row.lastActivity;
  return [
    "participant",
    `companyId=${row.companyId}`,
    `companyName=${JSON.stringify(row.companyName)}`,
    `offersCreated=${row.offersCreated}`,
    `requestsMade=${row.requestsMade}`,
    `requestsReceived=${row.requestsReceived}`,
    `requestsAccepted=${row.requestsAccepted}`,
    `firstActivity=${first}`,
    `lastActivity=${last}`,
    `again=${again}`,
  ].join(" ");
}

function formatText(report) {
  const lines = [
    RANGE,
    OFFERS,
    `offers.created: ${report.offers.created}`,
    `offers.published: ${report.offers.published}`,
    `offers.onChain: ${report.offers.onChain}`,
    "",
    REQUESTS,
    `requests.arrived: ${report.requests.arrived}`,
    `requests.accepted: ${report.requests.accepted}`,
    `requests.declined: ${report.requests.declined}`,
    `requests.withdrawn: ${report.requests.withdrawn}`,
    `requests.open: ${report.requests.open}`,
    "",
    FIRST_RESPONSE,
    `firstResponse.count: ${report.firstResponse.count}`,
    `firstResponse.medianHours: ${hoursText(report.firstResponse.medianHours)}`,
    `firstResponse.p90Hours: ${hoursText(report.firstResponse.p90Hours)}`,
    `firstResponse.maxHours: ${hoursText(report.firstResponse.maxHours)}`,
    `firstResponse.notYet: ${report.firstResponse.notYet}`,
    "",
    FINAL_DECISION,
    `finalDecision.count: ${report.finalDecision.count}`,
    `finalDecision.medianHours: ${hoursText(report.finalDecision.medianHours)}`,
    `finalDecision.p90Hours: ${hoursText(report.finalDecision.p90Hours)}`,
    `finalDecision.maxHours: ${hoursText(report.finalDecision.maxHours)}`,
    `finalDecision.notYet: ${report.finalDecision.notYet}`,
    "",
    AFTER_ACCEPTANCE,
    `afterAcceptance.completed: ${report.afterAcceptance.completed}`,
    `afterAcceptance.cancelled: ${report.afterAcceptance.cancelled}`,
    `afterAcceptance.rolled: ${report.afterAcceptance.rolled}`,
    `afterAcceptance.disputed: ${report.afterAcceptance.disputed}`,
    `afterAcceptance.carrierRejected: ${report.afterAcceptance.carrierRejected}`,
    "",
    COUNTERS,
    `counters.requests: ${report.counters.requests}`,
    `counters.total: ${report.counters.total}`,
    "",
    PARTICIPANTS,
    `repeat.again: ${report.repeat.again}`,
  ];
  for (const row of report.repeat.participants) lines.push(formatParticipant(row));
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const out = { since: null, until: null, excludeCompany: [], json: false, file: null, error: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      out.json = true;
      continue;
    }
    if (arg === "--since" || arg === "--until" || arg === "--exclude-company" || arg === "--file") {
      const value = argv[i + 1];
      if (value == null || value === "" || value.startsWith("--")) {
        out.error = `Missing value for ${arg}.`;
        return out;
      }
      i += 1;
      if (arg === "--file") {
        out.file = value;
      } else if (arg === "--exclude-company") {
        out.excludeCompany.push(value);
      } else {
        const day = parseDay(value);
        if (!day) {
          out.error = `${arg} must be a UTC date YYYY-MM-DD.`;
          return out;
        }
        if (arg === "--since") out.since = day;
        else out.until = day;
      }
      continue;
    }
    out.error = `Unknown argument ${arg}.`;
    return out;
  }
  return out;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  return 1;
}

function readRecords(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = err && err.code ? err.code : "error";
    return { error: `Cannot read records file (${code}).`, code: 1 };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: "Records file is not JSON.", code: 1 };
  }
  if (!isRecord(data)) return { error: "Records file is not a JSON object.", code: 1 };
  if (data.schemaVersion !== 7) {
    const shown = data.schemaVersion === undefined ? "undefined" : JSON.stringify(data.schemaVersion);
    return {
      schema: `schemaVersion is ${shown}, expected 7\n`,
      code: 2,
    };
  }
  return { data };
}

function main(argv, env) {
  const args = parseArgs(argv);
  if (args.error) return fail(args.error);
  const file = args.file || env.OCEANRELAY_RECORDS_PATH || "";
  if (!file) return fail("Set OCEANRELAY_RECORDS_PATH or pass --file <path>.");
  const loaded = readRecords(file);
  if (loaded.schema) {
    process.stdout.write(loaded.schema);
    return loaded.code;
  }
  if (loaded.error) return fail(loaded.error);
  const report = compute(loaded.data, args);
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : formatText(report));
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2), process.env));
}
