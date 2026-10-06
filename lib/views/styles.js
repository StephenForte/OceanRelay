"use strict";

const crypto = require("node:crypto");

// One stylesheet for every HTML page. No @import and no url() so a page
// cannot pull in an outside asset. The hash is the cache key (?v=).
const stylesheet = `body {
  margin: 0;
  font-family: "Segoe UI", system-ui, sans-serif;
  background: #f4f7fb;
  color: #102a43;
  line-height: 1.5;
}
.skip {
  position: absolute;
  left: 0.75rem;
  top: 0.75rem;
  transform: translateY(-150%);
  background: #fff;
  color: #102a43;
  padding: 0.5rem 0.75rem;
  border-radius: 8px;
  z-index: 3;
}
.skip:focus { transform: none; }
.site-header {
  background: #102a43;
  color: #f7fafc;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem 1.25rem;
  padding: 0.75rem 1.25rem;
}
.brand {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  color: #fff;
  font-weight: 700;
  font-size: 1.15rem;
  text-decoration: none;
}
.mark { display: block; }
.nav { display: flex; flex-wrap: wrap; gap: 0.25rem 0.35rem; }
.nav a {
  color: #e6f0f8;
  text-decoration: none;
  padding: 0.45rem 0.7rem;
  border-radius: 8px;
}
.nav a[aria-current="page"] {
  background: #0f3a56;
  color: #fff;
  font-weight: 700;
  box-shadow: inset 0 -3px 0 #5eead4;
}
.account { margin-left: auto; display: flex; align-items: center; gap: 0.75rem; }
.company { font-weight: 650; }
main { max-width: 72rem; margin: 0 auto; padding: 1.5rem 1.25rem 3rem; }
h1 { margin: 0 0 0.75rem; font-size: 1.8rem; line-height: 1.2; }
h2 { margin: 0 0 0.6rem; font-size: 1.2rem; }
a { color: #0f766e; }
p.lead { font-size: 1.15rem; }
p.note, .muted { color: #486581; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
button, .btn {
  font: inherit;
  background: #0f766e;
  color: #fff;
  border: 1px solid #0f766e;
  border-radius: 8px;
  padding: 0.7rem 1rem;
  cursor: pointer;
  text-decoration: none;
  display: inline-block;
  line-height: 1.2;
}
.btn-secondary, button.secondary {
  background: #fff;
  color: #0f766e;
}
.btn-danger, button.danger { background: #9b1c1c; border-color: #9b1c1c; color: #fff; }
button[disabled], .btn[aria-disabled="true"] {
  background: #9fb3c8;
  border-color: #9fb3c8;
  color: #102a43;
  cursor: not-allowed;
}
.site-header button {
  background: transparent;
  color: #fff;
  border-color: #d9e2ec;
}
.actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 1rem; }
.card, .panel {
  background: #fff;
  border: 1px solid #d9e2ec;
  border-radius: 12px;
  padding: 1.15rem 1.25rem;
  margin: 1rem 0;
}
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
.stat {
  display: block;
  background: #fff;
  border: 1px solid #d9e2ec;
  border-radius: 12px;
  padding: 1rem;
  text-decoration: none;
  color: #102a43;
}
.stat-count { display: block; font-size: 1.8rem; font-weight: 700; color: #0f766e; }
.steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; padding: 0; list-style: none; }
.steps li { background: #fff; border: 1px solid #d9e2ec; border-radius: 12px; padding: 1rem; }
.steps h2 { font-size: 1.05rem; }
.banner { border-radius: 8px; padding: 0.75rem 1rem; margin: 0.75rem 0; }
.banner-info { background: #e0f2fe; color: #0c4a6e; }
.banner-success { background: #d1fae5; color: #065f46; }
.banner-error, .error { background: #fee2e2; color: #991b1b; }
p.error { background: transparent; margin: 0.25rem 0 0; }
.pill {
  display: inline-block;
  border-radius: 999px;
  padding: 0.12rem 0.6rem;
  font-size: 0.85rem;
  font-weight: 700;
  line-height: 1.4;
}
.pill-good { background: #d1fae5; color: #065f46; }
.pill-wait { background: #fef3c7; color: #92400e; }
.pill-attention { background: #dbeafe; color: #1e3a8a; }
.pill-bad { background: #fee2e2; color: #991b1b; }
.pill-neutral { background: #e5e7eb; color: #1f2937; }
.pill-closed { background: #f3f4f6; color: #374151; }
.empty { color: #486581; }
dl { display: grid; grid-template-columns: 12rem 1fr; gap: 0.35rem 1rem; }
dt { color: #486581; }
dd { margin: 0; }
.tag { font-weight: 400; color: #486581; }
fieldset {
  border: 1px solid #d9e2ec;
  border-radius: 12px;
  margin: 1rem 0;
  padding: 0.5rem 1rem 1rem;
}
legend { font-weight: 700; padding: 0 0.35rem; }
label { display: block; margin-top: 0.9rem; font-weight: 700; }
input, select, textarea {
  font: inherit;
  width: 100%;
  box-sizing: border-box;
  margin-top: 0.25rem;
  padding: 0.45rem 0.55rem;
  border: 1px solid #9fb3c8;
  border-radius: 8px;
  background: #fff;
  color: #102a43;
}
input[type="checkbox"], input[type="radio"] { width: auto; }
textarea { min-height: 6rem; }
.table-wrap { overflow-x: auto; max-width: 100%; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; vertical-align: top; padding: 0.55rem 0.6rem; border-bottom: 1px solid #d9e2ec; }
th { color: #486581; font-size: 0.85rem; }
.search-bar {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: 0.75rem;
  align-items: end;
  background: #fff;
  border: 1px solid #d9e2ec;
  border-radius: 12px;
  padding: 1rem;
}
.search-bar button { margin: 0; }
.market-layout { display: grid; grid-template-columns: 16rem 1fr; gap: 1.25rem; align-items: start; margin-top: 1rem; }
.filters { background: #fff; border: 1px solid #d9e2ec; border-radius: 12px; padding: 0.75rem 1rem 1rem; }
.filters summary { font-weight: 700; cursor: pointer; padding: 0.35rem 0; }
#market-list, #rate-list, .cards {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
  gap: 1rem;
}
#market-list > li, #rate-list > li, .offer-card {
  background: #fff;
  border: 1px solid #d9e2ec;
  border-radius: 12px;
  padding: 1rem;
  margin: 0;
}
.lane { font-size: 1.35rem; font-weight: 700; margin: 0 0 0.35rem; }
.price { font-size: 1.25rem; font-weight: 700; color: #0f766e; margin: 0.35rem 0; }
.share { margin: 0.15rem 0 0.5rem; }
li.taken, li.taken a, li.taken p { color: #6b7280; }
li.taken { background: #f3f4f6; }
.offer-detail { display: grid; grid-template-columns: 1.4fr 0.85fr; gap: 1.25rem; align-items: start; }
meter { width: 100%; height: 0.8rem; }
.timeline { list-style: none; padding: 0; margin: 0; }
.timeline li { border-left: 3px solid #0f766e; padding: 0.35rem 0 0.85rem 0.9rem; }
.subnav { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-bottom: 0.5rem; }
:focus-visible { outline: 3px solid #0f766e; outline-offset: 2px; }
.site-footer {
  color: #486581;
  padding: 1.5rem 1.25rem 2rem;
  font-size: 0.9rem;
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
@media (min-width: 721px) {
  #market-filters details:not([open]) > *:not(summary) { display: block; }
}
@media (max-width: 720px) {
  .site-header { align-items: stretch; }
  .account { margin-left: 0; }
  .nav, .steps, .stats, .offer-detail, .market-layout, .search-bar { grid-template-columns: 1fr; flex-direction: column; }
  #market-list, #rate-list, .cards { grid-template-columns: 1fr; }
  dl { grid-template-columns: 1fr; }
}
`;

const stylesheetHash = crypto.createHash("sha256").update(stylesheet).digest("hex");

function stylesheetHref() {
  return `/assets/oceanrelay.css?v=${stylesheetHash}`;
}

module.exports = {
  stylesheet,
  stylesheetHash,
  stylesheetHref,
};
