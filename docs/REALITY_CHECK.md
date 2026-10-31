# Reality check: would an agent actually choose Agentboard?

Written Oct 30, 2026 (PT). We update it whenever a skill is added. The bar is blunt: **would a capable agent that has
web search and fetch check Agentboard first for this task?** If it would not, we do not feature the skill, even when
the skill works.

## Rubric

Each skill is scored 1 (poor) to 3 (strong) on five things:

| | Question |
|---|---|
| **Need** | How often do agents need this task? Think of compliance checks, vetting a counterparty, licensing, procurement. |
| **Pain** | How hard is it from scratch? 3 means postback/viewstate forms, POST-only search, or a multi-step flow with no keyless API. 1 means a public JSON API or a single GET answers it. |
| **Proof** | Is the answer tied to the input? It must come from the URL, the title, or the results row that names the input. A bad input must fail fast with 0 model calls. |
| **Stable** | Does the site stay put? Is it bot-friendly (no captcha or login) and reasonably fast? |
| **ToS** | Is automated reading low risk under the site's terms and robots.txt? 3 means public-records or government data with no ban on automation. |

**Verdicts**

- **Feature:** Pain is 3 and the other scores are at least 2. These come first on the homepage, in `/v1/skills`, and in the empty-query `find_skill`.
- **Keep, de-emphasize:** The skill works and is verified, but a capable agent can usually do the task in one fetch.
- **Easy lookup, don't feature:** A public API answers it in one call. The skill stays only as a demo of the mechanism.
- **Demo:** A page we host ourselves (a mock site).

These verdicts live in code in `packages/api/src/services/reality.ts`. The API returns each one as `reality` on every
listing and `find_skill` result.

## Scorecard

Benchmarks compare two fresh agents on the same input. The cold agent drives the site with Muse Spark computer use; the
reuse agent finds the skill and replays it. Both runs are signed. Times are executor wall-clock.

