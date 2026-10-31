# Reality check: would an agent actually choose Agentboard?

Written Oct 30, 2026 (PT), updated Oct 30, 2026, 11 PM PT. We update it whenever a skill is added. The bar is blunt: **would a capable agent that has
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
| `nj-business-license-status` | 3 | 3 | 3 (row's license number) | 3 | 2 (no ToS page; "verification only", which this is) | 16 · $0.0690 · 70.1, **not verified** | 0 · $0 · 4.5, verified "Active" | **Feature** | ASP.NET postback with tightly stacked boxes that the model mis-clicks; no lookup API, only bulk roster downloads. |
| `companies-house-last-accounts` | 2 | 2 | 3 (URL) | 3 | 3 | 6 · $0.0277 · 22.3 | 0 · $0 · 4.5 | Keep, de-emphasize | The API needs a registered key, but the company page is one GET by number. |
| `fmcsa-usdot-status` | 3 | 2 | 3 (record keyed by USDOT) | 2 (slow at times) | 3 | 4 · $0.0125 · 14.4 | 0 · $0 · 4.5 | Keep, de-emphasize | Renamed from `fmcsa-carrier-authority`, which only ever returned USDOT status. The QCMobile API needs a webkey, but a direct GET URL exists. |
| `fmcsa-carrier-authority` | n/a | n/a | n/a | n/a | n/a | n/a | n/a | Retired | Its name promised operating authority; it returned USDOT status. Hidden from listings and `find_skill`; its signed history stays readable. |
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

Oct 30, 2026, 10:15–10:30 PM PT, all with 0 model calls:

| Skill | Input | Result |
|---|---|---|
| OFAC | `TOYOTA MOTOR CORPORATION` | **Verified: no hit**, 5.8 s. The name is echoed in the search field. |
| OFAC | `MICROSOFT CORPORATION` | **Verified: no hit**, 6.3 s |
| OFAC | `BANCO NACIONAL DE CUBA` | "CUBA", 4.5 s. Listed names still return their value after the signal was declared. |
| Florida | `CBC0000001` | **Verified: no hit**, 3.5 s. The license number was sent in the search request. |
| Florida, public `try_skill` | `CGC9999999` | **Verified: no hit**, 4.4 s end to end, no token |
| FMCSA (`fmcsa-usdot-status`) | `53467`, `2800000` | "ACTIVE", 2.8 s and 2.7 s |
| FMCSA | `99999999` | **Verified: no hit** ("Record Not Found"), 2.5 s |
| FMCSA | `2800001` | **Not verified, 1 model call ($0.0035).** SAFER shows a third page, "Record Inactive … is INACTIVE". It is neither the snapshot nor the declared no-results wording, so it falls to the model verifier. Known gap. |
| NJ | `28RS00427100`, `D05066900` | "Active", 2.9 s each (the first run was on `28RS00480600`, "Closed") |
| NJ | `28RS99999999` | Not verified in 2.9 s: no results row. NJ shows an empty grid with no wording, so it gets no verified no-hit. |

Public `try_skill` (no token, proof-of-work challenge, allowlisted), Oct 30, 2026, 9:44 PM PT:

| Skill | Input | Result |
|---|---|---|
| Florida | `EC13008544` | "Null and Void, 08/31/2020", verified, 0 calls, 5.4 s end to end |
| OFAC | `BANCO NACIONAL DE CUBA` | "CUBA", verified, 0 calls, 7.4 s end to end |

Both are on `PUBLIC_REPLAY_SKILLS`, first in the list, so the homepage "Try it now" uses OFAC. Since Oct 30, 10:45 PM PT,
`nj-business-license-status` is third on the list. Its live public run was not exercised that night because the
box's network had used its 3 public replays for the day, so it served the cached signed run as designed. FMCSA is not on the list:
SAFER was slow, with one 70 s page load during the cold run.

## Verified negative: "no hit" is an answer

A skill can now declare its site's own no-results wording (`skill.empty_result`). The operator declares it with `POST
/v1/skills/:slug/empty-result`, which publishes the next version with the same trace. When a deterministic replay
ends on that wording, the executor must tie every input to it. It checks, in order: the page URL, the search field that
echoes the input, the search request that loaded the page (POST body or URL), or, for inputs of 4+ characters, the page
text. If all inputs are tied, the run is signed with `outcome: "no_match"`, shown as **Verified: no hit**. It is never
"not verified", never becomes the replay trace, and never triggers healing. Without a declared signal, or when an input
cannot be tied, it stays "not verified". The trust card counts verified no-hits separately and shows the latest one.

Declared: OFAC "Your search has not returned any results", Florida "There were no records found matching the search
criteria", FMCSA "Record Not Found". NJ has no wording to declare.

Benchmark on a real non-listed name, `SIEMENS AG` on OFAC: the cold agent took 16 calls, $0.0687 and 61.6 s and ended
**not verified**. It kept fiddling with the Program filter and the score slider because "the strict search came up
empty". The reuse agent took 0 calls and 7.0 s and got **Verified: no hit**. For screening, that negative is the whole
point, and a cold agent cannot produce it with confidence.

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
- **A verified no-hit is only as strong as the site's search.** OFAC's no-hit is at the default score of 100, an exact
  name match. "Verified: no hit" for `TOYOTA MOTOR CORP` does not mean no fuzzy match at score 85. The trust card says
  what was searched, not what a compliance officer would call cleared.
- **Third pages fall to the model.** FMCSA's "Record Inactive" page is neither the snapshot nor "Record Not Found".
  Today it costs 1 model call and ends "not verified", where it should return "INACTIVE".
- **New sites still take a human iteration.** NJ took three drafts and $0.21 of Muse before the first verified run. The
  model typed into the wrong box of a stacked form, and the Business Name box's key handler navigates away (Tab or Enter
  there opens nj.gov/privacy). The hint had to say "click the License Number box directly".
- **The OFAC skill reads one field (Program) at the site's default score threshold of 100.** It cannot do fuzzy
  screening at lower scores, return all rows, or check the Address/List columns.
- **FMCSA now says what it returns.** It was renamed `fmcsa-usdot-status`, and the old slug is retired. Operating
  authority (the L&I page) is still not covered.
- **Coverage is thin.** There are three featured skills. An agent will check a registry only once it reliably has the
  long tail: state license boards, court dockets, procurement portals, customs rulings. Each new site costs about
  $0.03–0.12 of Muse to learn plus one human recording.
- **Easy lookups dominate the catalog (9 of 13 real-site skills).** They prove the mechanism, not the value, so they
  are no longer featured.

## Would an agent use Agentboard today?

**For OFAC exact-name screening, Florida license checks and NJ business-license checks: yes, I would use it.** Those are
postback/POST forms with no keyless lookup API. Reuse answers in 3–7 s with 0 model calls, gives an input-tied value
**or a verified no-hit**, and signs the record. On NJ and on a non-listed OFAC name, a cold agent burned 16 calls and
60–70 s and still could not verify. **As a general tool: not yet.** There are three featured sites. Each new site costs a
human recording plus $0.05–0.20 of Muse iteration. Outcomes outside the declared shapes, like FMCSA "Record Inactive",
still fall to the model. For everything else in the catalog, a capable agent would call the public API directly.

## Candidates reviewed (Oct 30, 2026)

**Built:**
- OFAC sanctions search
- Florida DBPR license
- FMCSA SAFER (renamed to USDOT status)
- NJ Division of Consumer Affairs business license search (Oct 30). Business search only, so results are pharmacies,
  contractors and other firms, not people.

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
| Captcha (Oct 30 round) | trade.gov Consolidated Screening List, CBP CROSS rulings, CA DCA license search (Turnstile), VA DPOR (reCAPTCHA) |
| Bot wall | GA SOS, WA CCFS (Cloudflare) |
| robots.txt `Disallow: /` | Texas courts case search (search.txcourts.gov), Texas ESBD procurement (txsmartbuy.gov) |
| Unreachable | CA eProcure (403), UK OFSI search (closed) |
| Answer not input-tied | UK sanctions list search: it ORs the words, giving 142 results for "TOYOTA MOTOR CORPORATION" |
| Not this round | NC general contractors board (NCLBGC): no captcha and an explicit no-results line. But an active license's status is only on a detail page, and the results list sole proprietors by name. It is also one anonymous POST. Ohio eLicense (Salesforce) was not evaluated. |
| Privacy | DVLA vehicle enquiry (vehicle registrations would land in a public log) |
