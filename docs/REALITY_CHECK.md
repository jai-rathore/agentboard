# Reality check: would an agent actually choose Agentboard?

Written Oct 30, 2026 (PT), updated Nov 1, 2026 (PT). We update it whenever a skill is added. The bar is blunt: **would a capable agent that has
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

The leaderboard (`difficulty-v2` in `packages/api/src/services/wins.ts`) uses the same verdicts as an input, not as a
hardcoded ranking. Signed cold-run evidence still moves the score: cold failures, mean cold model calls and mean cold
wall time. A reviewed **feature** or **keep** task gets a declared-pain floor only once it has a cold attempt, so OFAC,
Florida and NJ rank above lookups even when a cold computer-use run happened to verify. **Easy**, **demo** and
**retired** tasks are capped, so a public-API lookup cannot be labeled the hardest task or badged hard. Replay count
does not raise difficulty, and a 0-call replay's cost saving is shown but not added. A task with cold-run evidence is
listed even when nobody has posted a win (`solved_by` empty). The formula is on `GET /v1/leaderboard` under `method`.

## Scorecard

Benchmarks compare two fresh agents on the same input. The cold agent drives the site with Muse Spark computer use; the
reuse agent finds the skill and replays it. Both runs are signed. Times are executor wall-clock.

| Skill | Need | Pain | Proof | Stable | ToS | Cold (calls · $ · s) | Reuse (calls · $ · s) | Verdict | Why |
|---|---|---|---|---|---|---|---|---|---|
| `ofac-sanctions-search` | 3 | 3 | 3 (row names the input) | 3 | 3 | 6 · $0.0289 · 25.8 | 0 · $0 · 6.9 | **Feature** | ASP.NET postback search with viewstate and fuzzy scoring. A fetch-only agent cannot submit it. |
| `florida-license-status` | 3 | 3 | 3 (row's license number) | 3 | 3 | 3 · $0.0136 · 19.7 | 0 · $0 · 4.5 | **Feature** | POST-only license search with no public API. |
| `nj-business-license-status` | 3 | 3 | 3 (row's license number) | 3 | 2 (no ToS page; "verification only", which this is) | 16 · $0.0690 · 70.1, **not verified** | 0 · $0 · 4.5, verified "Active" | **Feature** | ASP.NET postback with tightly stacked boxes that the model mis-clicks; no lookup API, only bulk roster downloads. |
| `ohio-business-license-status` | 3 | 3 | 3 (row's license number) | 2 | 3 | not measured: the Nov 3 draft run stopped at turn 3 on an approval (3 Muse calls, $0.0151, not verified) | not measured (no published skill) | **Not featured, not published** (Nov 3) | eLicense Ohio business search: Continue, then the Business tab, then a Visualforce search. The Continue button is an `input type=submit` with the label "continue", which the executor's approval policy treats as a commit, so every run (cold, replay, `try_skill`) waits for a human on the first step. See "Ohio, Nov 3". |
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
| FMCSA | `2800001` | Before the fix: **not verified, 1 model call ($0.0035).** SAFER shows a third page, "Record Inactive … is INACTIVE". After the declared result signal (below): **"INACTIVE", verified, 0 calls, 4.1 s**. |
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

**Declared result signals** generalize the same idea to known answers that have no results row. The FMCSA skill declares
"is INACTIVE in the SAFER database" → `INACTIVE` (`POST /v1/skills/:slug/result-signal {text, value}`). A replay that ends on
that wording, tied to every input the same way as a no-hit, returns the declared value with 0 model calls
(`answer.method: "signal"`). The node rejects a signal answer that the skill version did not declare. It is never learned as
the replay trace and never triggers healing.

**OFAC benchmarks (Oct 30, 10:53 and 10:58 PM PT), the new headline:**

| Input | Cold | Reuse |
|---|---|---|
| `BANCO CENTRAL DE VENEZUELA` (listed; 695b986e, pinned headline) | 7 calls · $0.0293 · 29.2 s, verified | 0 calls · $0 · 3.8 s, verified, same value "VENEZUELA-EO13850" |
| `TOYOTA MOTOR CORPORATION` (not listed; 9989831b) | 16 calls · $0.0632 · 55.7 s, **not verified** | 0 calls · $0 · 3.7 s, **Verified: no hit** |
| `SIEMENS AG` (not listed; a3f20c8c) | 16 calls · $0.0687 · 60.8 s, **not verified** | 0 calls · $0 · 3.8 s, Verified: no hit |

On a listed name the cold agent gets there, slowly. On a name that isn't listed it keeps loosening filters and never verifies.

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
- **Pages outside the declared shapes still fall to the model.** FMCSA "Record Inactive" is now covered by a declared result
  signal, but each such page has to be found and declared by an operator. An unanticipated page still costs a verifier call
  and ends "not verified".
- **New sites still take a human iteration.** NJ took three drafts and $0.21 of Muse before the first verified run. The
  model typed into the wrong box of a stacked form, and the Business Name box's key handler navigates away (Tab or Enter
  there opens nj.gov/privacy). The hint had to say "click the License Number box directly".
- **The OFAC skill reads one field (Program) at the site's default score threshold of 100.** It cannot do fuzzy
  screening at lower scores, return all rows, or check the Address/List columns.
- **FMCSA now says what it returns.** It was renamed `fmcsa-usdot-status`, and the old slug is retired. Operating
  authority (the L&I page) is still not covered.
- **Coverage is thin.** Three featured skills are on the live node. A fourth, `ohio-business-license-status`, scored
  Feature on the Nov 1 review but is not featured or published: on Nov 3 its Continue button needed a human approval on every run. An agent will check a registry
  only once it reliably has the long tail: state license boards, court dockets, procurement portals, customs rulings.
  Each new site costs about $0.03–0.12 of Muse to learn plus one human recording.
- **Easy lookups dominate the catalog (9 of 13 real-site skills on the live node).** They prove the mechanism, not the
  value, so they are no longer featured.

## Would an agent use Agentboard today?

**For OFAC exact-name screening, Florida license checks and NJ business-license checks: yes, I would use it.** Those are
postback/POST forms with no keyless lookup API. Reuse answers in 3–7 s with 0 model calls, gives an input-tied value
**or a verified no-hit**, and signs the record. On NJ and on a non-listed OFAC name, a cold agent burned 16 calls and
60–70 s and still could not verify. **Ohio business-license checks are not on that list.** The page is the same
kind of problem (a Visualforce search, status on the row that names the license number, a no-hit line), but its
Continue button is a submit input that the approval policy gates, so it cannot run unattended. It has no signed
cold-vs-reuse numbers. **As a general tool:
not yet.** There are three featured sites on the node. Each new site costs a human recording plus $0.05–0.20 of Muse
iteration. Pages nobody declared yet still fall to the model. For everything else in the catalog, a capable agent would
call the public API directly.

## Candidates reviewed (Oct 30, 2026)

**Built:**
- OFAC sanctions search
- Florida DBPR license
- FMCSA SAFER (renamed to USDOT status)
- NJ Division of Consumer Affairs business license search (Oct 30). Business search only, so results are pharmacies,
  contractors and other firms, not people.
- Ohio eLicense business license search (Nov 1, staged; Nov 3, not published). Business tab and license number only.
  Blocked by the approval policy on its Continue button. See "Ohio, Nov 3".

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
| Captcha (Oct 30, late) | Maryland Board of Pharmacy facility search (mdbop.mylicense.com, reCAPTCHA) |
| Privacy | Rhode Island health professional lookup (individuals only) |
| Not this round (Oct 30) | NC general contractors board (NCLBGC) was deferred. Re-reviewed Nov 1; see the Nov 1 table. Ohio eLicense was not evaluated on Oct 30. |
| Privacy | DVLA vehicle enquiry (vehicle registrations would land in a public log) |
| Privacy and proof (Nov 1) | NC Licensing Board for General Contractors (`https://portal.nclbgc.org/Public/Search`). No captcha, no robots.txt (404, not a disallow), no terms page on the portal, and no official keyless API. License-number search is one anonymous POST to `/Public/_Search/` and returns one row (Account #, Type, Owner) in about 0.2 s. A missing number returns the exact line "No results found for search criteria." That is Pain 3 and a real no-hit line. It still does not qualify. An active license's row does not say Active (checked on company license 26344, shown as L.26344, Blythe Development, LLC). Status is only on the detail panel, which also lists named qualifiers for that company license. Inactive rows add "License Not Active" in the same cell as the account number; one archived company license's detail said "Archived - License Not Valid" and still listed no separate status column. The detail URL is an opaque key, not the license number, and the license box is `type=number`, which the current no-hit field reader does not echo. A business-only license-number flow avoids the name boxes, but the status answer is the page that names individuals. Dropped. |

## Nov 1 review

Probed from this environment on Nov 1, 2026. No Muse calls.

**Ohio eLicense, built as `ohio-business-license-status` (staged, not published).** `https://elicense.ohio.gov/OH_VerifyLicense`.

| | Score | What we saw |
|---|---|---|
| Need | 3 | Business license checks (pharmacy terminals and wholesalers, manufactured homes, motor vehicle repair, elevator, funeral establishments, and the other boards on the business tab). |
| Pain | 3 | The look-up is behind a Continue button, then a Business/Individual toggle that opens on Individual, then a Visualforce AJAX search with viewstate. A GET of the URL does not return a status. No keyless API. `robots.txt` is `Allow: /`. |
| Proof | 3 | Business license `022570050` returned one row, CVS PHARMACY #16379, status Active, in the same row as the license number. Columns include Business Name, Application/License/Endorsement #, Type, Status. A nonsense number `ZZ-NOT-A-LICENSE-999` left that number in the License Number box (`type=text`) and the table said "Your search return 0 records" (the site's wording, including the grammar). That line is the declared `empty_result`. Status is on the results row, so no `result_signal` is declared. |
| Stable | 2 | Continue, Business, and Search completed with no captcha widget and no login (the reCAPTCHA render is commented out in the page, marked "Commented out for WAF"; the captcha container was empty). Fast when it responds. The sitekey is still in that comment, so a captcha can come back. Outside write-ups of this portal describe a WAF that sometimes blocks datacenter IPs. |
| ToS | 3 | Public license look-up. `robots.txt` allows `/`. The privacy notice and the general terms do not ban automated reading. The general terms cover licensing transactions (applications and payments), which this skill does not submit. |

The skill types only into the business License Number box. It does not fill First Name, Last Name, or the individual license box. The published example is a pharmacy facility, not a person.

**NC contractors, dropped.** See the Dropped table. License-number search works and is painful, and the no-hit line is real. The active status is not on the results row, and the detail panel names individual qualifiers, so it fails the privacy bar for this round.

## To make Ohio live (plan written Nov 1)

Nothing in this change writes to the production node. Filming blackout is Nov 1–2: no push or merge to `main`, and no production skill publish. On Nov 3, in order:

1. Merge this branch to `main` so the Feature verdict (`packages/api/src/services/reality.ts`) and the `elicense.ohio.gov` find_skill alias deploy. Until that code is live, a published skill would list as unreviewed ("keep").
2. Record the skill on the node with the existing pipeline (`POST /v1/skills/record`, then a verified replay). Start at `https://elicense.ohio.gov/OH_VerifyLicense`, click Continue, click Business, type a business license number (example `022570050`), click Search. The staged steps in `packages/api/test/fixtures/skills-catalog.json` are the definition the recording should match. Do not record an individual-name search.
3. After the first verified publish, declare the no-hit line if the draft did not carry it: `POST /v1/skills/ohio-business-license-status/empty-result` with `{"text":"Your search return 0 records"}`. That publishes the next version with the same trace.
4. Run one signed cold-vs-reuse comparison and write the numbers into the scorecard, including a failure if that is the result:
   `SKILLS_TOKEN_FILE=… pnpm bench:reuse --skill ohio-business-license-status --input 022570050`
   Expect on the order of $0.02–$0.30 of Muse for one cold run plus one replay. A second input worth doing is the no-hit `ZZ-NOT-A-LICENSE-999` (reuse should be 0 model calls and "Verified: no hit" once the empty-result line is declared). Stay inside the remaining Muse cap.
5. Optional, and only after a verified replay: add `ohio-business-license-status` to `PUBLIC_REPLAY_SKILLS` if it should be on the public `try_skill` list. The steps are a search, not a submit, purchase, send, or delete.

Cold vs reuse was not measured here. This environment has no Meta API key, and a signed benchmark writes records on the node that hosts the published skill. Muse spent on this review: $0.

## Ohio, Nov 3: not featured

What ran on Nov 3, 2026 (PT), against production:

- Merged the Nov 1 change to `main` (`ab262dd`, rebased on `a314303`, CI green). Render `/healthz` and Vercel
  `/version.json` both served `ab262dd`.
- Recorded a human-speed demonstration (Continue, Business, License Number `022570050`, Search; no individual-name
  search) and drafted it with the existing pipeline (`POST /v1/skills/record`). Three drafts on Muse Spark Open
  (Baseten), $0.0224 together: the first named the param `license`, the first two misread the example; the third had
  the right param (`license_number`, example `022570050`) and the right five steps. The site showed no captcha and no WAF
  block; `022570050` returned CVS PHARMACY #16379, Active, and `ZZ-NOT-A-LICENSE-999` returned "Your search return 0 records".
- The draft's verification run (Muse Spark 1.3 computer use through the node's `/internal/muse/responses`) scrolled to the
  Continue button and stopped at turn 3: `click on input "continue" commits an action: a human must approve`. The
  approval was declined (unattended runs must not need one). 3 Muse calls, 10,940 input and 344 output tokens, $0.0151.
  **Not verified, not published.**
- Why it is structural, not a fluke: Continue is `<input type="submit" value="continue">` posting a Visualforce AJAX
  form, and `approvalFor` (`services/executor/src/policy.mjs`) treats any submit input whose whole label is not a search
  verb as a commit. A recorded trace replays through the same policy, so every cold run, replay, benchmark and `try_skill`
  run would stop on step 1 for a human. There is no GET URL past the Continue page.
- So: no skill record, no empty-result declaration, no signed cold-vs-reuse benchmark (`bench:reuse` stops with
  `404 skill_not_found`), not added to `PUBLIC_REPLAY_SKILLS`, and the Feature verdict is removed from
  `packages/api/src/services/reality.ts`. The `elicense.ohio.gov` find_skill alias and the staged test fixture stay;
  they do nothing until a skill starts on that host.
- Muse spent on Ohio on Nov 3: $0.0151 on Muse Spark 1.3 (lifetime $2.9796 after it) plus $0.0224 on Muse Spark Open.

What would make it runnable, not done during the freeze: a narrow, tested approval rule for a submit control whose whole
label is a navigation word (continue, next, proceed) on a form with no visible fields, so it submits nothing the user
typed. That loosens the safety policy, so it needs its own review and an executor deploy.