| Skill | Need | Pain | Proof | Stable | ToS | Cold (calls · $ · s) | Reuse (calls · $ · s) | Verdict | Why |
|---|---|---|---|---|---|---|---|---|---|
| `ofac-sanctions-search` | 3 | 3 | 3 (row names the input) | 3 | 3 | 6 · $0.0289 · 25.8 | 0 · $0 · 6.9 | **Feature** | ASP.NET postback search with viewstate and fuzzy scoring. A fetch-only agent cannot submit it. |
| `florida-license-status` | 3 | 3 | 3 (row's license number) | 3 | 3 | 3 · $0.0136 · 19.7 | 0 · $0 · 4.5 | **Feature** | POST-only license search with no public API. |
| `companies-house-last-accounts` | 2 | 2 | 3 (URL) | 3 | 3 | 6 · $0.0277 · 22.3 | 0 · $0 · 4.5 | Keep, de-emphasize | The API needs a registered key, but the company page is one GET by number. |
| `fmcsa-carrier-authority` | 3 | 2 | 3 (record keyed by USDOT) | 2 (slow at times) | 3 | 6 · $0.0284 · 92.5 | 0 · $0 · 4.7 | Keep, de-emphasize | The QCMobile API needs a webkey, but a direct GET URL exists. It returns **USDOT status**, not operating authority yet (see below). |
| `wikipedia-infobox-fact` | 2 | 1 | 3 | 3 | 3 | 5 · $0.0229 | 0 · $0 | Easy lookup | The Wikipedia API or one page fetch answers it. |
| `x-rates-exchange-rate` | 2 | 1 | 3 (row) | 3 | 2 | n/a | n/a | Easy lookup | Free FX APIs answer it. |
| `pypi-package-version` | 2 | 1 | 3 | 3 | 3 | n/a | n/a | Easy lookup | `pypi.org/pypi/<name>/json` |
| `crates-io-version` | 2 | 1 | 3 | 3 | 3 | n/a | n/a | Easy lookup | The crates.io API answers it. |
| `rubygems-version` | 2 | 1 | 3 | 3 | 3 | 4 · $0.0114 | 0 · $0 | Easy lookup | The RubyGems API answers it. |
| `go-package-version` | 2 | 1 | 3 | 3 | 3 | n/a | n/a | Easy lookup | `proxy.golang.org/<mod>/@latest` |
| `hacker-news-top-story` | 1 | 1 | 2 | 3 | 3 | n/a | n/a | Easy lookup | The HN Firebase API answers it. |
| `hn-search-top-result` | 1 | 1 | 2 | 3 | 3 | n/a | n/a | Easy lookup | The Algolia HN API answers it. |
| `github-repo-stars-release` | 2 | 1 | 3 | 3 | 3 | n/a | n/a | Easy lookup | The GitHub REST API answers it. |
| `create-a-support-ticket`, `helpdesk-ticket-status`, `shop-*` | n/a | n/a | n/a | n/a | n/a | n/a | n/a | Demo | Mock sites we host to show approvals and healing. |

Reuse on a **different input** than the recording (Oct 30, 2026, all with 0 model calls):

| Skill | Input | Result |
|---|---|---|
| Florida | `CGC1520221` | "Current, Active 08/31/2028", bound to the row label, 2.7 s |
| Florida | `CGC9999999` | Not verified in 3.1 s: "no results row for CGC9999999" |
| OFAC | `AEROCARIBBEAN AIRLINES` | "CUBA", 5.5 s |
| OFAC | `ZZQQ NOBODY` | Fail-fast in 4.3 s |
| FMCSA | `53467` | "ACTIVE", 2.9 s |
| FMCSA | `99999999` | Fail-fast in 3.7 s: the site says "Record Not Found" |

Public `try_skill` (no token, proof-of-work challenge, allowlisted), Oct 30, 2026, 9:44 PM PT:

| Skill | Input | Result |
|---|---|---|
| Florida | `EC13008544` | "Null and Void, 08/31/2020", verified, 0 calls, 5.4 s end to end |
| OFAC | `BANCO NACIONAL DE CUBA` | "CUBA", verified, 0 calls, 7.4 s end to end |

Both are on `PUBLIC_REPLAY_SKILLS`, first in the list, so the homepage "Try it now" uses OFAC. FMCSA is not on the list:
SAFER was slow, with one 70 s page load during the cold run.

Executor fixes these builds needed, all now generic:
- **A click followed by typing moves to the nearest text field.** OFAC's Type dropdown sits 25 px above its Name box,
  and the first cold run looped 15 turns ($0.084) on it.
- **A button labeled exactly Search / Find / Look up only queries,** even inside a page-wide ASP.NET POST form.
- **An input echoed back is never learned as the answer.** FMCSA's snapshot repeats the USDOT number.
- **A keyed record page that says "Record Not Found" fails fast with 0 calls.**
- **Gated words are read from the clicked control, not its neighbors.** "Search button … between … and Clear
  button" is not a delete.

## What is still not ready (tell the developer)

- **The savings per call are small in dollars.** A cold run costs $0.014–0.029. The real gains:
  - **Time:** 20–90 s cold vs about 5 s on reuse.
  - **Reliability:** the cold OFAC run looped 15 turns on a dropdown before an executor fix.
  - **A signed, input-tied answer** you can show an auditor.
- **"No match" is reported as "not verified", not as a clean negative.** For sanctions screening, "no SDN hit at score 100"
  is itself the answer an agent wants. Today the agent has to read `fail_fast` to get it. Next step: a first-class
  `no_match` outcome with the site's own words.
- **The OFAC skill reads one field (Program) at the site's default score threshold of 100.** It cannot do fuzzy
  screening at lower scores, return all rows, or check the Address/List columns.
- **The FMCSA skill returns the USDOT status (ACTIVE/INACTIVE), not the operating-authority text.** The drafter wrote
  a vague success check twice, despite the hint. Its slug promises more than it returns.
- **Coverage is thin.** There are two featured skills. An agent will check a registry only once it reliably has the
  long tail: state license boards, court dockets, procurement portals, customs rulings. Each new site costs about
  $0.03–0.12 of Muse to learn plus one human recording.
- **Easy lookups dominate the catalog (9 of 13 real-site skills).** They prove the mechanism, not the value, so they
  are no longer featured.

## Would an agent use Agentboard today?

**For OFAC name screening and Florida license checks: yes.** Those are postback/POST forms with no keyless API, and the
skill answers in about 5 s with 0 model calls, an input-tied value and a signed record. **For everything else in the
catalog: not yet.** A capable agent would call the public API directly.

## Candidates reviewed (Oct 30, 2026)

**Built:**
- OFAC sanctions search
- Florida DBPR license
- FMCSA SAFER

**Reviewed and not built:**
- WA L&I contractor lookup and Texas TDLR license search: both states publish the same license data as keyless
  open-data (Socrata) APIs, on data.wa.gov and data.texas.gov. Easy lookups.
- UK Charity Commission register: its API needs a key, but each charity page is one GET by number. It would rate
  "keep", like Companies House.

**Dropped:**

| Reason | Sites |
|---|---|
| Captcha, bot wall, or timeout | IRS EOS, Sunbiz, FCC ULS, NYSED, CA bizfile, SEC EDGAR full-text, NMLS, OSHA, FAA registry, FCA register, DVSA MOT, CSLB (captcha), FDA 510(k) (timeout) |
| Terms of service | USPS ZIP lookup (bans scraping; robots disallows), USPTO TSDR (risk) |
| Easy keyless API | NPI registry, CPSC recalls, NHTSA vPIC, RDAP |
| Privacy | DVLA vehicle enquiry (vehicle registrations would land in a public log) |
